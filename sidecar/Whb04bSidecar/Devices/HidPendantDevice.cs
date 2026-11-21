using Timer = System.Threading.Timer;
using System.Diagnostics;
using HidSharp;
using Microsoft.Extensions.Logging;

namespace Whb04bSidecar.Devices;

/// <summary>
/// The real WHB04B-6 receiver (VID 0x10CE, PID 0xEB93) via the Windows HID API (HidSharp).
/// A dedicated thread blocks on reads so every report is forwarded; hot-plug is tracked through
/// <see cref="DeviceList.Changed"/> plus a periodic rescan while detached.
/// </summary>
internal sealed class HidPendantDevice : PendantDevice
{
    public const int VendorId = 0x10CE;
    public const int ProductId = 0xEB93;

    private static readonly TimeSpan RescanInterval = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan HotplugSettleDelay = TimeSpan.FromMilliseconds(300);
    private static readonly TimeSpan ReopenDelay = TimeSpan.FromMilliseconds(500);

    private readonly object _sessionLock = new();
    private readonly Timer _scanTimer;
    private HidSession? _session;
    private int _scanning;
    private bool _disposed;
    private string? _lastScanProblem;

    public HidPendantDevice(ILogger<HidPendantDevice> logger)
        : base(logger)
    {
        _scanTimer = new Timer(_ => Scan(), null, Timeout.Infinite, Timeout.Infinite);
    }

    public override void Start()
    {
        DeviceList.Local.Changed += OnDeviceListChanged;
        _scanTimer.Change(TimeSpan.Zero, RescanInterval);
    }

    public override async ValueTask DisposeAsync()
    {
        HidSession? session;
        lock (_sessionLock)
        {
            _disposed = true;
            session = _session;
            _session = null;
        }

        DeviceList.Local.Changed -= OnDeviceListChanged;
        await _scanTimer.DisposeAsync().ConfigureAwait(false);
        session?.Close();
        await base.DisposeAsync().ConfigureAwait(false);
    }

    protected override void WriteFeatureReport(byte[] report)
    {
        HidSession session;
        lock (_sessionLock)
        {
            session = _session ?? throw new IOException("device detached");
        }

        session.Output.SetFeature(report);
    }

    protected override void ResetAfterWriteTimeout()
    {
        HidSession? session;
        lock (_sessionLock)
        {
            session = _session;
        }

        if (session is not null)
        {
            Detach(session, "LCD write timeout");
        }
    }

    private void OnDeviceListChanged(object? sender, DeviceListChangedEventArgs e)
    {
        // Windows fires several notifications per plug event; a short settle delay coalesces them into one scan.
        lock (_sessionLock)
        {
            if (_disposed)
            {
                return;
            }

            _scanTimer.Change(HotplugSettleDelay, RescanInterval);
        }
    }

    private void Scan()
    {
        if (Interlocked.Exchange(ref _scanning, 1) == 1)
        {
            return;
        }

        try
        {
            lock (_sessionLock)
            {
                if (_disposed || _session is not null)
                {
                    return;
                }
            }

            TryOpen();
        }
        catch (Exception ex)
        {
            ReportScanProblem($"HID scan failed: {ex.Message}", ex);
        }
        finally
        {
            Volatile.Write(ref _scanning, 0);
        }
    }

