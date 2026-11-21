using Timer = System.Threading.Timer;
using System.Diagnostics;
using HidSharp;
using Microsoft.Extensions.Logging;

namespace Whb04bSidecar.Devices;

/// <summary>Capabilities of one HID interface of the receiver, as reported by Windows.</summary>
internal readonly record struct HidInterfaceInfo(string Path, int InputLength, int OutputLength, int FeatureLength);

/// <summary>How the LCD interface was picked: the expected feature-report interface, or an output-only fallback.</summary>
internal enum LcdInterfaceKind
{
    Feature,
    OutputFallback,
}

/// <summary>The interfaces to open: one for input reports, one for LCD feature reports (may be the same path).</summary>
internal readonly record struct HidInterfaceChoice(HidInterfaceInfo Input, HidInterfaceInfo Lcd, LcdInterfaceKind LcdKind);

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
    private readonly object _scanGate = new();
    private readonly Timer _scanTimer;
    private HidSession? _session;
    private DeviceLifecycle _lifecycle = DeviceLifecycle.Running;
    private string? _lastScanProblem;

    public HidPendantDevice(ILogger<HidPendantDevice> logger)
        : base(logger)
    {
        _scanTimer = new Timer(_ => Scan(), null, Timeout.Infinite, Timeout.Infinite);
    }

    private enum DeviceLifecycle
    {
        Running,
        Disposed,
    }

    private enum SessionState
    {
        Open,
        Closed,
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
            _lifecycle = DeviceLifecycle.Disposed;
            session = _session;
            _session = null;
        }

        DeviceList.Local.Changed -= OnDeviceListChanged;
        await _scanTimer.DisposeAsync().ConfigureAwait(false);
        session?.Close();
        await base.DisposeAsync().ConfigureAwait(false);
    }

    /// <summary>
    /// Picks the first input-capable interface, and for the LCD the first interface with feature reports (the write
    /// path is SetFeature). Only when no interface has feature reports does it fall back to an output-capable one.
    /// </summary>
    public static HidInterfaceChoice? ChooseInterfaces(IReadOnlyList<HidInterfaceInfo> interfaces)
    {
        var input = interfaces.FirstOrDefault(i => i.InputLength > 0);
        if (input.Path is null)
        {
            return null;
        }

        var feature = interfaces.FirstOrDefault(i => i.FeatureLength > 0);
        if (feature.Path is not null)
        {
            return new HidInterfaceChoice(input, feature, LcdInterfaceKind.Feature);
        }

        var output = interfaces.FirstOrDefault(i => i.OutputLength > 0);
        if (output.Path is null)
        {
            return null;
        }

        return new HidInterfaceChoice(input, output, LcdInterfaceKind.OutputFallback);
    }

    /// <summary>
    /// Extracts the 7-byte body of a report-ID-0x04 read (<paramref name="raw"/> includes the report ID). Windows may
    /// return a longer, zero-padded report; anything with another ID or fewer than 8 bytes is not a pendant report.
    /// </summary>
    public static bool TryReadInputBody(ReadOnlySpan<byte> raw, out byte[] body)
    {
        body = [];
        if (raw.Length < InputBodyLength + 1 || raw[0] != InputReportId)
        {
            return false;
        }

        body = raw.Slice(1, InputBodyLength).ToArray();
        return true;
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

        if (session is null)
        {
            return;
        }

        Detach(session, "LCD write timeout");
    }

    private void OnDeviceListChanged(object? sender, DeviceListChangedEventArgs e)
    {
        // Windows fires several notifications per plug event; a short settle delay coalesces them into one scan.
        lock (_sessionLock)
        {
            if (_lifecycle == DeviceLifecycle.Disposed)
            {
                return;
            }

            _scanTimer.Change(HotplugSettleDelay, RescanInterval);
        }
    }

    private void Scan()
    {
        // Timer callbacks can overlap; one scan at a time is enough.
        if (!Monitor.TryEnter(_scanGate))
        {
            return;
        }

        try
        {
            lock (_sessionLock)
            {
                if (_lifecycle == DeviceLifecycle.Disposed || _session is not null)
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
            Monitor.Exit(_scanGate);
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

        var interfaces = new List<HidInterfaceInfo>();
        foreach (var candidate in candidates)
        {
            var info = DescribeInterface(candidate);
            if (info is not null)
            {
                interfaces.Add(info.Value);
            }
        }

        if (ChooseInterfaces(interfaces) is not { } choice)
        {
            ReportScanProblem(
                $"WHB04B-6 found ({candidates.Count} interface(s)) but no input-capable plus feature/output-capable interface",
                null);
            return;
        }

        if (choice.LcdKind == LcdInterfaceKind.OutputFallback)
        {
            Logger.LogWarning("No HID interface reports feature reports; LCD falls back to output-capable {Path} and SetFeature may fail", choice.Lcd.Path);
        }

        var inputDevice = candidates.First(c => c.DevicePath == choice.Input.Path);
        var lcdDevice = candidates.First(c => c.DevicePath == choice.Lcd.Path);
        HidStream? input = null;
        HidStream? output = null;
        try
        {
            input = inputDevice.Open();
            output = lcdDevice.Open();
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

        var session = new HidSession(input, output, choice.Input.Path, choice.Input.InputLength);
        lock (_sessionLock)
        {
            if (_lifecycle == DeviceLifecycle.Disposed)
            {
                session.Close();
                return;
            }

            _session = session;
        }

        _lastScanProblem = null;
        Logger.LogInformation(
            "Pendant attached: input {InputPath} (input report {InputLength} bytes); LCD via {LcdKind} on {LcdPath} (feature {FeatureLength} bytes, output {OutputLength} bytes)",
            choice.Input.Path,
            choice.Input.InputLength,
            choice.LcdKind,
            choice.Lcd.Path,
            choice.Lcd.FeatureLength,
            choice.Lcd.OutputLength);

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

    private HidInterfaceInfo? DescribeInterface(HidDevice device)
    {
        try
        {
            var info = new HidInterfaceInfo(
                device.DevicePath,
                device.GetMaxInputReportLength(),
                device.GetMaxOutputReportLength(),
                device.GetMaxFeatureReportLength());
            Logger.LogDebug(
                "HID interface {Path}: input {Input}, output {Output}, feature {Feature} bytes",
                info.Path,
                info.InputLength,
                info.OutputLength,
                info.FeatureLength);
            return info;
        }
        catch (Exception ex)
        {
            Logger.LogDebug(ex, "Skipping HID interface {Path}: cannot read capabilities", device.DevicePath);
            return null;
        }
    }

    private void ReadLoop(HidSession session)
    {
        var buffer = new byte[Math.Max(session.InputReportLength, InputBodyLength + 1)];
        while (true)
        {
            int count;
            try
            {
                count = session.Input.Read(buffer, 0, buffer.Length);
            }
            catch (Exception ex)
            {
                if (session.State == SessionState.Closed)
                {
                    return;
                }

                Logger.LogWarning("HID read failed on {Path}: {Error}", session.InputPath, ex.Message);
                Detach(session, "read error");
                return;
            }

            var timestamp = ReadTimestamp();
            if (count == 0)
            {
                if (session.State == SessionState.Closed)
                {
                    return;
                }

                Logger.LogWarning("HID read returned 0 bytes on {Path}; treating as detach", session.InputPath);
                Detach(session, "empty read");
                return;
            }

            var raw = buffer.AsSpan(0, count);
            if (!TryReadInputBody(raw, out var body))
            {
                Interlocked.Increment(ref session.IgnoredCount);
                Logger.LogDebug("Ignoring HID input {Count} bytes with report ID {ReportId}: {Data}", count, raw[0], Convert.ToHexString(raw));
                continue;
            }

            Interlocked.Increment(ref session.ReportCount);
            if (Logger.IsEnabled(LogLevel.Trace))
            {
                Logger.LogTrace("HID input report: {Data}", Convert.ToHexString(body));
            }

            RaiseInput(body, timestamp);
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
            if (_lifecycle == DeviceLifecycle.Running)
            {
                _scanTimer.Change(ReopenDelay, RescanInterval);
            }
        }

        session.Close();
        Logger.LogInformation(
            "Pendant detached ({Reason}): {InputPath}; {Reports} input reports ({Ignored} ignored) over {Seconds:F0} s",
            reason,
            session.InputPath,
            Interlocked.Read(ref session.ReportCount),
            Interlocked.Read(ref session.IgnoredCount),
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

    private sealed class HidSession(HidStream input, HidStream output, string inputPath, int inputReportLength)
    {
        private readonly object _stateLock = new();
        private SessionState _state = SessionState.Open;

        public long ReportCount;

        public long IgnoredCount;

        public HidStream Input { get; } = input;

        public HidStream Output { get; } = output;

        public string InputPath { get; } = inputPath;

        public int InputReportLength { get; } = inputReportLength;

        public Stopwatch Uptime { get; } = Stopwatch.StartNew();

        public SessionState State
        {
            get
            {
                lock (_stateLock)
                {
                    return _state;
                }
            }
        }

        public void Close()
        {
            lock (_stateLock)
            {
                if (_state == SessionState.Closed)
                {
                    return;
                }

                _state = SessionState.Closed;
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
