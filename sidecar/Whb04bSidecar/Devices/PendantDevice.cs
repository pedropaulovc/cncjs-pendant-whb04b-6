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
    public static readonly TimeSpan DefaultChunkTimeout = TimeSpan.FromMilliseconds(1000);

    private readonly object _stateLock = new();
    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private readonly TimeSpan _chunkTimeout;
    private DeviceState _state = DeviceState.Detached;

    protected PendantDevice(ILogger logger, TimeSpan? chunkTimeout = null)
    {
        Logger = logger;
        _chunkTimeout = chunkTimeout ?? DefaultChunkTimeout;
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

    public event Action<DeviceState>? StateChanged;

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

    /// <summary>Blocking write of one 8-byte feature report (report ID included). May hang; the caller enforces the timeout.</summary>
    protected abstract void WriteFeatureReport(byte[] report);

    /// <summary>A chunk write exceeded the timeout: close the device and let discovery reopen it.</summary>
    protected abstract void ResetAfterWriteTimeout();

    protected virtual void OnFrameWritten(byte[] frame)
    {
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

    protected void RaiseInput(byte reportId, byte[] data) => InputReport?.Invoke(new PendantInputReport(reportId, data));

    private async Task WriteChunkAsync(byte[] report, int chunkIndex, CancellationToken cancellationToken)
    {
        // The HID call is synchronous with no timeout of its own, so run it on the pool and stop waiting after the limit.
        // A hung call pins one pool thread until the device reset releases it; that is rare and self-healing.
        var write = Task.Run(() => WriteFeatureReport(report), CancellationToken.None);
        try
        {
            await write.WaitAsync(_chunkTimeout, cancellationToken).ConfigureAwait(false);
        }
        catch (TimeoutException)
        {
            // Observe the abandoned write's eventual fault so it never surfaces as an unobserved task exception.
            _ = write.ContinueWith(static t => _ = t.Exception, TaskContinuationOptions.OnlyOnFaulted);
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
}
