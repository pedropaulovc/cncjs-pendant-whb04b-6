using Timer = System.Threading.Timer;
using System.Buffers;
using System.Diagnostics;
using System.Net.WebSockets;
using Microsoft.Extensions.Logging;
using Whb04bSidecar.Devices;

namespace Whb04bSidecar.Server;

/// <summary>Snapshot for /health and the tray.</summary>
internal readonly record struct HubStatus(DeviceState Device, int Clients, string? OwnerOrigin);

/// <summary>
/// Connects the device to WebSocket clients: newest connection owns the pendant, input reports go to the
/// owner, display frames are written in arrival order and acknowledged.
/// </summary>
internal sealed class PendantHub : IDisposable
{
    private const int MaxMessageBytes = 16 * 1024;
    private static readonly TimeSpan ActivityLogInterval = TimeSpan.FromMinutes(1);

    private readonly IPendantDevice _device;
    private readonly string _version;
    private readonly ILogger<PendantHub> _logger;
    private readonly object _sync = new();
    private readonly List<ClientConnection> _clients = [];
    private readonly Timer _activityTimer;
    private ClientConnection? _owner;
    private long _nextClientId;
    private HubState _state = HubState.Running;

    // Activity window, logged once a minute when non-empty.
    private long _inputsRelayed;
    private long _inputsDropped;
    private long _inputsWithoutOwner;
    private long _framesOk;
    private long _framesFailed;
    private long _frameMsTotal;
    private long _frameMsMax;

    public PendantHub(IPendantDevice device, string version, ILogger<PendantHub> logger)
    {
        _device = device;
        _version = version;
        _logger = logger;
        _device.StateChanged += OnDeviceStateChanged;
        _device.InputReport += OnInputReport;
        _activityTimer = new Timer(_ => LogActivity(), null, ActivityLogInterval, ActivityLogInterval);
    }

    private enum HubState
    {
        Running,
        Stopping,
    }

    private enum Registration
    {
        Owner,
        Refused,
    }

    /// <summary>Raised (on an arbitrary thread) when device state, client count or owner changes.</summary>
    public event Action? StatusChanged;

    public HubStatus Status
    {
        get
        {
            lock (_sync)
            {
                return new HubStatus(_device.State, _clients.Count, _owner?.Origin);
            }
        }
    }

    /// <summary>Runs one accepted WebSocket until it closes. The new connection becomes the owner immediately.</summary>
    public async Task RunClientAsync(WebSocket socket, string? origin, string remote, CancellationToken requestAborted)
    {
        using var client = new ClientConnection(
            Interlocked.Increment(ref _nextClientId),
            socket,
            string.IsNullOrEmpty(origin) ? "none" : origin,
            remote,
            _logger,
            requestAborted);

        if (Register(client, out var previous) == Registration.Refused)
        {
            _logger.LogInformation("Client #{Client} from origin {Origin} refused: shutting down", client.Id, client.Origin);
            client.Close(WebSocketCloseStatus.EndpointUnavailable, "sidecar shutting down");
            await client.RunSendLoopAsync().ConfigureAwait(false);
            return;
        }

        _logger.LogInformation("Client #{Client} connected from origin {Origin} ({Remote})", client.Id, client.Origin, remote);
        if (previous is not null)
        {
            _logger.LogInformation(
                "Client #{Previous} ({Origin}) superseded by client #{Client}",
                previous.Id,
                previous.Origin,
                client.Id);
            previous.Send(Protocol.Superseded());
            previous.Close(Protocol.SupersededCloseStatus, "superseded by a newer connection");
        }

        StatusChanged?.Invoke();
        var sendLoop = client.RunSendLoopAsync();
        WebSocketCloseStatus? closeReceived = null;
        try
        {
            closeReceived = await ReceiveLoopAsync(client).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is WebSocketException or OperationCanceledException or IOException)
        {
            _logger.LogDebug("Client #{Client} receive ended: {Error}", client.Id, ex.Message);
        }
        finally
        {
            Unregister(client);
            client.Complete();
            await sendLoop.ConfigureAwait(false);
            _logger.LogInformation(
                "Client #{Client} ({Origin}) disconnected after {Seconds:F0} s: sent close {SentClose}, received close {ReceivedClose}; {Inputs} inputs relayed, {Dropped} dropped (slow client), {Acked} frames acked, {Failed} frames failed",
                client.Id,
                client.Origin,
                client.Uptime.Elapsed.TotalSeconds,
                client.CloseStatusSent is { } sent ? $"{(int)sent} {client.CloseReasonSent}" : "none",
                closeReceived is { } received ? ((int)received).ToString() : "none",
                Interlocked.Read(ref client.InputsSent),
                Interlocked.Read(ref client.InputsDropped),
                Interlocked.Read(ref client.FramesAcked),
                Interlocked.Read(ref client.FramesFailed));
            StatusChanged?.Invoke();
        }
    }

