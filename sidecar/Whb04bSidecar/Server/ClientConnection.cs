using System.Diagnostics;
using System.Net.WebSockets;
using System.Threading.Channels;
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
    DroppedOutboxFull,
    DroppedClosing,
}

/// <summary>
/// One WebSocket client. All sends go through a single-reader outbox so the HID thread, the receive loop
/// and ownership changes never write to the socket concurrently. Input messages are bounded so a slow client
/// gets fresh reports instead of a growing backlog; control messages are never dropped.
/// </summary>
internal sealed class ClientConnection : IDisposable
{
    /// <summary>More input messages than this waiting in the outbox → further input is dropped until it drains.</summary>
    public const int MaxPendingInputs = 64;

    /// <summary>How long a client gets to answer our close frame before the socket is aborted.</summary>
    private static readonly TimeSpan CloseHandshakeTimeout = TimeSpan.FromSeconds(3);

    private readonly Channel<Outgoing> _outbox = Channel.CreateUnbounded<Outgoing>(new UnboundedChannelOptions { SingleReader = true });
    private readonly CancellationTokenSource _receiveCts;
    private readonly ILogger _logger;
    private readonly object _lock = new();
    private ConnectionState _state = ConnectionState.Open;
    private InputFlow _inputFlow = InputFlow.Flowing;
    private int _pendingInputs;
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
                return _pendingInputs;
            }
        }
    }

    public WebSocketCloseStatus? CloseStatusSent { get; private set; }

    public string? CloseReasonSent { get; private set; }

    public long InputsSent;

    public long InputsDropped;

    public long FramesAcked;

    public long FramesFailed;

    /// <summary>Queues a control message (hello, device, display:*, superseded). Dropped only once the connection is closing.</summary>
    public void Send(byte[] utf8Json) => _outbox.Writer.TryWrite(new Outgoing(OutgoingKind.Control, utf8Json, null, null));

    /// <summary>Queues an input message unless <see cref="MaxPendingInputs"/> are already waiting.</summary>
    public EnqueueResult SendInput(byte[] utf8Json)
    {
        lock (_lock)
        {
            if (_state == ConnectionState.Closing)
            {
                return EnqueueResult.DroppedClosing;
            }

            if (_pendingInputs >= MaxPendingInputs)
            {
                InputsDropped++;
                _droppedInBurst++;
                if (_inputFlow == InputFlow.Flowing)
                {
                    _inputFlow = InputFlow.Dropping;
                    _logger.LogWarning(
                        "Client #{Client} ({Origin}) has {Pending} input messages queued; dropping input until it catches up",
                        Id,
                        Origin,
                        _pendingInputs);
                }

                return EnqueueResult.DroppedOutboxFull;
            }

            if (_inputFlow == InputFlow.Dropping)
            {
                _inputFlow = InputFlow.Flowing;
                _logger.LogWarning("Client #{Client} ({Origin}) caught up; {Dropped} input messages were dropped", Id, Origin, _droppedInBurst);
                _droppedInBurst = 0;
            }

            // Written under the lock so Close() cannot complete the outbox between the check and the write.
            _pendingInputs++;
            InputsSent++;
            _outbox.Writer.TryWrite(new Outgoing(OutgoingKind.Input, utf8Json, null, null));
            return EnqueueResult.Queued;
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
        }

        _outbox.Writer.TryWrite(new Outgoing(OutgoingKind.Close, null, status, Protocol.CloseReason(reason)));
        _outbox.Writer.TryComplete();
    }

    /// <summary>The receive side is done; flush what is queued and stop.</summary>
    public void Complete() => _outbox.Writer.TryComplete();

    public async Task RunSendLoopAsync()
    {
        try
        {
            await foreach (var item in _outbox.Reader.ReadAllAsync().ConfigureAwait(false))
            {
                switch (item.Kind)
                {
                    case OutgoingKind.Input:
                        lock (_lock)
                        {
                            _pendingInputs--;
                        }

                        await Socket.SendAsync(item.Text!, WebSocketMessageType.Text, endOfMessage: true, CancellationToken.None).ConfigureAwait(false);
                        continue;
                    case OutgoingKind.Control:
                        await Socket.SendAsync(item.Text!, WebSocketMessageType.Text, endOfMessage: true, CancellationToken.None).ConfigureAwait(false);
                        continue;
                }

                await SendCloseAsync(item.Status!.Value, item.Reason!).ConfigureAwait(false);
                return;
            }
        }
        catch (Exception ex) when (ex is WebSocketException or OperationCanceledException or ObjectDisposedException or IOException)
        {
            _logger.LogDebug("Client #{Client} send failed: {Error}", Id, ex.Message);
            _receiveCts.Cancel();
        }
    }

    public void Dispose() => _receiveCts.Dispose();

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
