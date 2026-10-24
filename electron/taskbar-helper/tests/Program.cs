var failures = 0;

void Check(string name, bool condition)
{
    Console.WriteLine($"{(condition ? "PASS" : "FAIL")} {name}");
    if (!condition)
    {
        failures += 1;
    }
}

var payload = "START\0C:\\Users\\me\0\"C:\\Program Files\\WindowsApps\\Claude_3.6556.2.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe\" \"claude://sso-callback?code=abc&state=xyz\"\0";
var parsed = RelayPayload.Parse(payload);
Check("payload cwd is the second part", parsed.Cwd == "C:\\Users\\me");
Check("payload command line is the third part", parsed.CommandLine == "\"C:\\Program Files\\WindowsApps\\Claude_3.6556.2.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe\" \"claude://sso-callback?code=abc&state=xyz\"");
Check("deep link is extracted without the surrounding quotes", RelayPayload.ExtractUrl(parsed.CommandLine) == "claude://sso-callback?code=abc&state=xyz");

var plain = RelayPayload.Parse("START\0D:\\\0\"C:\\Program Files\\WindowsApps\\Claude_3.6556.2.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe\" --some-flag\0");
Check("a plain launch has no deep link", RelayPayload.ExtractUrl(plain.CommandLine) == null);

var bare = RelayPayload.Parse("claude.exe claude://magic-link/token\0");
Check("a payload without separators is the whole command line", bare.Cwd == null && bare.CommandLine == "claude.exe claude://magic-link/token");
Check("bare payload still yields the link", RelayPayload.ExtractUrl(bare.CommandLine) == "claude://magic-link/token");

Check("upper-case scheme is accepted", RelayPayload.ExtractUrl("Claude.exe CLAUDE://code/session/1") == "CLAUDE://code/session/1");
Check("empty command line yields no link", RelayPayload.ExtractUrl(string.Empty) == null);
Check("link stops at whitespace", RelayPayload.ExtractUrl("x.exe claude://a/b --flag") == "claude://a/b");

Console.WriteLine(failures == 0 ? "All relay payload checks passed" : $"{failures} relay payload check(s) failed");
return failures == 0 ? 0 : 1;
