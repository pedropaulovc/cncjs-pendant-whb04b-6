using System.Diagnostics;
using System.Net.WebSockets;
using Microsoft.Extensions.Logging;

namespace Whb04bSidecar.Server;

internal enum ConnectionState
{
    Open,
    Closing,
}

internal enum EnqueueResult
{
    Queued,
    QueuedDroppedOldest,
    DroppedClosing,
}

/// <summary>
/// One WebSocket client. All sends go through a single-reader outbox so the HID thread, the receive loop
/// and ownership changes never write to the socket concurrently. Queued input is bounded: when a slow client has
/// <see cref="MaxPendingInputs"/> inputs waiting, the oldest is dropped so the newest (current dial/axis) still goes
/// out. Control messages are never dropped, and the remaining messages keep their order.
/// </summary>
internal sealed class ClientConnection : IDisposable
{
    public const int MaxPendingInputs = 64;

    /// <summary>How long a client gets to answer our close frame before the socket is aborted.</summary>
    private static readonly TimeSpan CloseHandshakeTimeout = TimeSpan.FromSeconds(3);

    private readonly CancellationTokenSource _receiveCts;
    private readonly ILogger _logger;
    private readonly object _lock = new();

    // The outbox: every queued message in send order, plus the input nodes among them (oldest first) so the
    // oldest input can be removed in O(1). The semaphore counts queued messages for the send loop.
    private readonly LinkedList<Outgoing> _queue = new();
    private readonly Queue<LinkedListNode<Outgoing>> _queuedInputs = new();
    private readonly SemaphoreSlim _queued = new(0);
    private OutboxState _outboxState = OutboxState.Accepting;
    private ConnectionState _state = ConnectionState.Open;
    private InputFlow _inputFlow = InputFlow.Flowing;
    private long _droppedInBurst;

    public ClientConnection(long id, WebSocket socket, string origin, string remote, ILogger logger, CancellationToken requestAborted)
    {
        Id = id;
        Socket = socket;
        Origin = origin;
        Remote = remote;
        _logger = logger;
        _receiveCts = CancellationTokenSource.CreateLinkedTokenSource(requestAborted);
    }

    private enum OutboxState
    {
        Accepting,
        Completed,
    }

    private enum InputFlow
    {
        Flowing,
        Dropping,
    }

    private enum OutgoingKind
    {
        Control,
        Input,
        Close,
    }

    public long Id { get; }

    public WebSocket Socket { get; }

    /// <summary>Origin header, or "none" for non-browser clients.</summary>
    public string Origin { get; }

    public string Remote { get; }

    public Stopwatch Uptime { get; } = Stopwatch.StartNew();

    /// <summary>Cancelled when the close handshake times out or the send side fails; aborts the pending receive.</summary>
    public CancellationToken ReceiveToken => _receiveCts.Token;

    public ConnectionState State
    {
        get
        {
            lock (_lock)
            {
                return _state;
            }
        }
    }

    public int PendingInputs
    {
        get
        {
            lock (_lock)
            {
                return _queuedInputs.Count;
            }
        }
    }

    public WebSocketCloseStatus? CloseStatusSent { get; private set; }

    public string? CloseReasonSent { get; private set; }

    /// <summary>Inputs accepted into the outbox (including ones later dropped as oldest).</summary>
    public long InputsQueued;

    public long InputsDropped;

    public long FramesAcked;

    public long FramesFailed;

    /// <summary>Queues a control message (hello, device, display:*, superseded). Dropped only once the outbox is completed.</summary>
    public void Send(byte[] utf8Json)
    {
        lock (_lock)
        {
            if (_outboxState == OutboxState.Completed)
            {
                return;
            }

            _queue.AddLast(new Outgoing(OutgoingKind.Control, utf8Json, null, null));
            _queued.Release();
        }
    }

