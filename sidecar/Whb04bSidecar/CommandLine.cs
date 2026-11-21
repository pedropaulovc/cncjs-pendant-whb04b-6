using Whb04bSidecar.Server;

namespace Whb04bSidecar;

internal enum CommandLineAction
{
    Run,
    ShowHelp,
    ShowVersion,
}

/// <summary>Tray: notification-area icon and single instance. Headless (--no-tray): console logging, Ctrl+C to stop.</summary>
internal enum RunMode
{
    Tray,
    Headless,
}

internal enum LogVerbosity
{
    Normal,
    Verbose,
}

internal sealed class CommandLine
{
    public const string Usage = """
        Usage: Whb04bSidecar.exe [options]

          --port <n>             Listen on 127.0.0.1:<n> (default 17104, or "port" in settings.json; 0 = any free port)
          --allow-origin <url>   Also accept this browser origin, e.g. http://cnc.local:8000 (repeatable)
          --simulate             Use an in-process simulated pendant instead of USB HID; enables /simulate/* endpoints
          --no-tray              Headless: no tray icon, logs to stdout as well as the log files; Ctrl+C to stop
          --verbose              Log at Debug level (per-frame LCD latency, HID details)
          --version              Print the version and exit
          --help                 Show this help

        Settings: %LOCALAPPDATA%\WHB04B-Sidecar\settings.json   Logs: %LOCALAPPDATA%\WHB04B-Sidecar\logs
        """;

    public CommandLineAction Action { get; private set; } = CommandLineAction.Run;

    public RunMode RunMode { get; private set; } = RunMode.Tray;

    public SidecarMode Mode { get; private set; } = SidecarMode.Hid;

    public LogVerbosity Verbosity { get; private set; } = LogVerbosity.Normal;

    public int? Port { get; private set; }

    public List<string> AllowedOrigins { get; } = [];

    /// <summary>The first problem found, or null. Parsing continues past errors so <see cref="RunMode"/> is always known.</summary>
    public string? Error { get; private set; }

    /// <summary>Accepts <c>--name value</c> and <c>--name=value</c>.</summary>
    public static CommandLine Parse(IReadOnlyList<string> args)
    {
        var result = new CommandLine();
        for (var i = 0; i < args.Count; i++)
        {
            var arg = args[i];
            string? inlineValue = null;
            var equals = arg.IndexOf('=');
            if (arg.StartsWith("--", StringComparison.Ordinal) && equals > 0)
            {
                inlineValue = arg[(equals + 1)..];
                arg = arg[..equals];
            }

            switch (arg)
            {
                case "--port":
                    var portText = TakeValue(args, ref i, inlineValue);
                    if (portText is null)
                    {
                        result.Fail("--port needs a value");
                        break;
                    }

                    if (!int.TryParse(portText, out var port) || port is < 0 or > 65535)
                    {
                        result.Fail("--port needs a number between 0 and 65535");
                        break;
                    }

                    result.Port = port;
                    break;
                case "--allow-origin":
                    var origin = TakeValue(args, ref i, inlineValue);
                    if (origin is null)
                    {
                        result.Fail("--allow-origin needs a value");
                        break;
                    }

                    if (!OriginPolicy.TryNormalize(origin, out var normalized))
                    {
                        result.Fail("--allow-origin needs an http(s) origin such as http://cnc.local:8000");
                        break;
                    }

                    result.AllowedOrigins.Add(normalized);
                    break;
                case "--simulate":
                    result.Mode = SidecarMode.Simulated;
                    break;
                case "--no-tray":
                    result.RunMode = RunMode.Headless;
                    break;
                case "--verbose":
                    result.Verbosity = LogVerbosity.Verbose;
                    break;
                case "--version":
                    result.Action = CommandLineAction.ShowVersion;
                    break;
                case "--help" or "-h" or "/?":
                    result.Action = CommandLineAction.ShowHelp;
                    break;
                default:
                    result.Fail($"Unknown option: {args[i]}");
                    break;
            }
        }

        return result;
    }

    private void Fail(string error) => Error ??= error;

    /// <summary>The flag's value, or null if it has none. A following <c>--flag</c> is never taken as a value.</summary>
    private static string? TakeValue(IReadOnlyList<string> args, ref int index, string? inlineValue)
    {
        if (inlineValue is not null)
        {
            return inlineValue.Length > 0 ? inlineValue : null;
        }

        if (index + 1 >= args.Count || args[index + 1].StartsWith("--", StringComparison.Ordinal))
        {
            return null;
        }

        index++;
        return args[index];
    }
}