    private void TryOpen()
    {
        var candidates = DeviceList.Local.GetHidDevices(VendorId, ProductId).ToList();
        if (candidates.Count == 0)
        {
            ReportScanProblem("WHB04B-6 receiver not found (VID 0x10CE PID 0xEB93); waiting for hot-plug", null);
            return;
        }

        HidDevice? inputDevice = null;
        HidDevice? featureDevice = null;
        foreach (var candidate in candidates)
        {
            try
            {
                if (inputDevice is null && candidate.GetMaxInputReportLength() > 0)
                {
                    inputDevice = candidate;
                }

                if (featureDevice is null && (candidate.GetMaxFeatureReportLength() > 0 || candidate.GetMaxOutputReportLength() > 0))
                {
                    featureDevice = candidate;
                }
            }
            catch (Exception ex)
            {
                Logger.LogDebug(ex, "Skipping HID interface {Path}: cannot read capabilities", candidate.DevicePath);
            }
        }

        if (inputDevice is null || featureDevice is null)
        {
            ReportScanProblem(
                $"WHB04B-6 found ({candidates.Count} interface(s)) but missing an {(inputDevice is null ? "input" : "feature")}-capable interface",
                null);
            return;
        }

        HidStream? input = null;
        HidStream? output = null;
        try
        {
            input = inputDevice.Open();
            output = featureDevice.Open();
            // Block until a report arrives; closing the stream (detach/shutdown) is what ends the wait.
            input.ReadTimeout = Timeout.Infinite;
        }
        catch (Exception ex)
        {
            input?.Close();
            output?.Close();
            ReportScanProblem($"WHB04B-6 found but could not be opened: {ex.Message}", ex);
            return;
        }

        var session = new HidSession(input, output, inputDevice.DevicePath, featureDevice.DevicePath, inputDevice.GetMaxInputReportLength());
        lock (_sessionLock)
        {
            if (_disposed)
            {
                session.Close();
                return;
            }

            _session = session;
        }

        _lastScanProblem = null;
        Logger.LogInformation(
            "Pendant attached: input {InputPath} (report {InputLength} bytes), LCD {OutputPath} (feature {FeatureLength} bytes)",
            session.InputPath,
            session.InputReportLength,
            session.OutputPath,
            featureDevice.GetMaxFeatureReportLength());

        // Announce the attach before the first report can be relayed.
        SetState(DeviceState.Attached);
        var reader = new Thread(() => ReadLoop(session))
        {
            IsBackground = true,
            Name = "WHB04B HID reader",
            Priority = ThreadPriority.AboveNormal,
        };
        reader.Start();
    }

    private void ReadLoop(HidSession session)
    {
        var buffer = new byte[Math.Max(session.InputReportLength, 2)];
        while (true)
        {
            int count;
            try
            {
                count = session.Input.Read(buffer, 0, buffer.Length);
            }
            catch (Exception ex)
            {
                if (session.IsClosed)
                {
                    return;
                }

                Logger.LogWarning("HID read failed on {Path}: {Error}", session.InputPath, ex.Message);
                Detach(session, "read error");
                return;
            }

            if (count <= 1)
            {
                if (session.IsClosed)
                {
                    return;
                }

                Logger.LogWarning("HID read returned {Count} bytes on {Path}; treating as detach", count, session.InputPath);
                Detach(session, "empty read");
                return;
            }

            Interlocked.Increment(ref session.ReportCount);
            var data = buffer.AsSpan(1, count - 1).ToArray();
            if (Logger.IsEnabled(LogLevel.Trace))
            {
                Logger.LogTrace("HID input report {ReportId}: {Data}", buffer[0], Convert.ToHexString(data));
            }

            RaiseInput(buffer[0], data);
        }
    }

    private void Detach(HidSession session, string reason)
    {
        lock (_sessionLock)
        {
            if (!ReferenceEquals(_session, session))
            {
                return;
            }

            _session = null;
            if (!_disposed)
            {
                _scanTimer.Change(ReopenDelay, RescanInterval);
            }
        }

        session.Close();
        Logger.LogInformation(
            "Pendant detached ({Reason}): {InputPath}; {Reports} input reports over {Seconds:F0} s",
            reason,
            session.InputPath,
            Interlocked.Read(ref session.ReportCount),
            session.Uptime.Elapsed.TotalSeconds);
        SetState(DeviceState.Detached);
    }

    /// <summary>Logs a discovery problem once per distinct message so the 2 s rescan does not spam the log.</summary>
    private void ReportScanProblem(string message, Exception? ex)
    {
        if (message == _lastScanProblem)
        {
            return;
        }

        _lastScanProblem = message;
        if (ex is null)
        {
            Logger.LogInformation("{Message}", message);
            return;
        }

        Logger.LogWarning(ex, "{Message}", message);
    }

    private sealed class HidSession(HidStream input, HidStream output, string inputPath, string outputPath, int inputReportLength)
    {
        private int _closed;

        public long ReportCount;

        public HidStream Input { get; } = input;

        public HidStream Output { get; } = output;

        public string InputPath { get; } = inputPath;

        public string OutputPath { get; } = outputPath;

        public int InputReportLength { get; } = inputReportLength;

        public Stopwatch Uptime { get; } = Stopwatch.StartNew();

        public bool IsClosed => Volatile.Read(ref _closed) == 1;

        public void Close()
        {
            if (Interlocked.Exchange(ref _closed, 1) == 1)
            {
                return;
            }

            // Closing the streams unblocks the reader's pending Read with an exception, which then exits quietly.
            CloseQuietly(Input);
            CloseQuietly(Output);
        }

        private static void CloseQuietly(HidStream stream)
        {
            try
            {
                stream.Close();
            }
            catch (Exception)
            {
                // Already gone (unplugged); nothing left to release.
            }
        }
    }
}
