using System.Runtime.InteropServices;

namespace Whb04bSidecar;

/// <summary>Where Console output from this GUI-subsystem exe ends up.</summary>
internal enum ConsoleOutput
{
    /// <summary>Nowhere visible (launched from Explorer or a console-less parent).</summary>
    None,

    /// <summary>stdout was redirected by the parent (pipe or file).</summary>
    Redirected,

    /// <summary>The launching terminal's console.</summary>
    ParentConsole,
}

internal enum ParentConsoleAttach
{
    Attached,
    Unavailable,
}

/// <summary>
/// A WinExe starts without a console. Headless runs attach to the parent's console whenever there is one, even
/// when stdout is redirected: being attached is what delivers Ctrl+C / Ctrl+Break / console close to the process
/// (they arrive as SIGINT / SIGTERM). Redirected std handles are kept by Windows on attach, so output still flows
/// to the pipe or file.
/// </summary>
internal static class NativeConsole
{
    private const int AttachParentProcess = -1;
    private const int StdOutputHandle = -11;
    private static readonly IntPtr InvalidHandleValue = new(-1);

    public static ConsoleOutput Output { get; private set; } = ConsoleOutput.None;

    public static void AttachToParent()
    {
        // Read before attaching: afterwards a missing stdout would be filled in with the console's.
        var stdoutBeforeAttach = GetStdHandle(StdOutputHandle);
        var attach = AttachConsole(AttachParentProcess) ? ParentConsoleAttach.Attached : ParentConsoleAttach.Unavailable;
        Output = Classify(stdoutBeforeAttach, attach);
    }

    /// <summary>GetStdHandle returns NULL when there is no handle and INVALID_HANDLE_VALUE (-1) on failure; both mean none.</summary>
    public static ConsoleOutput Classify(IntPtr stdoutBeforeAttach, ParentConsoleAttach attach)
    {
        if (stdoutBeforeAttach != IntPtr.Zero && stdoutBeforeAttach != InvalidHandleValue)
        {
            return ConsoleOutput.Redirected;
        }

        return attach == ParentConsoleAttach.Attached ? ConsoleOutput.ParentConsole : ConsoleOutput.None;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AttachConsole(int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int handle);
}
