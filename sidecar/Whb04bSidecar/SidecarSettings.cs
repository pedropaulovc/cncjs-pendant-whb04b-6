using System.Text.Json;
using System.Text.Json.Serialization;

namespace Whb04bSidecar;

internal enum SidecarMode
{
    Hid,
    Simulated,
}

/// <summary>Effective runtime configuration (settings file merged with the command line).</summary>
internal sealed record SidecarOptions(int Port, IReadOnlyList<string> AllowedOrigins, SidecarMode Mode, string Version)
{
    public const int DefaultPort = 17104;

    public string ModeName => Mode == SidecarMode.Simulated ? "simulated" : "hid";
}

/// <summary>Per-user files under %LOCALAPPDATA%\WHB04B-Sidecar.</summary>
internal static class AppPaths
{
    public static string DataDirectory { get; } =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WHB04B-Sidecar");

    public static string SettingsFile { get; } = Path.Combine(DataDirectory, "settings.json");

    public static string LogDirectory { get; } = Path.Combine(DataDirectory, "logs");
}

/// <summary>What was found at the settings path. Invalid files are never overwritten.</summary>
internal enum SettingsFileState
{
    Missing,
    Valid,
    Invalid,
}

/// <summary>Loaded (or default) settings, the file's state, and for invalid files the reason.</summary>
internal sealed record SettingsLoad(SidecarSettings Settings, SettingsFileState State, string? Problem);

/// <summary>settings.json: <c>{"allowedOrigins":[...],"port":17104,"startAtLogin":false}</c>.</summary>
internal sealed class SidecarSettings
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true,
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public List<string> AllowedOrigins { get; set; } = [];

    public int? Port { get; set; }

    public bool StartAtLogin { get; set; }

    /// <summary>Missing file → defaults. Unreadable/invalid file → defaults plus the problem (the file is left untouched).</summary>
    public static SettingsLoad Load(string path)
    {
        if (!File.Exists(path))
        {
            return new SettingsLoad(new SidecarSettings(), SettingsFileState.Missing, null);
        }

        try
        {
            var settings = JsonSerializer.Deserialize<SidecarSettings>(File.ReadAllText(path), JsonOptions) ?? new SidecarSettings();
            settings.AllowedOrigins ??= [];
            return new SettingsLoad(settings, SettingsFileState.Valid, null);
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException)
        {
            return new SettingsLoad(new SidecarSettings(), SettingsFileState.Invalid, $"{path} is invalid and was ignored: {ex.Message}");
        }
    }

    public void Save(string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, JsonSerializer.Serialize(this, JsonOptions));
    }
}
