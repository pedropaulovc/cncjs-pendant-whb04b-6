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

    private enum InstanceClaim
    {
        Acquired,
        NotNeeded,
        AlreadyRunning,
    }

    private enum MessageKind
    {
        Info,
        Error,
    }

    [STAThread]
    private static int Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        var cli = CommandLine.Parse(args);
        if (cli.RunMode == RunMode.Headless || cli.Action != CommandLineAction.Run)
        {
            NativeConsole.AttachToParent();
        }

        var version = typeof(Program).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "0.0.0";
        if (cli.Error is not null)
        {
            Report(cli.RunMode, $"{cli.Error}\n\n{CommandLine.Usage}", MessageKind.Error);
            return (int)ExitCode.Usage;
        }

        switch (cli.Action)
        {
            case CommandLineAction.ShowHelp:
                Report(cli.RunMode, CommandLine.Usage, MessageKind.Info);
                return (int)ExitCode.Ok;
            case CommandLineAction.ShowVersion:
                Report(cli.RunMode, version, MessageKind.Info);
                return (int)ExitCode.Ok;
        }

        var claim = ClaimInstance(cli.RunMode, out var instanceMutex);
        using var ownedInstanceMutex = instanceMutex;
        if (claim == InstanceClaim.AlreadyRunning)
        {
            SignalRunningInstance();
            return (int)ExitCode.Ok;
        }

        var settingsLoad = SidecarSettings.Load(AppPaths.SettingsFile);
        var settings = settingsLoad.Settings;
        if (cli.RunMode == RunMode.Tray && settingsLoad.State == SettingsFileState.Missing)
        {
            settings.Port = SidecarOptions.DefaultPort;
            TrySave(settings);
        }

        var options = new SidecarOptions(
            cli.Port ?? settings.Port ?? SidecarOptions.DefaultPort,
            [.. settings.AllowedOrigins, .. cli.AllowedOrigins],
            cli.Mode,
            version);

        using var loggerFactory = CreateLoggerFactory(cli.RunMode, cli.Verbosity);
        var logger = loggerFactory.CreateLogger("Whb04bSidecar");
        AppDomain.CurrentDomain.UnhandledException += (_, e) => logger.LogCritical(e.ExceptionObject as Exception, "Unhandled exception");
        TaskScheduler.UnobservedTaskException += (_, e) => logger.LogWarning(e.Exception, "Unobserved task exception");
        logger.LogInformation(
            "WHB04B sidecar {Version} starting: mode {Mode}, {RunMode}, port {Port}, console {ConsoleOutput}, settings {Settings} ({SettingsState})",
            version,
            options.ModeName,
            cli.RunMode,
            options.Port,
            NativeConsole.Output,
            AppPaths.SettingsFile,
            settingsLoad.State);
        if (settingsLoad.Problem is not null)
        {
            logger.LogWarning("{Problem}", settingsLoad.Problem);
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
            Report(cli.RunMode, message, MessageKind.Error);
            Task.Run(() => host.DisposeAsync().AsTask()).GetAwaiter().GetResult();
            return (int)(portInUse ? ExitCode.PortInUse : ExitCode.Fatal);
        }

        var origins = options.AllowedOrigins.Count == 0 ? "loopback only" : "loopback + " + string.Join(", ", options.AllowedOrigins);
        logger.LogInformation("Listening on ws://127.0.0.1:{Port}{Path} (origins: {Origins})", host.Port, SidecarHost.WebSocketPath, origins);

        try
        {
            Run(cli.RunMode, host, options, settingsLoad, logger);
        }
        finally
        {
            logger.LogInformation("Shutting down");
            Task.Run(() => host.DisposeAsync().AsTask()).GetAwaiter().GetResult();
        }

        return (int)ExitCode.Ok;
    }

    private static void Run(RunMode runMode, SidecarHost host, SidecarOptions options, SettingsLoad settingsLoad, ILogger logger)
    {
        switch (runMode)
        {
            case RunMode.Headless:
                RunHeadless(logger);
                return;
            case RunMode.Tray:
                RunTray(host, options, settingsLoad, logger);
                return;
        }
    }

    /// <summary>Tray runs are single-instance; headless runs (tests, CI, other ports) are not.</summary>
    private static InstanceClaim ClaimInstance(RunMode runMode, out Mutex? mutex)
    {
        mutex = null;
        if (runMode != RunMode.Tray)
        {
            return InstanceClaim.NotNeeded;
        }

        var candidate = new Mutex(true, InstanceMutexName, out var isFirstInstance);
        if (!isFirstInstance)
        {
            candidate.Dispose();
            return InstanceClaim.AlreadyRunning;
        }

        mutex = candidate;
        return InstanceClaim.Acquired;
    }

    private static ILoggerFactory CreateLoggerFactory(RunMode runMode, LogVerbosity verbosity) => LoggerFactory.Create(builder =>
    {
        builder.SetMinimumLevel(verbosity == LogVerbosity.Verbose ? LogLevel.Debug : LogLevel.Information);
        builder.AddFilter("Microsoft", LogLevel.Warning);
        builder.AddFilter("System", LogLevel.Warning);
        // The generic host logs start failures with a full stack; Main reports them once, readably.
        builder.AddFilter("Microsoft.Extensions.Hosting.Internal.Host", LogLevel.None);
        builder.AddProvider(new FileLoggerProvider(AppPaths.LogDirectory));
        if (runMode != RunMode.Headless)
        {
            return;
        }

        builder.AddSimpleConsole(console =>
        {
            console.SingleLine = true;
            console.TimestampFormat = "HH:mm:ss.fff ";
        });
    });

    /// <summary>Runs until Ctrl+C / Ctrl+Break (SIGINT) or console close / logoff / shutdown (SIGTERM).</summary>
    private static void RunHeadless(ILogger logger)
    {
        using var stop = new ManualResetEventSlim();
        void RequestStop(PosixSignalContext context)
        {
            context.Cancel = true;
            logger.LogInformation("Received {Signal}", context.Signal);
            stop.Set();
        }

        using var sigint = PosixSignalRegistration.Create(PosixSignal.SIGINT, RequestStop);
        using var sigquit = PosixSignalRegistration.Create(PosixSignal.SIGQUIT, RequestStop);
        using var sigterm = PosixSignalRegistration.Create(PosixSignal.SIGTERM, RequestStop);
        stop.Wait();
    }

    private static void RunTray(SidecarHost host, SidecarOptions options, SettingsLoad settingsLoad, ILogger logger)
    {
        // An invalid settings.json is left alone: no Run-key reconciliation from defaults it does not contain.
        if (settingsLoad.State != SettingsFileState.Invalid)
        {
            ApplyStartAtLogin(StartupRegistration.FromSetting(settingsLoad.Settings.StartAtLogin), logger);
        }

        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += (_, e) => logger.LogError(e.Exception, "Unhandled UI exception");

        using var context = new TrayApplicationContext(host, options, settingsLoad, logger);
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
    private static void ApplyStartAtLogin(LoginStartup startup, ILogger logger)
    {
        if (startup == LoginStartup.Disabled && StartupRegistration.Current() == LoginStartup.Disabled)
        {
            return;
        }

        try
        {
            StartupRegistration.Apply(startup);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Security.SecurityException or InvalidOperationException)
        {
            logger.LogWarning(ex, "Could not apply start-at-login {Startup}", startup);
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

    private static void Report(RunMode runMode, string message, MessageKind kind)
    {
        var writer = kind == MessageKind.Error ? Console.Error : Console.Out;
        writer.WriteLine(message);
        if (runMode == RunMode.Headless || NativeConsole.Output != ConsoleOutput.None)
        {
            return;
        }

        MessageBox.Show(message, Title, MessageBoxButtons.OK, kind == MessageKind.Error ? MessageBoxIcon.Error : MessageBoxIcon.Information);
    }
}
