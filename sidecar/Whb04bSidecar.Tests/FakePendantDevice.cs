using System.Collections.Concurrent;
using Microsoft.Extensions.Logging.Abstractions;
using Whb04bSidecar.Devices;

namespace Whb04bSidecar.Tests;

/// <summary>
/// Test double exercising the real <see cref="PendantDevice"/> write path (serialization, chunking, timeout → reset)
/// with an in-memory feature-report sink that can be told to hang.
/// </summary>
internal sealed class FakePendantDevice(TimeSpan? chunkTimeout = null) : PendantDevice(NullLogger.Instance, chunkTimeout)
{
    private readonly ManualResetEventSlim _release = new(false);

    public ConcurrentQueue<byte[]> FeatureReports { get; } = new();

    /// <summary>When set, the next feature-report write blocks until <see cref="ReleaseHang"/> (simulates a wedged LCD).</summary>
    public volatile bool HangWrites;

    public int Resets;

    public override void Start() => SetState(DeviceState.Attached);

    public void Attach() => SetState(DeviceState.Attached);

    public void Detach() => SetState(DeviceState.Detached);

    public void EmitInput(byte reportId, params byte[] data) => RaiseInput(reportId, data);

    public void ReleaseHang() => _release.Set();

    public override async ValueTask DisposeAsync()
    {
        _release.Set();
        await base.DisposeAsync();
        _release.Dispose();
    }

    protected override void WriteFeatureReport(byte[] report)
    {
        if (HangWrites)
        {
            _release.Wait();
            return;
        }

        FeatureReports.Enqueue(report);
    }

    protected override void ResetAfterWriteTimeout()
    {
        // Mirrors the HID device: close (detached) and let discovery reopen it (attached).
        Interlocked.Increment(ref Resets);
        HangWrites = false;
        SetState(DeviceState.Detached);
        SetState(DeviceState.Attached);
    }
}
