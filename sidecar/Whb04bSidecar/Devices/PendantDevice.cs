using System.Diagnostics;
using Microsoft.Extensions.Logging;

namespace Whb04bSidecar.Devices;

/// <summary>
/// Shared device behavior: state transitions, input fan-out and the LCD write path
/// (serialize frames, split into three <c>[0x06, 7 bytes]</c> feature reports, per-chunk timeout → reset).
/// Subclasses only provide the blocking feature-report write and the reset.
/// </summary>
internal abstract class PendantDevice : IPendantDevice
{
    public const int FrameLength = 21;
    public const int ChunkPayloadLength = 7;
    public const byte DisplayReportId = 0x06;
    public const byte InputReportId = 0x04;
    public const int InputBodyLength = 7;
    public static readonly TimeSpan DefaultChunkTimeout = TimeSpan.FromMilliseconds(1000);
    public static readonly TimeSpan DefaultStuckWriteGrace = TimeSpan.FromSeconds(5);

    private readonly object _stateLock = new();
    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private readonly TimeSpan _chunkTimeout;
    private readonly TimeSpan _stuckWriteGrace;
    private DeviceState _state = DeviceState.Detached;

    // Guarded by _stateLock: a chunk write that timed out but whose OS call has not returned yet, and the LCD state
    // that follows from it. _session counts device sessions (fresh handles) so a reopen can lift the gate.
    private AbandonedWrite? _abandoned;
    private LcdState _lcdState = LcdState.Ok;
    private long _session;

    protected PendantDevice(ILogger logger, TimeSpan? chunkTimeout = null, TimeSpan? stuckWriteGrace = null)
    {
        Logger = logger;
        _chunkTimeout = chunkTimeout ?? DefaultChunkTimeout;
        _stuckWriteGrace = stuckWriteGrace ?? DefaultStuckWriteGrace;
    }

    protected ILogger Logger { get; }

    public DeviceState State
    {
        get
        {
            lock (_stateLock)
            {
                return _state;
            }
        }
    }

    public LcdState LcdState
    {
        get
        {
            lock (_stateLock)
            {
                return _lcdState;
            }
        }
    }

    public event Action<DeviceState>? StateChanged;

    public event Action<LcdState>? LcdStateChanged;

    public event Action<PendantInputReport>? InputReport;

    public abstract void Start();