    /// <summary>Closes every client with 1001 and refuses new ones.</summary>
    public void Shutdown()
    {
        lock (_sync)
        {
            _state = HubState.Stopping;
            foreach (var client in _clients)
            {
                client.Close(WebSocketCloseStatus.EndpointUnavailable, "sidecar shutting down");
            }
        }
    }

    public void Dispose()
    {
        _device.StateChanged -= OnDeviceStateChanged;
        _device.InputReport -= OnInputReport;
        _activityTimer.Dispose();
        LogActivity();
    }

    /// <summary>Makes <paramref name="client"/> the owner and queues its hello; <paramref name="previous"/> is the owner it replaces.</summary>
    private Registration Register(ClientConnection client, out ClientConnection? previous)
    {
        lock (_sync)
        {
            previous = null;
            if (_state == HubState.Stopping)
            {
                return Registration.Refused;
            }

            previous = _owner;
            _owner = client;
            _clients.Add(client);
            // Under the lock so hello is always first: device/input events only reach the owner via this lock.
            client.Send(Protocol.Hello(_version, _device.State));
            return Registration.Owner;
        }
    }

    private void Unregister(ClientConnection client)
    {
        lock (_sync)
        {
            _clients.Remove(client);
            if (ReferenceEquals(_owner, client))
            {
                _owner = null;
            }
        }
    }

    /// <summary>Returns the close status the client sent, or null if the socket ended without one.</summary>
    private async Task<WebSocketCloseStatus?> ReceiveLoopAsync(ClientConnection client)
    {
        var buffer = new byte[4096];
        var message = new ArrayBufferWriter<byte>(256);
        while (true)
        {
            var result = await client.Socket.ReceiveAsync(buffer.AsMemory(), client.ReceiveToken).ConfigureAwait(false);
            if (result.MessageType == WebSocketMessageType.Close)
            {
                var status = client.Socket.CloseStatus ?? WebSocketCloseStatus.NormalClosure;
                client.Close(status, "");
                return status;
            }

            // After we started closing, drain whatever the client still sends until its close frame arrives.
            if (client.State == ConnectionState.Closing)
            {
                continue;
            }

            if (result.MessageType == WebSocketMessageType.Binary)
            {
                Reject(client, "binary messages are not supported");
                continue;
            }

            if (message.WrittenCount + result.Count > MaxMessageBytes)
            {
                Reject(client, $"message exceeds {MaxMessageBytes} bytes");
                continue;
            }

            message.Write(buffer.AsSpan(0, result.Count));
            if (!result.EndOfMessage)
            {
                continue;
            }

            var parsed = Protocol.TryParseClientMessage(message.WrittenSpan, out var request, out var error);
            message.Clear();
            if (!parsed)
            {
                Reject(client, error);
                continue;
            }

            // Awaited inline: frames are written strictly in arrival order, one at a time.
            await WriteFrameAsync(client, request).ConfigureAwait(false);
        }
    }

