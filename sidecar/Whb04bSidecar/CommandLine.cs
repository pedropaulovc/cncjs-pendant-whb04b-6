using Whb04bSidecar.Server;

namespace Whb04bSidecar;

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

    public int? Port { get; private set; }

    public List<string> AllowedOrigins { get; } = [];

    public bool Simulate { get; private set; }

    public bool NoTray { get; private set; }

    public bool Verbose { get; private set; }

    public bool ShowHelp { get; private set; }

    public bool ShowVersion { get; private set; }

    /// <summary>Accepts <c>--name value</c> and <c>--name=value</c>. Returns false with <paramref name="error"/> on bad input.</summary>
    public static bool TryParse(IReadOnlyList<string> args, out CommandLine result, out string error)
    {
        result = new CommandLine();
        error = "";
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
                    if (!TryTakeValue(args, ref i, inlineValue, out var portText) || !int.TryParse(portText, out var port) || port is < 0 or > 65535)
                    {
                        error = "--port needs a number between 0 and 65535";
                        return false;
                    }

                    result.Port = port;
                    break;
                case "--allow-origin":
                    if (!TryTakeValue(args, ref i, inlineValue, out var origin) || !OriginPolicy.TryNormalize(origin, out var normalized))
                    {
                        error = "--allow-origin needs an http(s) origin such as http://cnc.local:8000";
                        return false;
                    }

                    result.AllowedOrigins.Add(normalized);
                    break;
                case "--simulate":
                    result.Simulate = true;
                    break;
                case "--no-tray":
                    result.NoTray = true;
                    break;
                case "--verbose":
                    result.Verbose = true;
                    break;
                case "--version":
                    result.ShowVersion = true;
                    break;
                case "--help" or "-h" or "/?":
                    result.ShowHelp = true;
                    break;
                default:
                    error = $"Unknown option: {args[i]}";
                    return false;
            }
        }

        return true;
    }

    private static bool TryTakeValue(IReadOnlyList<string> args, ref int index, string? inlineValue, out string value)
    {
        if (inlineValue is not null)
        {
            value = inlineValue;
            return value.Length > 0;
        }

        if (index + 1 >= args.Count)
        {
            value = "";
            return false;
        }

        index++;
        value = args[index];
        return true;
    }
}
