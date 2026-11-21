using System.Reflection;
using System.Runtime.InteropServices;
using Microsoft.Extensions.Logging;
using Whb04bSidecar.Devices;
using Whb04bSidecar.Logging;
using Whb04bSidecar.Server;
using Whb04bSidecar.Tray;

namespace Whb04bSidecar;

internal static class Program
{
    private const string Title = "WHB04B sidecar";
    private const string InstanceMutexName = @"Local\WHB04B-Sidecar";
    private const string ShowEventName = @"Local\WHB04B-Sidecar-Show";

    private enum ExitCode
    {
        Ok = 0,
        Fatal = 1,
        Usage = 2,
        PortInUse = 3,
    }

    private enum RunMode
    {
        Tray,
        Headless,
    }

    [STAThread]
    private static int Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        var runMode = args.Contains("--no-tray") ? RunMode.Headless : RunMode.Tray;
        var wantsConsoleOutput = runMode == RunMode.Headless || args.Any(a => a is "--help" or "-h" or "/?" or "--version");
        if (wantsConsoleOutput)
        {
            NativeConsole.AttachToParent();
        }

        var version = typeof(Program).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "0.0.0";
        if (!CommandLine.TryParse(args, out var cli, out var error))
        {
            Report(runMode, $"{error}\n\n{CommandLine.Usage}", isError: true);
            return (int)ExitCode.Usage;
        }

        if (cli.ShowHelp || cli.ShowVersion)
        {
            Report(runMode, cli.ShowHelp ? CommandLine.Usage : version, isError: false);
            return (int)ExitCode.Ok;
        }

        Mutex? instanceMutex = null;
        if (runMode == RunMode.Tray)
        {
            instanceMutex = new Mutex(true, InstanceMutexName, out var isFirstInstance);
            if (!isFirstInstance)
            {
                instanceMutex.Dispose();
                SignalRunningInstance();
                return (int)ExitCode.Ok;
            }
        }

        using var ownedInstanceMutex = instanceMutex;

        var settings = SidecarSettings.Load(AppPaths.SettingsFile, out var settingsWarning);
        if (runMode == RunMode.Tray && settingsWarning is null && !File.Exists(AppPaths.SettingsFile))
        {
            settings.Port = SidecarOptions.DefaultPort;
            TrySave(settings);
        }

        var options = new SidecarOptions(
            cli.Port ?? settings.Port ?? SidecarOptions.DefaultPort,
            [.. settings.AllowedOrigins, .. cli.AllowedOrigins],
            cli.Simulate ? SidecarMode.Simulated : SidecarMode.Hid,
            version);

        using var loggerFactory = CreateLoggerFactory(runMode, cli.Verbose);
        var logger = loggerFactory.CreateLogger("Whb04bSidecar");
        AppDomain.CurrentDomain.UnhandledException += (_, e) => logger.LogCritical(e.ExceptionObject as Exception, "Unhandled exception");
        TaskScheduler.UnobservedTaskException += (_, e) => logger.LogWarning(e.Exception, "Unobserved task exception");
        logger.LogInformation(
            "WHB04B sidecar {Version} starting: mode {Mode}, {RunMode}, port {Port}, settings {Settings}",
            version,
            options.ModeName,
            runMode,
            options.Port,
            AppPaths.SettingsFile);
        if (settingsWarning is not null)
        {
            logger.LogWarning("{Warning}", settingsWarning);
        }

        foreach (var origin in settings.AllowedOrigins.Where(o => !OriginPolicy.TryNormalize(o, out _)))
        {
            logger.LogWarning("Ignoring invalid allowedOrigins entry {Origin} in settings.json", origin);
        }

        IPendantDevice device = options.Mode == SidecarMode.Simulated
            ? new SimulatedPendantDevice(loggerFactory.CreateLogger<SimulatedPendantDevice>())
            : new HidPendantDevice(loggerFactory.CreateLogger<HidPendantDevice>());
        var host = SidecarHost.Create(options, device, loggerFactory);
        try
        {
            Task.Run(() => host.StartAsync()).GetAwaiter().GetResult();
        }
        catch (Exception ex)
        {
            var portInUse = ex is PortInUseException;
            var message = portInUse ? ex.Message : $"Could not start the sidecar: {ex.Message}";
            logger.LogError(portInUse ? null : ex, "{Error}", message);
            Report(runMode, message, isError: true);
            Task.Run(() => host.DisposeAsync().AsTask()).GetAwaiter().GetResult();
            return (int)(portInUse ? ExitCode.PortInUse : ExitCode.Fatal);
        }

        var origins = options.AllowedOrigins.Count == 0 ? "loopback only" : "loopback + " + string.Join(", ", options.AllowedOrigins);
        logger.LogInformation("Listening on ws://127.0.0.1:{Port}{Path} (origins: {Origins})", host.Port, SidecarHost.WebSocketPath, origins);

