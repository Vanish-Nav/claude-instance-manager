# Windows build instructions

Run the packaging command from `electron`:

```powershell
Get-Process -Name 'Claude Instance Manager','TaskbarHelper' -ErrorAction SilentlyContinue | Stop-Process -Force
npm.cmd run package:win
```

Do not terminate `Claude.exe` before a build.

The only supported output folder is `electron\release`. A successful package produces:

- `electron\release\Claude Instance Manager Setup <V>.exe`
- `electron\release\win-unpacked\Claude Instance Manager.exe`

If the build cannot replace `electron\release\win-unpacked` because it is locked, stop the build and report the lock. Do not create or use a temporary, alternate, or random output folder. Do not retry until explicitly asked.

`dotnet publish` can warn about the unavailable NuGet source (`NU1801`/`NU1900`). These warnings are non-fatal when `TaskbarHelper` publishes and the packaging command completes successfully.

After packaging, do not launch the installer or the unpacked application. Launch either only when the user explicitly asks.
