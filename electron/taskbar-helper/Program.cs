using System.Diagnostics;
using System.Runtime.InteropServices;

if (args.Length >= 2 && args[0] == "--activate")
{
    var activationProcessIds = args.Skip(1)
        .Select(value => uint.TryParse(value, out var processId) ? processId : 0)
        .Where(processId => processId != 0)
        .ToHashSet();
    // A Claude window hidden in its tray is no longer exposed as the main
    // window by .NET. Inspect all profile processes and choose the most
    // likely application window before considering hidden utility windows.
    var window = FindWindows(activationProcessIds, false).FirstOrDefault();
    if (window == IntPtr.Zero) window = FindWindows(activationProcessIds, true).FirstOrDefault();
    if (window != IntPtr.Zero) ActivateWindow(window);
    return;
}

if (args.Length < 2 || !uint.TryParse(args[0], out var processId)) return;

var appUserModelId = args[1];
var displayName = args.Length > 2 ? args[2] : appUserModelId;
var iconPath = args.Length > 3 ? args[3] : null;
var iconApplied = new HashSet<nint>();
while (IsProcessRunning(processId))
{
    foreach (var window in FindWindows(new HashSet<uint> { processId }, false))
    {
        SetTaskbarProperties(window, appUserModelId, displayName, iconPath);
        if (iconPath is not null && iconApplied.Add(window)) SetWindowIcon(window, iconPath);
    }
    Thread.Sleep(1500);
}

static bool IsProcessRunning(uint processId)
{
    try { return !Process.GetProcessById((int)processId).HasExited; }
    catch { return false; }
}

static IEnumerable<nint> FindWindows(ISet<uint> processIds, bool includeHidden)
{
    var windows = new List<(nint Handle, int Score)>();
    NativeMethods.EnumWindows((window, _) =>
    {
        NativeMethods.GetWindowThreadProcessId(window, out var ownerProcessId);
        if (!processIds.Contains(ownerProcessId) || (!includeHidden && !NativeMethods.IsWindowVisible(window)) || NativeMethods.GetWindow(window, 4) != IntPtr.Zero) return true;
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

static void SetTaskbarProperties(nint window, string appUserModelId, string displayName, string? iconPath)
{
    var iid = typeof(IPropertyStore).GUID;
    if (NativeMethods.SHGetPropertyStoreForWindow(window, ref iid, out var pointer) < 0 || pointer == IntPtr.Zero) return;
    try
    {
        var store = (IPropertyStore)Marshal.GetObjectForIUnknown(pointer);
        if (iconPath is not null) SetString(store, new PropertyKey("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3", 3), $"{iconPath},0");
        SetString(store, new PropertyKey("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3", 4), displayName);
        SetString(store, new PropertyKey("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3", 5), appUserModelId);
        store.Commit();
    }
    finally { Marshal.Release(pointer); }
}

static void SetWindowIcon(nint window, string iconPath)
{
    var icon = NativeMethods.LoadImage(IntPtr.Zero, iconPath, 1, 0, 0, 0x10);
    if (icon == IntPtr.Zero) return;
    NativeMethods.SendMessage(window, 0x0080, (IntPtr)0, icon);
    NativeMethods.SendMessage(window, 0x0080, (IntPtr)1, icon);
}

static void ActivateWindow(nint window)
{
    var foreground = NativeMethods.GetForegroundWindow();
    var currentThread = NativeMethods.GetCurrentThreadId();
    var foregroundThread = foreground == IntPtr.Zero ? 0 : NativeMethods.GetWindowThreadProcessId(foreground, out _);
    if (foregroundThread != 0 && foregroundThread != currentThread) NativeMethods.AttachThreadInput(currentThread, foregroundThread, true);
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
        if (foregroundThread != 0 && foregroundThread != currentThread) NativeMethods.AttachThreadInput(currentThread, foregroundThread, false);
    }
}

static void SetString(IPropertyStore store, PropertyKey key, string value)
{
    var variant = PropVariant.FromString(value);
    try { store.SetValue(ref key, ref variant); }
    finally { variant.Dispose(); }
}

[StructLayout(LayoutKind.Sequential, Pack = 4)]
struct PropertyKey
{
    public Guid FormatId;
    public uint PropertyId;
    public PropertyKey(string formatId, uint propertyId) { FormatId = new Guid(formatId); PropertyId = propertyId; }
}

[StructLayout(LayoutKind.Explicit)]
struct PropVariant
{
    [FieldOffset(0)] public ushort VariantType;
    [FieldOffset(8)] public IntPtr Pointer;
    public static PropVariant FromString(string value) => new() { VariantType = 31, Pointer = Marshal.StringToCoTaskMemUni(value) };
    public void Dispose() { if (Pointer != IntPtr.Zero) Marshal.FreeCoTaskMem(Pointer); Pointer = IntPtr.Zero; }
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
    [DllImport("shell32.dll")]
    internal static extern int SHGetPropertyStoreForWindow(nint window, ref Guid iid, out IntPtr propertyStore);
    [DllImport("user32.dll")]
    internal static extern bool EnumWindows(EnumWindowsProc callback, nint parameter);
    [DllImport("user32.dll")]
    internal static extern uint GetWindowThreadProcessId(nint window, out uint processId);
    [DllImport("user32.dll")]
    internal static extern bool IsWindowVisible(nint window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    internal static extern int GetWindowTextLength(nint window);
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
}

[StructLayout(LayoutKind.Sequential)]
struct Rect
{
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
}
