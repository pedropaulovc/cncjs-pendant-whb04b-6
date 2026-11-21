using System.Diagnostics;
using System.Net.WebSockets;
using Microsoft.Extensions.Logging;

namespace Whb04bSidecar.Server;

/// <summary>
/// Handles requests from origins outside the allow-list: closes rejected WebSocket upgrades with 4403 and logs a
/// warning at most once per origin per minute, since a widget retrying with backoff would otherwise flood the log.
/// </summary>
internal sealed class OriginRejections(ILogger logger)
{
    public static readonly TimeSpan WarnInterval = TimeSpan.FromMinutes(1);
    private static readonly TimeSpan CloseHandshakeTimeout = TimeSpan.FromSeconds(3);
    private const int MaxTrackedOrigins = 256;

    private readonly Dictionary<string, OriginLog> _origins = new(StringComparer.Ordinal);

    public void Log(string origin, string request)
    {
        var now = Stopwatch.GetTimestamp();
        int suppressed;
        lock (_origins)
        {
            if (_origins.TryGetValue(origin, out var entry) && Stopwatch.GetElapsedTime(entry.LastWarned, now) < WarnInterval)
            {
                _origins[origin] = entry with { Suppressed = entry.Suppressed + 1 };
                logger.LogDebug("Rejected {Request} from origin {Origin} (warning suppressed)", request, origin);
                return;
            }

            suppressed = entry.Suppressed;
            PruneExpired(now);
            _origins[origin] = new OriginLog(now, 0);
        }

        logger.LogWarning(
            "Rejected {Request} from origin {Origin}: not allowed; add it with --allow-origin or allowedOrigins in settings.json ({Suppressed} repeats since the last warning)",
            request,
            origin,
            suppressed);
    }

    /// <summary>Closes an accepted WebSocket with 4403 (nothing else is sent) and waits briefly for the client's close frame.</summary>
    public static async Task CloseWebSocketAsync(WebSocket socket, string origin, CancellationToken cancellationToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(CloseHandshakeTimeout);
        var buffer = new byte[256];
        try
        {
            await socket.CloseOutputAsync(Protocol.OriginRejectedCloseStatus, Protocol.CloseReason($"origin not allowed: {origin}"), timeout.Token);
            while (socket.State == WebSocketState.CloseSent)
            {
                await socket.ReceiveAsync(buffer.AsMemory(), timeout.Token);
            }
        }
        catch (Exception ex) when (ex is WebSocketException or OperationCanceledException)
        {
            // The client vanished or ignored the close; the socket is torn down when the request ends.
        }
    }

    private void PruneExpired(long now)
    {
        if (_origins.Count < MaxTrackedOrigins)
        {
            return;
        }

        foreach (var (origin, entry) in _origins.ToList())
        {
            if (Stopwatch.GetElapsedTime(entry.LastWarned, now) >= WarnInterval)
            {
                _origins.Remove(origin);
            }
        }
    }

    private readonly record struct OriginLog(long LastWarned, int Suppressed);
}
