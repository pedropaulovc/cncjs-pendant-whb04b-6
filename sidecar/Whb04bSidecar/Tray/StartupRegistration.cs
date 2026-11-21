using Microsoft.Win32;

namespace Whb04bSidecar.Tray;

internal enum LoginStartup
{
    Disabled,
    Enabled,
}

/// <summary>Per-user "start at login" via HKCU\Software\Microsoft\Windows\CurrentVersion\Run.</summary>
internal static class StartupRegistration
{
    private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "WHB04B-Sidecar";

    public static LoginStartup FromSetting(bool startAtLogin) => startAtLogin ? LoginStartup.Enabled : LoginStartup.Disabled;

    public static LoginStartup Current()
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath);
        return key?.GetValue(ValueName) is string ? LoginStartup.Enabled : LoginStartup.Disabled;
    }

    /// <summary>Registers (or refreshes, if the exe moved) or removes the Run entry.</summary>
    public static void Apply(LoginStartup startup)
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKeyPath);
        if (startup == LoginStartup.Disabled)
        {
            key.DeleteValue(ValueName, throwOnMissingValue: false);
            return;
        }

        var exe = Environment.ProcessPath ?? throw new InvalidOperationException("Cannot determine the executable path");
        key.SetValue(ValueName, $"\"{exe}\"");
    }
}