        try
        {
            if (runMode == RunMode.Headless)
            {
                RunHeadless();
            }
            else
            {
                RunTray(host, options, settings, logger);
            }
        }
        finally
        {
            logger.LogInformation("Shutting down");
            Task.Run(() => host.DisposeAsync().AsTask()).GetAwaiter().GetResult();
        }

        return (int)ExitCode.Ok;
    }

    private static ILoggerFactory CreateLoggerFactory(RunMode runMode, bool verbose) => LoggerFactory.Create(builder =>
    {
        builder.SetMinimumLevel(verbose ? LogLevel.Debug : LogLevel.Information);
        builder.AddFilter("Microsoft", LogLevel.Warning);
        builder.AddFilter("System", LogLevel.Warning);
        // The generic host logs start failures with a full stack; Main reports them once, readably.
        builder.AddFilter("Microsoft.Extensions.Hosting.Internal.Host", LogLevel.None);
        builder.AddProvider(new FileLoggerProvider(AppPaths.LogDirectory));
        if (runMode == RunMode.Headless)
        {
            builder.AddSimpleConsole(console =>
            {
                console.SingleLine = true;
                console.TimestampFormat = "HH:mm:ss.fff ";
            });
        }
    });

    private static void RunHeadless()
    {
        using var stop = new ManualResetEventSlim();
        void RequestStop(PosixSignalContext context)
        {
            context.Cancel = true;
            stop.Set();
        }

        using var sigint = PosixSignalRegistration.Create(PosixSignal.SIGINT, RequestStop);
        using var sigterm = PosixSignalRegistration.Create(PosixSignal.SIGTERM, RequestStop);
        stop.Wait();
    }

    private static void RunTray(SidecarHost host, SidecarOptions options, SidecarSettings settings, ILogger logger)
    {
        ApplyStartAtLogin(settings.StartAtLogin, logger);
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += (_, e) => logger.LogError(e.Exception, "Unhandled UI exception");

        using var context = new TrayApplicationContext(host, options, settings, logger);
        using var showRequests = new EventWaitHandle(false, EventResetMode.AutoReset, ShowEventName);
        var registration = ThreadPool.RegisterWaitForSingleObject(showRequests, (_, _) => context.ShowAlreadyRunning(), null, Timeout.Infinite, executeOnlyOnce: false);
        try
        {
            Application.Run(context);
        }
        finally
        {
            registration.Unregister(null);
        }
    }

    /// <summary>settings.json is the source of truth; re-registering also refreshes the path if the exe moved.</summary>
    private static void ApplyStartAtLogin(bool enabled, ILogger logger)
    {
        if (!enabled && !StartupRegistration.IsEnabled())
        {
            return;
        }

        try
        {
            StartupRegistration.Apply(enabled);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Security.SecurityException or InvalidOperationException)
        {
            logger.LogWarning(ex, "Could not apply start-at-login={Enabled}", enabled);
        }
    }

    private static void SignalRunningInstance()
    {
        if (EventWaitHandle.TryOpenExisting(ShowEventName, out var showRequests))
        {
            using (showRequests)
            {
                showRequests.Set();
            }

            return;
        }

        // The first instance holds the mutex but has not finished starting yet.
        MessageBox.Show("The WHB04B sidecar is already running (see the notification area).", Title, MessageBoxButtons.OK, MessageBoxIcon.Information);
    }

    private static void TrySave(SidecarSettings settings)
    {
        try
        {
            settings.Save(AppPaths.SettingsFile);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Defaults still apply; the file is only a convenience for later edits.
        }
    }

    private static void Report(RunMode runMode, string message, bool isError)
    {
        var writer = isError ? Console.Error : Console.Out;
        writer.WriteLine(message);
        if (runMode == RunMode.Headless || NativeConsole.IsAttached)
        {
            return;
        }

        MessageBox.Show(message, Title, MessageBoxButtons.OK, isError ? MessageBoxIcon.Error : MessageBoxIcon.Information);
    }

    /// <summary>A WinExe has no console; headless runs borrow the launching terminal's so logs are visible there.</summary>
    private static class NativeConsole
    {
        private const int AttachParentProcess = -1;
        private const int StdOutputHandle = -11;

        public static bool IsAttached { get; private set; }

        public static void AttachToParent()
        {
            // Redirected output (pipes, files) already works; only attach when there is no stdout at all.
            if (GetStdHandle(StdOutputHandle) != IntPtr.Zero)
            {
                IsAttached = true;
                return;
            }

            IsAttached = AttachConsole(AttachParentProcess);
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool AttachConsole(int processId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GetStdHandle(int handle);
    }
}
