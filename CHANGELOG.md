# Changelog

## 1.1.1

### Fixed
- Renaming or recolouring an instance updates the icon and description of its taskbar pins (the pin label follows only after re-pinning).
- Shortcuts and taskbar pins created by a manager at another location (for example an unpacked build) are repointed at the installed manager on its first start; helpers with a stale relaunch command are restarted. Development builds never claim them.
- `Remove copy` of the old portable runtime no longer hangs on `app.asar`: the manager itself kept the archive open through Electron's asar support, which is now disabled in the main process.
- Minor dependency updates (React 19.3.1, Electron 43.8.3, electron-builder 26.18, lucide-react 1.61).

## 1.1.0

### Changed
- Instances start from the installed Claude Desktop through its App Execution Alias. The portable copy, its administrator prompt and the version check are gone; old shortcuts are rewritten on first start and the `Portable` folder is offered for deletion.
- Sign In no longer swaps profile folders. The manager takes over the primary Claude's single-instance window and forwards the browser login callback to the selected instance; other instances keep running and nothing is moved. A Sign In started by 1.0 is still finished with Finish & Restore.
- Backups come in tiers: session and chats, full profile without caches, and a settings export without secrets for another machine. Imports show which Code sessions will not open because their project folder is missing.
- The instance page is organised in Instance, Account, Data and Archive sections; the dashboard shows the Claude installation in the sidebar.

### Added
- Install detection for the direct MSIX package, the Microsoft Store package and the classic installer, by package family or publisher. With several installs the running one wins, then the owner of the `claude:` protocol.
- Copy settings or a whole session from the primary profile or another instance, choosing the Code projects and Cowork tasks to bring along. A session copy gets its own device id.
- Clean caches of a stopped instance with a per-folder size breakdown.
- Pinned taskbar buttons and shortcuts launch the instance through the manager, so the colour and name are kept.
- Optional deep-link router (Settings → General): while the primary Claude is closed, `claude://` links open in the instance you used last, or you are asked which one.
- Tests: `npm test` covers install detection, profile detection, backup tiers, Sign In state and the relay payload parser.

### Fixed
- A failed PowerShell query is no longer reported as "Claude is running", and a missing installation is never cached until the next refresh.
- Closing an instance asks it to close first and forces only after a wait.
- Two backups within one second no longer share a folder.
- Renaming an instance refreshes its taskbar name.
