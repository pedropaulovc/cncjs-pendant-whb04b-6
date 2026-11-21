using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using Microsoft.Extensions.Logging;
using Whb04bSidecar.Devices;
using Whb04bSidecar.Server;

namespace Whb04bSidecar.Tray;

/// <summary>
/// Notification-area UI: status in the tooltip and first menu line, start-at-login toggle, log folder, quit.
/// The icon color mirrors the state: gray = no pendant, amber = pendant but no widget, green = relaying.
/// </summary>
internal sealed class TrayApplicationContext : ApplicationContext
{
    private readonly SidecarHost _host;
    private readonly SidecarOptions _options;
    private readonly SidecarSettings _settings;
    private readonly ILogger _logger;
    private readonly NotifyIcon _notifyIcon;
    private readonly ToolStripMenuItem _statusItem;
    private readonly ToolStripMenuItem _startAtLoginItem;
    private readonly Control _uiThread;
    private readonly Icon _detachedIcon = CreateStatusIcon(Color.FromArgb(140, 140, 140));
    private readonly Icon _idleIcon = CreateStatusIcon(Color.FromArgb(230, 160, 20));
    private readonly Icon _activeIcon = CreateStatusIcon(Color.FromArgb(40, 180, 70));

    public TrayApplicationContext(SidecarHost host, SidecarOptions options, SidecarSettings settings, ILogger logger)
    {
        _host = host;
        _options = options;
        _settings = settings;
        _logger = logger;

        // A handle-backed control gives a way to marshal hub events (raised on HID/socket threads) onto the UI thread.
        _uiThread = new Control();
        _ = _uiThread.Handle;

        _statusItem = new ToolStripMenuItem { Enabled = false };
        _startAtLoginItem = new ToolStripMenuItem("Start at login", null, (_, _) => ToggleStartAtLogin())
        {
            Checked = StartupRegistration.IsEnabled(),
        };
        var menu = new ContextMenuStrip();
        menu.Items.Add(_statusItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(_startAtLoginItem);
        menu.Items.Add(new ToolStripMenuItem("Open log folder", null, (_, _) => OpenLogFolder()));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem("Quit", null, (_, _) => ExitThread()));

        _notifyIcon = new NotifyIcon { ContextMenuStrip = menu, Visible = true };
        _host.Hub.StatusChanged += OnStatusChanged;
        UpdateStatus();
    }

    /// <summary>Called (from any thread) when a second launch signals this instance.</summary>
    public void ShowAlreadyRunning() => PostToUi(() =>
        _notifyIcon.ShowBalloonTip(
            4000,
            "WHB04B sidecar",
            $"Already running on 127.0.0.1:{_host.Port}. Use the tray icon menu to quit.",
            ToolTipIcon.Info));

    protected override void ExitThreadCore()
    {
        _host.Hub.StatusChanged -= OnStatusChanged;
        _notifyIcon.Visible = false;
        base.ExitThreadCore();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _notifyIcon.Dispose();
            _uiThread.Dispose();
            _detachedIcon.Dispose();
            _idleIcon.Dispose();
            _activeIcon.Dispose();
        }

        base.Dispose(disposing);
    }

    private void OnStatusChanged() => PostToUi(UpdateStatus);

    private void PostToUi(Action action)
    {
        try
        {
            _uiThread.BeginInvoke(action);
        }
        catch (Exception ex) when (ex is InvalidOperationException or ObjectDisposedException)
        {
            // Shutting down: the UI thread is gone and there is nothing left to update.
        }
    }

    private void UpdateStatus()
    {
        var status = _host.Hub.Status;
        var attached = status.Device == DeviceState.Attached;
        var simulated = _options.Mode == SidecarMode.Simulated ? " (simulated)" : "";
        var device = attached ? $"Pendant attached{simulated}" : $"Pendant not found{simulated}";
        var client = status.OwnerOrigin is { } origin ? $"Widget connected: {origin}" : "No widget connected";
        _statusItem.Text = $"{device} · {client}";
        _notifyIcon.Icon = !attached ? _detachedIcon : status.OwnerOrigin is null ? _idleIcon : _activeIcon;
        // NotifyIcon.Text is limited to 127 characters.
        var tooltip = $"WHB04B sidecar :{_host.Port}\n{device}\n{client}";
        _notifyIcon.Text = tooltip.Length <= 127 ? tooltip : tooltip[..127];
    }

    private void ToggleStartAtLogin()
    {
        var enable = !_startAtLoginItem.Checked;
        try
        {
            StartupRegistration.Apply(enable);
            _settings.StartAtLogin = enable;
            _settings.Save(AppPaths.SettingsFile);
            _startAtLoginItem.Checked = enable;
            _logger.LogInformation("Start at login {State}", enable ? "enabled" : "disabled");
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Security.SecurityException or InvalidOperationException)
        {
            _logger.LogError(ex, "Could not change start-at-login");
            MessageBox.Show($"Could not change start at login: {ex.Message}", "WHB04B sidecar", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private static void OpenLogFolder()
    {
        Directory.CreateDirectory(AppPaths.LogDirectory);
        Process.Start(new ProcessStartInfo { FileName = AppPaths.LogDirectory, UseShellExecute = true });
    }

    private static Icon CreateStatusIcon(Color statusColor)
    {
        using var bitmap = new Bitmap(32, 32);
        using (var g = Graphics.FromImage(bitmap))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Color.Transparent);
            using var body = new SolidBrush(Color.FromArgb(45, 45, 50));
            g.FillRectangle(body, 7, 1, 18, 30);
            using var screen = new SolidBrush(Color.FromArgb(150, 200, 230));
            g.FillRectangle(screen, 10, 4, 12, 7);
            using var status = new SolidBrush(statusColor);
            g.FillEllipse(status, 9, 15, 14, 14);
        }

        var handle = bitmap.GetHicon();
        try
        {
            // Clone so the Icon owns its handle and the GDI icon from GetHicon can be released right away.
            using var temporary = Icon.FromHandle(handle);
            return (Icon)temporary.Clone();
        }
        finally
        {
            DestroyIcon(handle);
        }
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DestroyIcon(IntPtr handle);
}
