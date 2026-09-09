# Architecture and storage

- The product is Electron-only. The legacy Windows project is not part of the supported application path.
- The primary Claude profile may be `%APPDATA%\Claude` or `%APPDATA%\Claude Code` and is shown as **Claude** with the `PRIMARY` badge. If both exist, prefer `%APPDATA%\Claude`.
- Isolated profiles are stored at `%LOCALAPPDATA%\ClaudeInstanceManager\Profiles\CIM-Profile-<GUID>`.
- A profile folder name is immutable. Display name and color are stored in `instance.json` in the profile root so renaming does not break paths or shortcuts.
- Instance names accept up to 20 English letters, digits, and spaces. Name collisions are resolved or rejected by the profile-management flow.
- Backups are under `%LOCALAPPDATA%\ClaudeInstanceManager\Backups\<profile-id>\<timestamp>`.
- Archives are under `%LOCALAPPDATA%\ClaudeInstanceManager\Archives\<profile-id>\<timestamp>`.
- Backups and archives contain complete Claude profile data, including potentially active sign-in sessions. Treat them as sensitive.
- Installer uninstall must never delete `%LOCALAPPDATA%\ClaudeInstanceManager` or its profiles, backups, and archives.