    /// <summary>Queues an input message; with <see cref="MaxPendingInputs"/> already waiting, the oldest one is dropped.</summary>
    public EnqueueResult SendInput(byte[] utf8Json)
    {
        lock (_lock)
        {
            if (_state == ConnectionState.Closing || _outboxState == OutboxState.Completed)
            {
                return EnqueueResult.DroppedClosing;
            }

            if (_queuedInputs.Count < MaxPendingInputs && _inputFlow == InputFlow.Dropping)
            {
                _inputFlow = InputFlow.Flowing;
                _logger.LogWarning("Client #{Client} ({Origin}) caught up; {Dropped} old input messages were dropped", Id, Origin, _droppedInBurst);
                _droppedInBurst = 0;
            }

            InputsQueued++;
            var node = _queue.AddLast(new Outgoing(OutgoingKind.Input, utf8Json, null, null));
            _queuedInputs.Enqueue(node);
            if (_queuedInputs.Count <= MaxPendingInputs)
            {
                _queued.Release();
                return EnqueueResult.Queued;
            }

            // One in, one out: the queued-message count is unchanged, so the semaphore is not released.
            _queue.Remove(_queuedInputs.Dequeue());
            InputsDropped++;
            _droppedInBurst++;
            if (_inputFlow == InputFlow.Flowing)
            {
                _inputFlow = InputFlow.Dropping;
                _logger.LogWarning(
                    "Client #{Client} ({Origin}) has {Pending} input messages queued; dropping the oldest until it catches up",
                    Id,
                    Origin,
                    MaxPendingInputs);
            }

            return EnqueueResult.QueuedDroppedOldest;
        }
    }

    /// <summary>Queues a close frame after everything already queued; later sends are dropped. Idempotent.</summary>
    public void Close(WebSocketCloseStatus status, string reason)
    {
        lock (_lock)
        {
            if (_state == ConnectionState.Closing)
            {
                return;
            }

            _state = ConnectionState.Closing;
            if (_outboxState == OutboxState.Completed)
            {
                return;
            }

            _queue.AddLast(new Outgoing(OutgoingKind.Close, null, status, Protocol.CloseReason(reason)));
            _outboxState = OutboxState.Completed;
            _queued.Release();
        }
    }

    /// <summary>The receive side is done; flush what is queued and stop.</summary>
    public void Complete()
    {
        lock (_lock)
        {
            if (_outboxState == OutboxState.Completed)
            {
                return;
            }

            _outboxState = OutboxState.Completed;
            _queued.Release();
        }
    }

    public async Task RunSendLoopAsync()
    {
        try
        {
            while (true)
            {
                await _queued.WaitAsync().ConfigureAwait(false);
                var (item, outbox) = TakeNext();
                if (item is null && outbox == OutboxState.Completed)
                {
                    return;
                }

                if (item is null)
                {
                    continue;
                }

                if (item.Value.Kind == OutgoingKind.Close)
                {
                    await SendCloseAsync(item.Value.Status!.Value, item.Value.Reason!).ConfigureAwait(false);
                    return;
                }

                await Socket.SendAsync(item.Value.Text!, WebSocketMessageType.Text, endOfMessage: true, CancellationToken.None).ConfigureAwait(false);
            }
        }
        catch (Exception ex) when (ex is WebSocketException or OperationCanceledException or ObjectDisposedException or IOException)
        {
            _logger.LogDebug("Client #{Client} send failed: {Error}", Id, ex.Message);
            _receiveCts.Cancel();
        }
    }

    public void Dispose()
    {
        _receiveCts.Dispose();
        _queued.Dispose();
    }

    /// <summary>Removes the next message to send (null when the queue is empty), with the outbox state at that moment.</summary>
    private (Outgoing? Item, OutboxState Outbox) TakeNext()
    {
        lock (_lock)
        {
            if (_queue.First is not { } node)
            {
                return (null, _outboxState);
            }

            _queue.RemoveFirst();
            if (node.Value.Kind == OutgoingKind.Input)
            {
                // Messages leave in order, so the head input is also the oldest queued input.
                _queuedInputs.Dequeue();
            }

            return (node.Value, _outboxState);
        }
    }

    private async Task SendCloseAsync(WebSocketCloseStatus status, string reason)
    {
        CloseStatusSent = status;
        CloseReasonSent = reason;
        if (Socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
        {
            await Socket.CloseOutputAsync(status, reason, CancellationToken.None).ConfigureAwait(false);
        }

        _receiveCts.CancelAfter(CloseHandshakeTimeout);
    }

    private readonly record struct Outgoing(OutgoingKind Kind, byte[]? Text, WebSocketCloseStatus? Status, string? Reason);
}
