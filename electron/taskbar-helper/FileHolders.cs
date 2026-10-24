using System.Runtime.InteropServices;

/// <summary>
/// Names the processes that keep a file open, through the Restart Manager.
/// Used to explain why a folder could not be removed.
/// </summary>
public static class FileHolders
{
    [StructLayout(LayoutKind.Sequential)]
    private struct UniqueProcess
    {
        public int ProcessId;
        public System.Runtime.InteropServices.ComTypes.FILETIME StartTime;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessInfo
    {
        public UniqueProcess Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string AppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string ServiceShortName;
        public int ApplicationType;
        public uint AppStatus;
        public uint SessionId;
        [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
    }

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    private static extern int RmStartSession(out uint session, int flags, string key);
    [DllImport("rstrtmgr.dll")]
    private static extern int RmEndSession(uint session);
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    private static extern int RmRegisterResources(uint session, uint fileCount, string[] files, uint applicationCount, UniqueProcess[]? applications, uint serviceCount, string[]? services);
    [DllImport("rstrtmgr.dll")]
    private static extern int RmGetList(uint session, out uint needed, ref uint count, [In, Out] ProcessInfo[]? processes, ref uint rebootReasons);

    /// <summary>
    /// Prints one <c>pid\tname</c> line per holder of each given file; exit code 0.
    /// </summary>
    public static int Print(IEnumerable<string> files)
    {
        foreach (var file in files)
        {
            foreach (var (processId, name) in Holders(file))
            {
                Console.Out.WriteLine($"{processId}\t{name}");
            }
        }
        Console.Out.Flush();
        return 0;
    }

    private static List<(int ProcessId, string Name)> Holders(string file)
    {
        var result = new List<(int, string)>();
        if (RmStartSession(out var session, 0, Guid.NewGuid().ToString()) != 0)
        {
            return result;
        }
        try
        {
            if (RmRegisterResources(session, 1, new[] { file }, 0, null, 0, null) != 0)
            {
                return result;
            }
            uint count = 0;
            uint reasons = 0;
            if (RmGetList(session, out var needed, ref count, null, ref reasons) != 0 && needed == 0)
            {
                return result;
            }
            var processes = new ProcessInfo[needed];
            count = needed;
            if (RmGetList(session, out needed, ref count, processes, ref reasons) != 0)
            {
                return result;
            }
            for (var index = 0; index < count; index += 1)
            {
                result.Add((processes[index].Process.ProcessId, processes[index].AppName));
            }
            return result;
        }
        finally
        {
            RmEndSession(session);
        }
    }
}
