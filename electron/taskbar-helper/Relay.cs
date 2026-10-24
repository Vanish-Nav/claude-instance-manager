using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

/// <summary>
/// Owns a Chromium-style single-instance message window titled with a Claude
/// data folder. Any Claude.exe started for that folder (including the packaged
/// handler of a claude:// link) hands its command line to this window and
/// exits instead of starting, which lets the manager deliver the link to an
/// isolated instance.
/// </summary>
public sealed class Relay
{
    private const string MessageWindowClass = "Chrome_MessageWindow";
    private const uint WmCopyData = 0x004A;
    private const uint WmTimer = 0x0113;
    private const uint MessageFilterAllow = 1;
    private static readonly IntPtr MessageOnlyParent = new(-3);

    private readonly string title;
    private readonly string? launchTarget;
    private readonly string? profileDirectory;
    private readonly int parentProcessId;
    private readonly bool forwardLinks;
    private NativeMethods.WndProc? windowProcedure;
    private IntPtr window;
    private bool stopped;

    private Relay(string title, string? launchTarget, string? profileDirectory, int parentProcessId, bool forwardLinks)
    {
        this.title = title;
        this.launchTarget = launchTarget;
        this.profileDirectory = profileDirectory;
        this.parentProcessId = parentProcessId;
        this.forwardLinks = forwardLinks;
    }

    /// <summary>
    /// Sign In relay: forwards every claude:// link to the isolated instance and,
    /// on a plain launch, starts the primary Claude normally and ends.
    /// </summary>
    public static int RunSignInRelay(string title, string launchTarget, string profileDirectory, int parentProcessId)
    {
        return new Relay(title, launchTarget, profileDirectory, parentProcessId, true).Run();
    }

    /// <summary>
    /// Router: reports links and launches to the manager on stdout and lets the
    /// manager decide where they go. Ends when the parent manager exits.
    /// </summary>
    public static int RunRouter(string title, int parentProcessId)
    {
        return new Relay(title, null, null, parentProcessId, false).Run();
    }

    /// <summary>
    /// Prints the title of the single-instance window owned by one of the given
    /// processes. Message-only windows are not enumerated by EnumWindows.
    /// </summary>
    public static int PrintSingletonTitle(ISet<uint> processIds)
    {
        var current = IntPtr.Zero;
        while ((current = NativeMethods.FindWindowExW(MessageOnlyParent, current, MessageWindowClass, null)) != IntPtr.Zero)
        {
            NativeMethods.GetWindowThreadProcessId(current, out var owner);
            if (!processIds.Contains(owner))
            {
                continue;
            }
            // Chromium owns several message windows of this class; only the
            // single-instance one carries the data folder as its title.
            var text = new StringBuilder(2048);
            NativeMethods.GetWindowTextW(current, text, text.Capacity);
            if (text.Length == 0)
            {
                continue;
            }
            Console.Out.WriteLine(text.ToString());
            Console.Out.Flush();
            return 0;
        }
        return 1;
    }

    private int Run()
    {
        windowProcedure = WindowProcedure;
        var windowClass = new NativeMethods.WndClassEx
        {
            cbSize = (uint)Marshal.SizeOf<NativeMethods.WndClassEx>(),
            lpfnWndProc = windowProcedure,
            hInstance = NativeMethods.GetModuleHandleW(null),
            lpszClassName = MessageWindowClass,
        };
        if (NativeMethods.RegisterClassExW(ref windowClass) == 0)
        {
            Report("ERROR", $"RegisterClassEx failed with {Marshal.GetLastWin32Error()}");
            return 2;
        }
        window = NativeMethods.CreateWindowExW(0, MessageWindowClass, title, 0, 0, 0, 0, 0, MessageOnlyParent, IntPtr.Zero, windowClass.hInstance, IntPtr.Zero);
        if (window == IntPtr.Zero)
        {
            Report("ERROR", $"CreateWindowEx failed with {Marshal.GetLastWin32Error()}");
            return 2;
        }
        // The sender runs at the same integrity level, but UIPI still filters
        // WM_COPYDATA from a packaged (AppContainer-adjacent) process.
        NativeMethods.ChangeWindowMessageFilterEx(window, WmCopyData, MessageFilterAllow, IntPtr.Zero);
        if (parentProcessId > 0)
        {
            NativeMethods.SetTimer(window, (UIntPtr)1, 2000, IntPtr.Zero);
        }
        Report("READY", title);
        while (NativeMethods.GetMessageW(out var message, IntPtr.Zero, 0, 0))
        {
            NativeMethods.TranslateMessage(ref message);
            NativeMethods.DispatchMessageW(ref message);
        }
        NativeMethods.DestroyWindow(window);
        return 0;
    }

