namespace Whb04bSidecar.Devices;

internal enum DeviceState
{
    Detached,
    Attached,
}

/// <summary>
/// One input report: the report ID, exactly the 7 body bytes WebHID delivers as e.data, and when it was read
/// (<see cref="DateTimeOffset.ToUnixTimeMilliseconds"/> of UtcNow) so clients can discard stale reports.
/// </summary>
internal readonly record struct PendantInputReport(byte ReportId, byte[] Data, long Timestamp);

/// <summary>Raised when an LCD frame could not be written; the message goes to the client verbatim.</summary>
internal sealed class DisplayWriteException(string message, Exception? inner = null) : Exception(message, inner);

/// <summary>
/// Transport-level view of the pendant: raw input reports in, 21-byte LCD frames out.
/// Implemented by the real HID device, the --simulate device, and test fakes.
/// </summary>
internal interface IPendantDevice : IAsyncDisposable
{
    DeviceState State { get; }

    /// <summary>Fired on every attach/detach transition (never twice with the same state).</summary>
    event Action<DeviceState>? StateChanged;

    /// <summary>Fired for every report-ID-0x04 input report read from the device, no dedupe. Raised on a device thread.</summary>
    event Action<PendantInputReport>? InputReport;

    /// <summary>Begins device discovery/monitoring. Called once after the server is listening.</summary>
    void Start();

    /// <summary>
    /// Writes one 21-byte LCD frame. Frames never interleave. Throws <see cref="DisplayWriteException"/> on failure.
    /// </summary>
    Task WriteFrameAsync(byte[] frame, CancellationToken cancellationToken);
}
