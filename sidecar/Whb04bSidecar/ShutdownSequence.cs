using Microsoft.Extensions.Logging;
using Whb04bSidecar.Server;

namespace Whb04bSidecar;

/// <summary>
/// Stops the server and device exactly once, whichever path gets there first (Ctrl+C, console close, tray Quit),
/// and lets a console-close handler wait for it before Windows ends the process.
/// </summary>
internal sealed class ShutdownSequence(SidecarHost host, ILogger logger)
{
    /// <summary>How long a console-close handler waits; Windows terminates the process about 5 s after CTRL_CLOSE.</summary>
    public static readonly TimeSpan ConsoleCloseBudget = TimeSpan.FromSeconds(4.5);

    private readonly object _lock = new();
    private readonly ManualResetEventSlim _completed = new();
    private Phase _phase = Phase.NotStarted;

    private enum Phase
    {
        NotStarted,
        Running,
    }

    public void Run()
    {
        lock (_lock)
        {
            if (_phase != Phase.NotStarted)
            {
                return;
            }

            _phase = Phase.Running;
        }

        logger.LogInformation("Shutting down");
        try
        {
            Task.Run(() => host.DisposeAsync().AsTask()).GetAwaiter().GetResult();
            logger.LogInformation("Shutdown complete");
        }
        finally
        {
            _completed.Set();
        }
    }

    public void WaitForCompletion(TimeSpan budget) => _completed.Wait(budget);
}
