using System.Net.Sockets;
using Microsoft.AspNetCore.Connections;
using Whb04bSidecar.Devices;
using Whb04bSidecar.Server;

namespace Whb04bSidecar.Tests;

public sealed class ConfigurationTests
{
    [Fact]
    public void ParsesAllFlags()
    {
        string[] args = ["--port", "18000", "--allow-origin", "http://CNC.lan:8000/", "--allow-origin=https://shop.example", "--simulate", "--no-tray", "--verbose"];

        var cli = CommandLine.Parse(args);

        Assert.Null(cli.Error);
        Assert.Equal(CommandLineAction.Run, cli.Action);
        Assert.Equal(18000, cli.Port);
        Assert.Equal(["http://cnc.lan:8000", "https://shop.example"], cli.AllowedOrigins);
        Assert.Equal(SidecarMode.Simulated, cli.Mode);
        Assert.Equal(RunMode.Headless, cli.RunMode);
        Assert.Equal(LogVerbosity.Verbose, cli.Verbosity);
    }

    [Fact]
    public void DefaultsToTrayHidRun()
    {
        var cli = CommandLine.Parse([]);

        Assert.Null(cli.Error);
        Assert.Equal(CommandLineAction.Run, cli.Action);
        Assert.Equal(RunMode.Tray, cli.RunMode);
        Assert.Equal(SidecarMode.Hid, cli.Mode);
        Assert.Equal(LogVerbosity.Normal, cli.Verbosity);
        Assert.Null(cli.Port);
    }

    [Theory]
    [InlineData("--help", nameof(CommandLineAction.ShowHelp))]
    [InlineData("/?", nameof(CommandLineAction.ShowHelp))]
    [InlineData("--version", nameof(CommandLineAction.ShowVersion))]
    public void ParsesActions(string arg, string action) =>
        Assert.Equal(Enum.Parse<CommandLineAction>(action), CommandLine.Parse([arg]).Action);

    [Theory]
    [InlineData("--port")]
    [InlineData("--port", "70000")]
    [InlineData("--port", "abc")]
    [InlineData("--allow-origin", "ftp://x")]
    [InlineData("--allow-origin", "http://x/path")]
    [InlineData("--bogus")]
    public void RejectsBadArguments(params string[] args) => Assert.NotEmpty(CommandLine.Parse(args).Error ?? "");

    [Fact]
    public void RunModeIsKnownEvenWhenAnEarlierArgumentIsBad()
    {
        // Errors must be reported on the right channel (console for --no-tray, message box otherwise).
        var cli = CommandLine.Parse(["--bogus", "--no-tray"]);

        Assert.Equal("Unknown option: --bogus", cli.Error);
        Assert.Equal(RunMode.Headless, cli.RunMode);
    }

    [Theory]
    [InlineData(null, true)]
    [InlineData("", true)]
    [InlineData("http://localhost:8000", true)]
    [InlineData("http://LOCALHOST:8000", true)]
    [InlineData("https://127.0.0.1", true)]
    [InlineData("http://[::1]:3000", true)]
    [InlineData("http://cnc.lan:8000", true)]
    [InlineData("http://cnc.lan:8001", false)]
    [InlineData("https://cnc.lan:8000", false)]
    [InlineData("http://127.0.0.2", false)]
    [InlineData("http://evil.example", false)]
    [InlineData("ws://localhost:8000", false)]
    [InlineData("null", false)]
    public void OriginPolicyMatchesProtocol(string? origin, bool allowed)
    {
        var policy = new OriginPolicy(["http://cnc.lan:8000"]);

        Assert.Equal(allowed, policy.IsAllowed(origin));
    }

