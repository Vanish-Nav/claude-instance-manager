using System.Diagnostics;
using System.Runtime.InteropServices;

if (args.Length >= 2 && args[0] == "--activate")
{
    var activationProcessIds = ParseProcessIds(args.Skip(1));
    // A Claude window hidden in its tray is no longer exposed as the main
    // window by .NET. Inspect all profile processes and choose the most
    // likely application window before considering hidden utility windows.
    var window = FindWindows(activationProcessIds, false).FirstOrDefault();
    if (window == IntPtr.Zero)
    {
        window = FindWindows(activationProcessIds, true).FirstOrDefault();
    }
    if (window != IntPtr.Zero)
    {
        ActivateWindow(window);
    }
    return 0;
}

if (args.Length >= 2 && args[0] == "--singleton-title")
{
    return Relay.PrintSingletonTitle(ParseProcessIds(args.Skip(1)));
}

if (args.Length >= 2 && args[0] == "--file-holders")
{
    return FileHolders.Print(args.Skip(1));
}

if (args.Length >= 4 && args[0] == "--relay")
{
    return Relay.RunSignInRelay(args[1], args[2], args[3], OptionValue(args, "--parent"));
}

if (args.Length >= 2 && args[0] == "--router")
{
    return Relay.RunRouter(args[1], OptionValue(args, "--parent"));
}

if (args.Length < 2 || !uint.TryParse(args[0], out var processId))
{
    return 1;
}

var appUserModelId = args[1];
var displayName = args.Length > 2 ? args[2] : appUserModelId;
var iconPath = args.Length > 3 && args[3].Length > 0 ? args[3] : null;
var relaunchCommand = args.Length > 4 && args[4].Length > 0 ? args[4] : null;
var iconApplied = new HashSet<nint>();
while (IsProcessRunning(processId))
{
    foreach (var window in FindWindows(new HashSet<uint> { processId }, false))
    {
        SetTaskbarProperties(window, appUserModelId, displayName, iconPath, relaunchCommand);
        if (iconPath is not null && iconApplied.Add(window))
        {
            SetWindowIcon(window, iconPath);
        }
    }
    Thread.Sleep(1500);
}
return 0;

static HashSet<uint> ParseProcessIds(IEnumerable<string> values)
{
    return values
        .Select(value => uint.TryParse(value, out var processId) ? processId : 0)
        .Where(processId => processId != 0)
        .ToHashSet();
}

static int OptionValue(string[] arguments, string name)
{
    var index = Array.IndexOf(arguments, name);
    return index >= 0 && index + 1 < arguments.Length && int.TryParse(arguments[index + 1], out var value) ? value : 0;
}

static bool IsProcessRunning(uint processId)
{
    try
    {
        return !Process.GetProcessById((int)processId).HasExited;
    }
    catch
    {
        return false;
    }
}

static IEnumerable<nint> FindWindows(ISet<uint> processIds, bool includeHidden)
{
    var windows = new List<(nint Handle, int Score)>();
    NativeMethods.EnumWindows((window, _) =>
    {
        NativeMethods.GetWindowThreadProcessId(window, out var ownerProcessId);
        if (!processIds.Contains(ownerProcessId) || (!includeHidden && !NativeMethods.IsWindowVisible(window)) || NativeMethods.GetWindow(window, 4) != IntPtr.Zero)
        {
            return true;
        }
        var titleLength = NativeMethods.GetWindowTextLength(window);
        NativeMethods.GetWindowRect(window, out var bounds);
        var area = Math.Max(0, bounds.Right - bounds.Left) * Math.Max(0, bounds.Bottom - bounds.Top);
        // Claude's user-facing window has a title and a meaningful size;
        // empty Chromium utility windows score below it.
        windows.Add((window, (titleLength > 0 ? 1_000_000_000 : 0) + area));
        return true;
    }, IntPtr.Zero);
    return windows.OrderByDescending(window => window.Score).Select(window => window.Handle);
}