    public async Task WriteFrameAsync(byte[] frame, CancellationToken cancellationToken)
    {
        if (frame.Length != FrameLength)
        {
            throw new DisplayWriteException($"frame must be {FrameLength} bytes, got {frame.Length}");
        }

        await _writeLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await WaitForAbandonedWriteAsync(cancellationToken).ConfigureAwait(false);
            if (State != DeviceState.Attached)
            {
                throw new DisplayWriteException("no device attached");
            }

            for (var chunkIndex = 0; chunkIndex < FrameLength / ChunkPayloadLength; chunkIndex++)
            {
                var report = new byte[ChunkPayloadLength + 1];
                report[0] = DisplayReportId;
                Array.Copy(frame, chunkIndex * ChunkPayloadLength, report, 1, ChunkPayloadLength);
                await WriteChunkAsync(report, chunkIndex, cancellationToken).ConfigureAwait(false);
            }

            OnFrameWritten(frame);
        }
        finally
        {
            _writeLock.Release();
        }
    }

    public virtual ValueTask DisposeAsync()
    {
        _writeLock.Dispose();
        return ValueTask.CompletedTask;
    }

    /// <summary>Wall-clock read time sent to clients as <c>t</c> (same clock as the browser's Date.now()).</summary>
    protected static long ReadTimestamp() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    /// <summary>Blocking write of one 8-byte feature report (report ID included). May hang; the caller enforces the timeout.</summary>
    protected abstract void WriteFeatureReport(byte[] report);

    /// <summary>A chunk write exceeded the timeout: close the device and let discovery reopen it.</summary>
    protected abstract void ResetAfterWriteTimeout();

    protected virtual void OnFrameWritten(byte[] frame)
    {
    }

    /// <summary>A fresh device handle was opened. A write stuck on an older handle no longer blocks the LCD for good.</summary>
    protected void BeginSession()
    {
        lock (_stateLock)
        {
            _session++;
        }
    }

    /// <summary>Changes state and raises <see cref="StateChanged"/> only on a real transition.</summary>
    protected void SetState(DeviceState state)
    {
        lock (_stateLock)
        {
            if (_state == state)
            {
                return;
            }

            _state = state;
        }

        StateChanged?.Invoke(state);
    }

    /// <summary>Publishes one input report: the 7-byte body and the time it was read.</summary>
    protected void RaiseInput(byte[] body, long timestamp) =>
        InputReport?.Invoke(new PendantInputReport(InputReportId, body, timestamp));

    /// <summary>
    /// After a timeout the abandoned OS call may still complete later and land a stale chunk on the LCD, so no new
    /// frame starts until it has returned. Once the grace period since the timeout has passed: if the device has
    /// been reopened since (a new handle), frames resume on it with a warning; otherwise they are refused.
    /// </summary>
    private async Task WaitForAbandonedWriteAsync(CancellationToken cancellationToken)
    {
        AbandonedWrite? abandoned;
        lock (_stateLock)
        {
            abandoned = _abandoned;
        }

        if (abandoned is null)
        {
            return;
        }

        var remaining = _stuckWriteGrace - Stopwatch.GetElapsedTime(abandoned.StartedAt);
        if (remaining > TimeSpan.Zero)
        {
            await Task.WhenAny(abandoned.Write, Task.Delay(remaining, cancellationToken)).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
        }

        if (abandoned.Write.IsCompleted)
        {
            ClearAbandoned(abandoned);
            return;
        }

        var stuckMs = (long)Stopwatch.GetElapsedTime(abandoned.StartedAt).TotalMilliseconds;
        long session;
        lock (_stateLock)
        {
            session = _session;
        }

        if (session == abandoned.Session)
        {
            Logger.LogDebug("Refusing LCD frame: abandoned write still pending after {StuckMs} ms on the same device handle", stuckMs);
            throw new DisplayWriteException("previous LCD write still stuck");
        }

        Logger.LogWarning(
            "LCD write abandoned {StuckMs} ms ago is still pending on the previous device handle; resuming LCD writes on the reopened device (that late chunk may still reach the LCD)",
            stuckMs);
        ClearAbandoned(abandoned);
    }

    private async Task WriteChunkAsync(byte[] report, int chunkIndex, CancellationToken cancellationToken)
    {
        // The HID call is synchronous with no timeout of its own, so run it on the pool and stop waiting after the
        // limit. A hung call keeps its pool thread until the OS call returns; until then new frames wait or are
        // refused (WaitForAbandonedWriteAsync), unless the device has been reopened on a fresh handle.
        var started = Stopwatch.GetTimestamp();
        var write = Task.Run(() => WriteFeatureReport(report), CancellationToken.None);
        try
        {
            await write.WaitAsync(_chunkTimeout, cancellationToken).ConfigureAwait(false);
        }
        catch (TimeoutException)
        {
            Abandon(write, started);
            Logger.LogWarning(
                "LCD chunk {Chunk}/3 timed out after {TimeoutMs} ms; resetting device",
                chunkIndex + 1,
                (int)_chunkTimeout.TotalMilliseconds);
            ResetAfterWriteTimeout();
            throw new DisplayWriteException($"LCD write timed out after {(int)_chunkTimeout.TotalMilliseconds} ms (chunk {chunkIndex + 1}/3)");
        }
        catch (Exception ex) when (ex is not OperationCanceledException and not DisplayWriteException)
        {
            throw new DisplayWriteException($"HID error on chunk {chunkIndex + 1}/3: {ex.Message}", ex);
        }
    }

    private void Abandon(Task write, long startedAt)
    {
        AbandonedWrite abandoned;
        lock (_stateLock)
        {
            abandoned = new AbandonedWrite(write, startedAt, _session);
            _abandoned = abandoned;
        }

        SetLcdState(LcdState.Stuck);
        _ = write.ContinueWith(
            completed =>
            {
                _ = completed.Exception;
                Logger.LogInformation(
                    "Abandoned LCD write returned {Outcome} {ElapsedMs} ms after it started",
                    completed.Status,
                    (long)Stopwatch.GetElapsedTime(abandoned.StartedAt).TotalMilliseconds);
                ClearAbandoned(abandoned);
            },
            TaskScheduler.Default);
    }

    /// <summary>Lifts the gate if <paramref name="abandoned"/> is still the current one (a newer timeout replaces it).</summary>
    private void ClearAbandoned(AbandonedWrite abandoned)
    {
        lock (_stateLock)
        {
            if (!ReferenceEquals(_abandoned, abandoned))
            {
                return;
            }

            _abandoned = null;
        }

        SetLcdState(LcdState.Ok);
    }

    private void SetLcdState(LcdState state)
    {
        lock (_stateLock)
        {
            if (_lcdState == state)
            {
                return;
            }

            _lcdState = state;
        }

        LcdStateChanged?.Invoke(state);
    }

    private sealed record AbandonedWrite(Task Write, long StartedAt, long Session);
}
