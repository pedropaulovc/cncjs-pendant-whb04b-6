using Whb04bSidecar.Server;

namespace Whb04bSidecar.Tests;

public sealed class ConfigurationTests
{
    [Fact]
    public void ParsesAllFlags()
    {
        string[] args = ["--port", "18000", "--allow-origin", "http://CNC.lan:8000/", "--allow-origin=https://shop.example", "--simulate", "--no-tray", "--verbose"];

        Assert.True(CommandLine.TryParse(args, out var cli, out var error), error);

        Assert.Equal(18000, cli.Port);
        Assert.Equal(["http://cnc.lan:8000", "https://shop.example"], cli.AllowedOrigins);
        Assert.True(cli.Simulate);
        Assert.True(cli.NoTray);
        Assert.True(cli.Verbose);
    }

    [Theory]
    [InlineData("--port")]
    [InlineData("--port", "70000")]
    [InlineData("--port", "abc")]
    [InlineData("--allow-origin", "ftp://x")]
    [InlineData("--allow-origin", "http://x/path")]
    [InlineData("--bogus")]
    public void RejectsBadArguments(params string[] args)
    {
        Assert.False(CommandLine.TryParse(args, out _, out var error));
        Assert.NotEmpty(error);
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
    public void SettingsRoundTripAndTolerateBadFiles()
    {
        var directory = Path.Combine(Path.GetTempPath(), "whb04b-sidecar-tests-" + Guid.NewGuid().ToString("N"));
        var path = Path.Combine(directory, "settings.json");
        try
        {
            var missing = SidecarSettings.Load(path, out var missingWarning);
            Assert.Null(missingWarning);
            Assert.Empty(missing.AllowedOrigins);
            Assert.Null(missing.Port);

            new SidecarSettings { AllowedOrigins = ["http://cnc.lan:8000"], Port = 18001, StartAtLogin = true }.Save(path);
            Assert.Contains("\"allowedOrigins\"", File.ReadAllText(path));
            var loaded = SidecarSettings.Load(path, out var warning);
            Assert.Null(warning);
            Assert.Equal(["http://cnc.lan:8000"], loaded.AllowedOrigins);
            Assert.Equal(18001, loaded.Port);
            Assert.True(loaded.StartAtLogin);

            File.WriteAllText(path, "{ not json");
            var broken = SidecarSettings.Load(path, out var brokenWarning);
            Assert.NotNull(brokenWarning);
            Assert.Null(broken.Port);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }
}
