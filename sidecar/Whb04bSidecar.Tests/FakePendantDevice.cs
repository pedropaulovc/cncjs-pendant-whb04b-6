using System.Collections.Concurrent;
using Microsoft.Extensions.Logging.Abstractions;
using Whb04bSidecar.Devices;

namespace Whb04bSidecar.Tests;

internal enum FakeWriteBehavior
{
    Normal,
    Hang,
}

/// <summary>
/// Test double exercising the real <see cref="PendantDevice"/> write path (serialization, chunking, timeout → reset,
/// stuck-write gate) with an in-memory feature-report sink that can be told to hang.
/// </summary>
internal sealed class FakePendantDevice(TimeSpan? chunkTimeout = null, TimeSpan? stuckWriteGrace = null)
    : PendantDevice(NullLogger.Instance, chunkTimeout, stuckWriteGrace)
{
    private readonly ManualResetEventSlim _release = new(false);
    private volatile FakeWriteBehavior _writeBehavior = FakeWriteBehavior.Normal;

    public ConcurrentQueue<byte[]> FeatureReports { get; } = new();

    public int Resets;

    /// <summary>Hang: the next feature-report write blocks until <see cref="ReleaseHang"/> (a wedged LCD).</summary>
    public FakeWriteBehavior WriteBehavior
    {
        get => _writeBehavior;
        set => _writeBehavior = value;
    }

    public override void Start() => SetState(DeviceState.Attached);

    public void Attach() => SetState(DeviceState.Attached);

    public void Detach() => SetState(DeviceState.Detached);

    public void EmitInput(params byte[] body) => RaiseInput(body, ReadTimestamp());

    public void ReleaseHang() => _release.Set();

    public override async ValueTask DisposeAsync()
    {
        _release.Set();
        await base.DisposeAsync();
        _release.Dispose();
    }

    protected override void WriteFeatureReport(byte[] report)
    {
        if (_writeBehavior == FakeWriteBehavior.Hang)
        {
            _release.Wait();
            return;
        }

        FeatureReports.Enqueue(report);
    }

    protected override void ResetAfterWriteTimeout()
    {
        // Mirrors the HID device: close (detached) and let discovery reopen it (attached). The abandoned write
        // stays blocked until ReleaseHang.
        Interlocked.Increment(ref Resets);
        _writeBehavior = FakeWriteBehavior.Normal;
        SetState(DeviceState.Detached);
        SetState(DeviceState.Attached);
    }
}
