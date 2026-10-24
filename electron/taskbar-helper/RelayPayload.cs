using System.Text.RegularExpressions;

/// <summary>
/// Pure helpers for the command line that a second Claude instance hands over
/// through WM_COPYDATA when it finds the single-instance message window.
/// </summary>
public static class RelayPayload
{
    private static readonly Regex UrlToken = new(@"claude://[^\s""']*", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    /// <summary>
    /// Splits the UTF-16 payload <c>START\0&lt;cwd&gt;\0&lt;command line&gt;\0</c>
    /// into its working directory and command line parts.
    /// </summary>
    public static RelayMessage Parse(string raw)
    {
        var parts = raw.Split('\0');
        if (parts.Length > 2)
        {
            return new RelayMessage { Cwd = parts[1], CommandLine = parts[2] };
        }
        return new RelayMessage { Cwd = null, CommandLine = raw.TrimEnd('\0') };
    }

    /// <summary>
    /// Returns the first claude:// link on the command line, or null when the
    /// launch carried no deep link.
    /// </summary>
    public static string? ExtractUrl(string commandLine)
    {
        var match = UrlToken.Match(commandLine);
        return match.Success ? match.Value : null;
    }
}

public sealed class RelayMessage
{
    public string? Cwd { get; init; }
    public string CommandLine { get; init; } = string.Empty;
}