    private void Reject(ClientConnection client, string reason)
    {
        _logger.LogWarning("Client #{Client} ({Origin}) sent a malformed message: {Reason}; closing 4400", client.Id, client.Origin, reason);
        client.Close(Protocol.MalformedCloseStatus, reason);
    }

    private async Task WriteFrameAsync(ClientConnection client, DisplayRequest request)
    {
        var stopwatch = Stopwatch.StartNew();
        try
        {
            await _device.WriteFrameAsync(request.Frame, CancellationToken.None).ConfigureAwait(false);
            var elapsedMs = stopwatch.ElapsedMilliseconds;
            client.Send(Protocol.DisplayAck(request.Id));
            Interlocked.Increment(ref client.FramesAcked);
            Interlocked.Increment(ref _framesOk);
            Interlocked.Add(ref _frameMsTotal, elapsedMs);
            UpdateMax(ref _frameMsMax, elapsedMs);
            _logger.LogDebug("LCD frame {Id} from client #{Client} written in {ElapsedMs} ms", request.Id, client.Id, elapsedMs);
        }
        catch (DisplayWriteException ex)
        {
            client.Send(Protocol.DisplayError(request.Id, ex.Message));
            Interlocked.Increment(ref client.FramesFailed);
            Interlocked.Increment(ref _framesFailed);
            _logger.LogWarning(
                "LCD frame {Id} from client #{Client} failed after {ElapsedMs} ms: {Error}",
                request.Id,
                client.Id,
                stopwatch.ElapsedMilliseconds,
                ex.Message);
        }
    }

    private void OnDeviceStateChanged(DeviceState state)
    {
        lock (_sync)
        {
            _owner?.Send(Protocol.Device(state));
        }

        StatusChanged?.Invoke();
    }

    private void OnInputReport(PendantInputReport report)
    {
        ClientConnection? owner;
        lock (_sync)
        {
            owner = _owner;
        }

        if (owner is null)
        {
            Interlocked.Increment(ref _inputsWithoutOwner);
            return;
        }

        switch (owner.SendInput(Protocol.Input(report)))
        {
            case EnqueueResult.Queued:
                Interlocked.Increment(ref _inputsRelayed);
                return;
            case EnqueueResult.DroppedOutboxFull:
                Interlocked.Increment(ref _inputsDropped);
                return;
            case EnqueueResult.DroppedClosing:
                Interlocked.Increment(ref _inputsWithoutOwner);
                return;
        }
    }

    private void LogActivity()
    {
        var inputs = Interlocked.Exchange(ref _inputsRelayed, 0);
        var dropped = Interlocked.Exchange(ref _inputsDropped, 0);
        var unowned = Interlocked.Exchange(ref _inputsWithoutOwner, 0);
        var ok = Interlocked.Exchange(ref _framesOk, 0);
        var failed = Interlocked.Exchange(ref _framesFailed, 0);
        var totalMs = Interlocked.Exchange(ref _frameMsTotal, 0);
        var maxMs = Interlocked.Exchange(ref _frameMsMax, 0);
        if (inputs + dropped + unowned + ok + failed == 0)
        {
            return;
        }

        _logger.LogInformation(
            "Activity: {Inputs} input reports relayed, {Dropped} dropped for a slow client, {Unowned} with no client; LCD {Ok} frames ok (avg {AvgMs} ms, max {MaxMs} ms), {Failed} failed",
            inputs,
            dropped,
            unowned,
            ok,
            ok == 0 ? 0 : totalMs / ok,
            maxMs,
            failed);
    }

    private static void UpdateMax(ref long target, long value)
    {
        var current = Interlocked.Read(ref target);
        while (value > current)
        {
            var seen = Interlocked.CompareExchange(ref target, value, current);
            if (seen == current)
            {
                return;
            }

            current = seen;
        }
    }
}
