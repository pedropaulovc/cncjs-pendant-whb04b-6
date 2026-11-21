using Microsoft.Win32;

namespace Whb04bSidecar.Tray;

/// <summary>Per-user "start at login" via HKCU\Software\Microsoft\Windows\CurrentVersion\Run.</summary>
internal static class StartupRegistration
{
    private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "WHB04B-Sidecar";

    public static bool IsEnabled()
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath);
        return key?.GetValue(ValueName) is string;
    }

    /// <summary>Registers (or refreshes, if the exe moved) or removes the Run entry.</summary>
    public static void Apply(bool enabled)
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKeyPath);
        if (!enabled)
        {
            key.DeleteValue(ValueName, throwOnMissingValue: false);
            return;
        }

        var exe = Environment.ProcessPath ?? throw new InvalidOperationException("Cannot determine the executable path");
        key.SetValue(ValueName, $"\"{exe}\"");
    }
}
