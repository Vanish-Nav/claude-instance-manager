# Sign In flow

## Why a relay

- Every browser login callback (`claude://sso-callback`, `claude://magic-link`, Google) and every other deep link (`mcp-auth-callback`, `claude://code/...`) is resolved by Windows to the packaged handler, regardless of the classic `HKCU\Software\Classes\claude` key. The spawned `Claude.exe "claude://..."` has no `--user-data-dir`, so it always addresses the primary profile.
- Electron's single-instance lock on Windows is a message-only window of class `Chrome_MessageWindow` whose title is the data folder path. A process started for that folder looks the window up, sends its command line through `WM_COPYDATA` (`START\0<cwd>\0<command line>\0`, UTF-16) and exits when the owner returns `TRUE`. Whoever owns that window receives the link.
- The manager therefore never moves profile folders. During Sign In, `TaskbarHelper.exe --relay <title> <launch target> <profile dir>` owns the primary's window title and forwards each `claude://` link as `<launch target> --user-data-dir=<profile dir> <url>` to the selected instance, which treats it like its own second launch.

## Flow (`WindowsAdapter.beginSignIn`)

1. Refuse while a Sign In is active, or while a legacy `sso-state.json` is waiting for recovery.
2. If the primary Claude runs: read the title of its live single-instance window (`TaskbarHelper --singleton-title <pids>`), fall back to `WindowsProfilePaths.primary()`. Without `closePrimary` the call fails with `primaryRunningMessage` and the UI offers a graceful close; with it the primary is closed (WM_CLOSE first, force after a wait).
3. Remember the title in `settings.json` (`lastPrimaryDataPath`); it is reused when the primary is not running and by the deep-link router.
4. Start the selected instance if it is not running. Stop the deep-link router if it holds the title.
5. Start the relay detached, wait for its `READY` line (5 s), store `sign-in-state.json` (`profileId`, `profileName`, `relayProcessId`, `title`, `startedAtUtc`).
6. The user signs in inside the instance. Other isolated instances keep running; nothing is moved.
7. `finishSignIn` kills the relay (only if that pid is still a `TaskbarHelper.exe`) and removes the state file. A plain launch of the primary Claude (its Start menu tile) also ends the relay: the relay destroys its window first, then starts the primary with the received arguments through the launch target. `getState` drops a state file whose relay is gone.

## Legacy recovery

- Versions before 1.1 swapped the selected profile into the primary location. `restoreSso` only recovers an existing `%LOCALAPPDATA%\ClaudeInstanceManager\sso-state.json` of `mode: 'swap'`: it refuses while any `Claude.exe` runs, finds the temporary profile by its `.cim-sign-in` token across the known locations, moves it back and restores the regular profile from its backup. Junction-based states are refused with instructions. Do not create new swap states and do not delete recovery data automatically.
- A pending legacy recovery blocks new Sign Ins and is shown as a notice and a tray entry.

## Deep-link router (optional, `settings.json: deepLinkRouter`)

- `TaskbarHelper.exe --router <title> --parent <manager pid>` owns the primary's window title permanently while the primary Claude is not running and reports `URL\t<link>` / `LAUNCH\t<args>` on stdout; it ends when the manager exits. The manager delivers a link to the last instance opened through the manager if it runs, otherwise to the only running instance, otherwise it shows a picker.
- In router mode the primary profile is a managed instance: the manager stops the router and starts `<launch target> --user-data-dir=<lastPrimaryDataPath>`. While the primary runs it owns its own window, so links open there as they always did; the router returns once it exits (checked on the 10 s tick).
- The mode only works while the manager runs; the UI warns to enable Launch at Login.

## Manual checks

- A real SSO login (and a magic-link login) must be tested by hand on a test account after each change here and after a Claude Desktop update: the relay was verified with a synthetic `claude://` link through the real alias, not with a live identity provider.
