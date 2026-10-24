# Windows build instructions

Before packaging, run the checks from `electron`:

```powershell
npm.cmd run typecheck
npm.cmd test
```

`npm test` runs the Node tests (`tests/*.test.cjs`, no Electron needed) and the TaskbarHelper payload checks (`taskbar-helper/tests`, a plain console runner so no NuGet package is required).

To look at the UI without Electron, run `npx vite --config vite.renderer-preview.config.mts` from `electron` and open `http://localhost:5173`. The renderer then uses `src/renderer/src/mock-manager.ts` instead of the preload bridge; query flags switch states: `?signin`, `?legacy`, `?portable`, `?router`, `?multi`, `?link`. The mock is never loaded in Electron.

Run the packaging command from `electron`:

```powershell
Get-Process -Name 'Claude Instance Manager','TaskbarHelper' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 5
npm.cmd run package:win
```

The pause matters: Electron's GPU and utility processes release `release\win-unpacked` a few seconds after the main process is stopped, and electron-builder fails with `EBUSY … rmdir win-unpacked` when it starts earlier.

`EBUSY … rmdir win-unpacked` with no manager running means another process holds that folder as its current directory: an Explorer window on it, or a Claude instance (with its `cmd.exe`/`claude.exe` children) that an older manager launched after being started from that folder. Since 1.1.0 every child is spawned with an explicit `cwd`, so only instances started by older builds can hold it; close them or wait for them to end.

Do not terminate `Claude.exe` before a build. Stopping `TaskbarHelper` ends an active Sign In relay or deep-link router; finish a Sign In first.

The only supported output folder is `electron\release`. A successful package produces:

- `electron\release\Claude Instance Manager Setup <V>.exe`
- `electron\release\win-unpacked\Claude Instance Manager.exe`

If the build cannot replace `electron\release\win-unpacked` because it is locked, stop the build and report the lock. Do not create or use a temporary, alternate, or random output folder. Do not retry until explicitly asked.

`dotnet publish` can warn about the unavailable NuGet source (`NU1801`/`NU1900`). These warnings are non-fatal when `TaskbarHelper` publishes and the packaging command completes successfully.

After packaging, do not launch the installer or the unpacked application. Launch either only when the user explicitly asks.