    private IntPtr WindowProcedure(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam)
    {
        if (message == WmCopyData)
        {
            var data = Marshal.PtrToStructure<NativeMethods.CopyDataStruct>(lParam);
            var raw = Marshal.PtrToStringUni(data.lpData, data.cbData / 2) ?? string.Empty;
            HandleMessage(RelayPayload.Parse(raw));
            return (IntPtr)1;
        }
        if (message == WmTimer && parentProcessId > 0 && !IsProcessRunning(parentProcessId))
        {
            Report("PARENT-EXITED", parentProcessId.ToString());
            Stop();
            return IntPtr.Zero;
        }
        return NativeMethods.DefWindowProcW(handle, message, wParam, lParam);
    }

    private void HandleMessage(RelayMessage message)
    {
        var url = RelayPayload.ExtractUrl(message.CommandLine);
        if (url is not null)
        {
            Report("URL", url);
            if (forwardLinks && launchTarget is not null && profileDirectory is not null)
            {
                Start(launchTarget, new[] { $"--user-data-dir={profileDirectory}", url });
            }
            return;
        }
        // A plain launch means the user opened Claude itself. Give the data
        // folder back: the window must be gone before the primary starts.
        var arguments = ArgumentsAfterExecutable(message.CommandLine);
        Report("LAUNCH", string.Join(" ", arguments));
        Stop();
        if (forwardLinks && launchTarget is not null)
        {
            Start(launchTarget, arguments);
        }
    }

    private void Stop()
    {
        if (stopped)
        {
            return;
        }
        stopped = true;
        NativeMethods.DestroyWindow(window);
        NativeMethods.PostQuitMessage(0);
    }

    private static void Start(string target, IReadOnlyList<string> arguments)
    {
        try
        {
            var info = new ProcessStartInfo { FileName = target, UseShellExecute = false };
            foreach (var argument in arguments)
            {
                info.ArgumentList.Add(argument);
            }
            Process.Start(info);
        }
        catch (Exception error)
        {
            Report("ERROR", error.Message);
        }
    }

    private static string[] ArgumentsAfterExecutable(string commandLine)
    {
        if (string.IsNullOrWhiteSpace(commandLine))
        {
            return Array.Empty<string>();
        }
        var argv = NativeMethods.CommandLineToArgvW(commandLine, out var count);
        if (argv == IntPtr.Zero)
        {
            return Array.Empty<string>();
        }
        try
        {
            var result = new List<string>();
            for (var index = 1; index < count; index += 1)
            {
                var value = Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv, index * IntPtr.Size));
                if (value is not null)
                {
                    result.Add(value);
                }
            }
            return result.ToArray();
        }
        finally
        {
            NativeMethods.LocalFree(argv);
        }
    }

    private static bool IsProcessRunning(int processId)
    {
        try
        {
            return !Process.GetProcessById(processId).HasExited;
        }
        catch
        {
            return false;
        }
    }

    private static void Report(string kind, string value)
    {
        try
        {
            Console.Out.WriteLine($"{kind}\t{value}");
            Console.Out.Flush();
        }
        catch (IOException)
        {
            // The manager that read this pipe has exited; the relay keeps working.
        }
    }
}