    [Fact]
    public void SettingsRoundTripAndReportInvalidFiles()
    {
        var directory = Path.Combine(Path.GetTempPath(), "whb04b-sidecar-tests-" + Guid.NewGuid().ToString("N"));
        var path = Path.Combine(directory, "settings.json");
        try
        {
            var missing = SidecarSettings.Load(path);
            Assert.Equal(SettingsFileState.Missing, missing.State);
            Assert.Null(missing.Problem);
            Assert.Empty(missing.Settings.AllowedOrigins);
            Assert.Null(missing.Settings.Port);

            new SidecarSettings { AllowedOrigins = ["http://cnc.lan:8000"], Port = 18001, StartAtLogin = true }.Save(path);
            Assert.Contains("\"allowedOrigins\"", File.ReadAllText(path));
            var loaded = SidecarSettings.Load(path);
            Assert.Equal(SettingsFileState.Valid, loaded.State);
            Assert.Equal(["http://cnc.lan:8000"], loaded.Settings.AllowedOrigins);
            Assert.Equal(18001, loaded.Settings.Port);
            Assert.True(loaded.Settings.StartAtLogin);

            File.WriteAllText(path, "{ not json");
            var broken = SidecarSettings.Load(path);
            Assert.Equal(SettingsFileState.Invalid, broken.State);
            Assert.Contains("invalid", broken.Problem);
            Assert.Null(broken.Settings.Port);
            Assert.Equal("{ not json", File.ReadAllText(path));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Theory]
    [InlineData(0, nameof(ParentConsoleAttach.Attached), nameof(ConsoleOutput.ParentConsole))]
    [InlineData(0, nameof(ParentConsoleAttach.Unavailable), nameof(ConsoleOutput.None))]
    [InlineData(-1, nameof(ParentConsoleAttach.Attached), nameof(ConsoleOutput.ParentConsole))]
    [InlineData(-1, nameof(ParentConsoleAttach.Unavailable), nameof(ConsoleOutput.None))]
    [InlineData(0x1F4, nameof(ParentConsoleAttach.Attached), nameof(ConsoleOutput.Redirected))]
    [InlineData(0x1F4, nameof(ParentConsoleAttach.Unavailable), nameof(ConsoleOutput.Redirected))]
    public void ConsoleOutputTreatsNullAndInvalidHandlesAsNone(long stdoutHandle, string attach, string expected) =>
        Assert.Equal(
            Enum.Parse<ConsoleOutput>(expected),
            NativeConsole.Classify(new IntPtr(stdoutHandle), Enum.Parse<ParentConsoleAttach>(attach)));

    [Fact]
    public void BindFailuresMeaningPickAnotherPortAreRecognized()
    {
        Assert.True(SidecarHost.IsPortUnavailable(new SocketException((int)SocketError.AccessDenied)));
        Assert.True(SidecarHost.IsPortUnavailable(new SocketException((int)SocketError.AddressAlreadyInUse)));
        Assert.True(SidecarHost.IsPortUnavailable(new IOException("bind", new SocketException((int)SocketError.AccessDenied))));
        Assert.True(SidecarHost.IsPortUnavailable(new IOException("bind", new AddressInUseException("in use"))));
        Assert.False(SidecarHost.IsPortUnavailable(new SocketException((int)SocketError.NetworkDown)));
        Assert.False(SidecarHost.IsPortUnavailable(new IOException("disk")));
    }

    [Fact]
    public void LcdInterfacePrefersFeatureReports()
    {
        HidInterfaceInfo[] interfaces =
        [
            new("out-only", 0, 8, 0),
            new("input", 8, 0, 0),
            new("feature", 0, 0, 8),
        ];

        var choice = HidPendantDevice.ChooseInterfaces(interfaces);

        Assert.NotNull(choice);
        Assert.Equal("input", choice.Value.Input.Path);
        Assert.Equal("feature", choice.Value.Lcd.Path);
        Assert.Equal(LcdInterfaceKind.Feature, choice.Value.LcdKind);
    }

    [Fact]
    public void LcdInterfaceFallsBackToOutputOnlyWithoutFeatureReports()
    {
        var choice = HidPendantDevice.ChooseInterfaces([new("combo", 8, 8, 0)]);

        Assert.NotNull(choice);
        Assert.Equal("combo", choice.Value.Lcd.Path);
        Assert.Equal(LcdInterfaceKind.OutputFallback, choice.Value.LcdKind);
        Assert.Null(HidPendantDevice.ChooseInterfaces([new("input", 8, 0, 0)]));
        Assert.Null(HidPendantDevice.ChooseInterfaces([new("feature", 0, 0, 8)]));
    }

    [Fact]
    public void InputBodyIsExactlySevenBytesOfReport4()
    {
        byte[] exact = [0x04, 1, 2, 3, 4, 5, 6, 7];
        var padded = new byte[65];
        exact.CopyTo(padded, 0);

        Assert.True(HidPendantDevice.TryReadInputBody(exact, out var body));
        Assert.Equal([1, 2, 3, 4, 5, 6, 7], body);
        Assert.True(HidPendantDevice.TryReadInputBody(padded, out var trimmed));
        Assert.Equal([1, 2, 3, 4, 5, 6, 7], trimmed);
        Assert.False(HidPendantDevice.TryReadInputBody(new byte[] { 0x06, 1, 2, 3, 4, 5, 6, 7 }, out _));
        Assert.False(HidPendantDevice.TryReadInputBody(new byte[] { 0x04, 1, 2, 3, 4, 5, 6 }, out _));
    }

    [Fact]
    public void CloseReasonIsCappedAt123Utf8Bytes()
    {
        var reason = Protocol.CloseReason("origin not allowed: http://" + new string('é', 200));

        Assert.True(System.Text.Encoding.UTF8.GetByteCount(reason) <= 123);
        Assert.StartsWith("origin not allowed: http://é", reason);
    }
}
