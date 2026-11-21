using System.Diagnostics;
using System.Net.WebSockets;
using System.Text;
using System.Threading.Channels;
using Microsoft.Extensions.Logging;

namespace Whb04bSidecar.Server;

/// <summary>
/// One WebSocket client. All sends go through a single-reader outbox so the HID thread, the receive loop
/// and ownership changes never write to the socket concurrently.
/// </summary>
internal sealed class ClientConnection : IDisposable
{
    /// <summary>How long a client gets to answer our close frame before the socket is aborted.</summary>
    private static readonly TimeSpan CloseHandshakeTimeout = TimeSpan.FromSeconds(3);

    private readonly Channel<Outgoing> _outbox = Channel.CreateUnbounded<Outgoing>(new UnboundedChannelOptions { SingleReader = true });
    private readonly CancellationTokenSource _receiveCts;
    private readonly ILogger _logger;
    private int _closing;

    public ClientConnection(long id, WebSocket socket, string origin, string remote, ILogger logger, CancellationToken requestAborted)
    {
        Id = id;
        Socket = socket;
        Origin = origin;
        Remote = remote;
        _logger = logger;
        _receiveCts = CancellationTokenSource.CreateLinkedTokenSource(requestAborted);
    }

    public long Id { get; }

    public WebSocket Socket { get; }

    /// <summary>Origin header, or "none" for non-browser clients.</summary>
    public string Origin { get; }

    public string Remote { get; }

    public Stopwatch Uptime { get; } = Stopwatch.StartNew();

    /// <summary>Cancelled when the close handshake times out or the send side fails; aborts the pending receive.</summary>
    public CancellationToken ReceiveToken => _receiveCts.Token;

    public bool IsClosing => Volatile.Read(ref _closing) == 1;

    public WebSocketCloseStatus? CloseStatusSent { get; private set; }

    public string? CloseReasonSent { get; private set; }

    public long InputsSent;

    public long FramesAcked;

    public long FramesFailed;

    /// <summary>Queues a UTF-8 JSON text frame. Silently dropped once the connection is closing.</summary>
    public void Send(byte[] utf8Json) => _outbox.Writer.TryWrite(new Outgoing(utf8Json, null, null));

    /// <summary>Queues a close frame after everything already queued; later sends are dropped. Idempotent.</summary>
    public void Close(WebSocketCloseStatus status, string reason)
    {
        if (Interlocked.Exchange(ref _closing, 1) == 1)
        {
            return;
        }

        _outbox.Writer.TryWrite(new Outgoing(null, status, TruncateReason(reason)));
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
                if (item.Text is not null)
                {
                    await Socket.SendAsync(item.Text, WebSocketMessageType.Text, endOfMessage: true, CancellationToken.None).ConfigureAwait(false);
                    continue;
                }

                CloseStatusSent = item.Status;
                CloseReasonSent = item.Reason;
                if (Socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
                {
                    await Socket.CloseOutputAsync(item.Status!.Value, item.Reason, CancellationToken.None).ConfigureAwait(false);
                }

                _receiveCts.CancelAfter(CloseHandshakeTimeout);
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

    /// <summary>WebSocket close reasons are limited to 123 UTF-8 bytes.</summary>
    private static string TruncateReason(string reason)
    {
        if (Encoding.UTF8.GetByteCount(reason) <= 123)
        {
            return reason;
        }

        var end = Math.Min(reason.Length, 123);
        while (Encoding.UTF8.GetByteCount(reason.AsSpan(0, end)) > 123)
        {
            end--;
        }

        return reason[..end];
    }

    private readonly record struct Outgoing(byte[]? Text, WebSocketCloseStatus? Status, string? Reason);
}
