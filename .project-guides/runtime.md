# Portable runtime and taskbar

- Portable Claude is stored at `%LOCALAPPDATA%\ClaudeInstanceManager\Portable\Claude.exe`.
- Preparation copies the installed MSIX Claude app with a UAC-elevated fixed PowerShell/Robocopy command. Do not reintroduce `ExecutionPolicy Bypass` or leave temporary scripts behind.
- Each isolated instance launches portable Claude with `--user-data-dir=<profile-path>` and a per-profile `--app-user-model-id`.
- `TaskbarHelper.exe` applies the profile AppUserModelID, display name, and icon to the launched process. Preserve it when changing launch or taskbar behavior.
- The default profile uses Claude's embedded original icon. Color selection applies only to isolated profiles through packaged `Assets\claude-profile-<color>.ico` files.
- Avoid custom WinAPI window activation where possible. A second portable launch lets Claude's ProcessSingleton show its own hidden tray window.
- Before Sign In, validate that installed Claude and portable runtime represent the same four-part Windows version.
