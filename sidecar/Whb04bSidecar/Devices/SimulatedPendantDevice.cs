using Microsoft.Extensions.Logging;

namespace Whb04bSidecar.Devices;

/// <summary>Result of injecting a simulated input report.</summary>
internal enum InjectResult
{
    Relayed,
    Detached,
}

/// <summary>
/// In-process stand-in for the pendant (--simulate): input is injected over HTTP, LCD frames are kept
/// in a small history instead of going to hardware. Starts attached.
/// </summary>
internal sealed class SimulatedPendantDevice(ILogger<SimulatedPendantDevice> logger) : PendantDevice(logger)
{
    public const int FrameHistoryLimit = 50;

    private readonly Queue<byte[]> _frames = new();

    public override void Start() => Attach();

    public void Attach()
    {
        Logger.LogInformation("Simulated pendant attached");
        SetState(DeviceState.Attached);
    }

    public void Detach()
    {
        Logger.LogInformation("Simulated pendant detached");
        SetState(DeviceState.Detached);
    }

    /// <summary>Relays a 7-byte input body as if read from the device now. A detached device produces no input.</summary>
    public InjectResult InjectInput(byte[] body)
    {
        if (State != DeviceState.Attached)
        {
            return InjectResult.Detached;
        }

        RaiseInput(body, ReadTimestamp());
        return InjectResult.Relayed;
    }

    /// <summary>The last ≤ 50 frames written, most recent last.</summary>
    public byte[][] RecentFrames()
    {
        lock (_frames)
        {
            return [.. _frames];
        }
    }

    protected override void WriteFeatureReport(byte[] report)
    {
    }

    protected override void ResetAfterWriteTimeout()
    {
    }

    protected override void OnFrameWritten(byte[] frame)
    {
        lock (_frames)
        {
            _frames.Enqueue(frame);
            while (_frames.Count > FrameHistoryLimit)
            {
                _frames.Dequeue();
            }
        }
    }
}