static void SetTaskbarProperties(nint window, string appUserModelId, string displayName, string? iconPath, string? relaunchCommand)
{
    var iid = typeof(IPropertyStore).GUID;
    if (NativeMethods.SHGetPropertyStoreForWindow(window, ref iid, out var pointer) < 0 || pointer == IntPtr.Zero)
    {
        return;
    }
    try
    {
        var store = (IPropertyStore)Marshal.GetObjectForIUnknown(pointer);
        // System.AppUserModel: 2 RelaunchCommand, 3 RelaunchIconResource,
        // 4 RelaunchDisplayNameResource, 5 ID. The relaunch command is what a
        // pinned taskbar button starts; the shell rejects values over 259 chars.
        if (relaunchCommand is not null)
        {
            SetString(store, new PropertyKey("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3", 2), relaunchCommand);
        }
        if (iconPath is not null)
        {
            SetString(store, new PropertyKey("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3", 3), $"{iconPath},0");
        }
        SetString(store, new PropertyKey("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3", 4), displayName);
        SetString(store, new PropertyKey("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3", 5), appUserModelId);
        store.Commit();
    }
    finally
    {
        Marshal.Release(pointer);
    }
}

static void SetWindowIcon(nint window, string iconPath)
{
    var icon = NativeMethods.LoadImage(IntPtr.Zero, iconPath, 1, 0, 0, 0x10);
    if (icon == IntPtr.Zero)
    {
        return;
    }
    NativeMethods.SendMessage(window, 0x0080, (IntPtr)0, icon);
    NativeMethods.SendMessage(window, 0x0080, (IntPtr)1, icon);
}

static void ActivateWindow(nint window)
{
    var foreground = NativeMethods.GetForegroundWindow();
    var currentThread = NativeMethods.GetCurrentThreadId();
    var foregroundThread = foreground == IntPtr.Zero ? 0 : NativeMethods.GetWindowThreadProcessId(foreground, out _);
    var attached = foregroundThread != 0 && foregroundThread != currentThread;
    if (attached)
    {
        NativeMethods.AttachThreadInput(currentThread, foregroundThread, true);
    }
    try
    {
        // Claude's "Close to tray" hides its window rather than minimizing
        // it. SW_RESTORE alone does not reliably unhide such a window.
        NativeMethods.ShowWindowAsync(window, 5);
        NativeMethods.ShowWindowAsync(window, 9);
        NativeMethods.BringWindowToTop(window);
        // A brief topmost promotion bypasses Windows foreground restrictions
        // for this user-initiated tray/Manager action.
        NativeMethods.SetWindowPos(window, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040);
        NativeMethods.SetWindowPos(window, new IntPtr(-2), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040);
        NativeMethods.SetForegroundWindow(window);
    }
    finally
    {
        if (attached)
        {
            NativeMethods.AttachThreadInput(currentThread, foregroundThread, false);
        }
    }
}

static void SetString(IPropertyStore store, PropertyKey key, string value)
{
    var variant = PropVariant.FromString(value);
    try
    {
        store.SetValue(ref key, ref variant);
    }
    catch (COMException error)
    {
        // One property the shell refuses (for example a value too long for
        // this window's store) must not end the whole identity loop.
        Console.Error.WriteLine($"property {key.PropertyId} ({value.Length} chars) rejected: 0x{error.HResult:X8}");
    }
    finally
    {
        variant.Dispose();
    }
}

[StructLayout(LayoutKind.Sequential, Pack = 4)]
struct PropertyKey
{
    public Guid FormatId;
    public uint PropertyId;
    public PropertyKey(string formatId, uint propertyId)
    {
        FormatId = new Guid(formatId);
        PropertyId = propertyId;
    }
}

[StructLayout(LayoutKind.Explicit)]
struct PropVariant
{
    [FieldOffset(0)] public ushort VariantType;
    [FieldOffset(8)] public IntPtr Pointer;
    public static PropVariant FromString(string value) => new() { VariantType = 31, Pointer = Marshal.StringToCoTaskMemUni(value) };
    public void Dispose()
    {
        if (Pointer != IntPtr.Zero)
        {
            Marshal.FreeCoTaskMem(Pointer);
        }
        Pointer = IntPtr.Zero;
    }
}

[ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropertyStore
{
    int GetCount(out uint count);
    int GetAt(uint index, out PropertyKey key);
    int GetValue(ref PropertyKey key, out PropVariant value);
    int SetValue(ref PropertyKey key, ref PropVariant value);
    int Commit();
}

delegate bool EnumWindowsProc(nint window, nint parameter);

static class NativeMethods
{
    internal delegate IntPtr WndProc(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct WndClassEx
    {
        public uint cbSize;
        public uint style;
        public WndProc lpfnWndProc;
        public int cbClsExtra;
        public int cbWndExtra;
        public IntPtr hInstance;
        public IntPtr hIcon;
        public IntPtr hCursor;
        public IntPtr hbrBackground;
        public string? lpszMenuName;
        public string lpszClassName;
        public IntPtr hIconSm;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct CopyDataStruct
    {
        public IntPtr dwData;
        public int cbData;
        public IntPtr lpData;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct Message
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public int x;
        public int y;
    }

    [DllImport("shell32.dll")]
    internal static extern int SHGetPropertyStoreForWindow(nint window, ref Guid iid, out IntPtr propertyStore);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    internal static extern IntPtr CommandLineToArgvW(string commandLine, out int count);
    [DllImport("kernel32.dll")]
    internal static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    internal static extern IntPtr GetModuleHandleW(string? name);
    [DllImport("user32.dll")]
    internal static extern bool EnumWindows(EnumWindowsProc callback, nint parameter);
    [DllImport("user32.dll")]
    internal static extern uint GetWindowThreadProcessId(nint window, out uint processId);
    [DllImport("user32.dll")]
    internal static extern bool IsWindowVisible(nint window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    internal static extern int GetWindowTextLength(nint window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    internal static extern int GetWindowTextW(IntPtr window, System.Text.StringBuilder text, int capacity);
    [DllImport("user32.dll")]
    internal static extern bool GetWindowRect(nint window, out Rect rectangle);
    [DllImport("user32.dll")]
    internal static extern nint GetWindow(nint window, uint command);
    [DllImport("user32.dll")]
    internal static extern bool ShowWindowAsync(nint window, int command);
    [DllImport("user32.dll")]
    internal static extern bool SetForegroundWindow(nint window);
    [DllImport("user32.dll")]
    internal static extern nint GetForegroundWindow();
    [DllImport("kernel32.dll")]
    internal static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")]
    internal static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
    [DllImport("user32.dll")]
    internal static extern bool BringWindowToTop(nint window);
    [DllImport("user32.dll")]
    internal static extern bool SetWindowPos(nint window, nint insertAfter, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    internal static extern IntPtr LoadImage(IntPtr instance, string name, uint type, int width, int height, uint flags);
    [DllImport("user32.dll")]
    internal static extern IntPtr SendMessage(nint window, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    internal static extern ushort RegisterClassExW(ref WndClassEx windowClass);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    internal static extern IntPtr CreateWindowExW(uint exStyle, string className, string windowName, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    internal static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string? className, string? windowName);
    [DllImport("user32.dll", SetLastError = true)]
    internal static extern bool ChangeWindowMessageFilterEx(IntPtr window, uint message, uint action, IntPtr changeFilterStruct);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    internal static extern IntPtr DefWindowProcW(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    internal static extern bool GetMessageW(out Message message, IntPtr window, uint filterMin, uint filterMax);
    [DllImport("user32.dll")]
    internal static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll")]
    internal static extern IntPtr DispatchMessageW(ref Message message);
    [DllImport("user32.dll")]
    internal static extern void PostQuitMessage(int exitCode);
    [DllImport("user32.dll")]
    internal static extern bool DestroyWindow(IntPtr window);
    [DllImport("user32.dll")]
    internal static extern UIntPtr SetTimer(IntPtr window, UIntPtr id, uint elapse, IntPtr timerProcedure);
}

[StructLayout(LayoutKind.Sequential)]
struct Rect
{
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
}
