# Claude Instance Manager

<p align="center">
  <img src="Assets/claude-instance-manager.png" width="160" alt="Claude Instance Manager icon">
</p>

Windows desktop app for running isolated Claude Desktop profiles. The application is built with Electron, React, and TypeScript; Windows-specific operations run through a safe main-process adapter.

> This is an unofficial community tool and is not affiliated with Anthropic.

<p align="center">
  <img src="Assets/screenshots/instances-overview.png" alt="Claude Instance Manager instances overview" width="960">
</p>

## Support the project

If Claude Instance Manager is useful to you, you can support its development:

### Cryptocurrency

**USDT (TRC-20)**

```text
TUAyTkVoxEKnQ9qhykvUPfQN4vDswuVqhS
```

Please send USDT only through the TRC-20 network. Transfers sent over another network may be lost.

## Features

- Prepare a portable Claude Desktop copy from the installed MSIX package.
- Create, launch, stop, back up, and archive isolated profiles.
- Import local Claude Code, Cowork, extension, and preference data.
- Sign in to a selected instance through a recoverable temporary SSO profile junction.
- Manage instances from the application and system tray.

Each instance runs independently and receives a taskbar icon based on its selected colour.

<p align="center">
  <img src="Assets/screenshots/instance-taskbar-icons.png" alt="Colour-coded taskbar icons for independent Claude instances" width="180">
</p>

Create a profile with a name, colour, and optional Desktop or Start menu shortcuts.

<p align="center">
  <img src="Assets/screenshots/create-instance.png" alt="Create an isolated Claude instance" width="760">
</p>

## Requirements

- Windows 10 or Windows 11
- Official Claude Desktop installed from the Microsoft Store/MSIX package
- Administrator approval is required only to prepare or update the portable Claude copy, because it is copied from the protected `WindowsApps` folder.

## Local data

- Regular Claude profile: `%APPDATA%\Claude` or `%APPDATA%\Claude Code` (the former takes priority if both exist)
- Isolated profiles: `%LOCALAPPDATA%\ClaudeInstanceManager\Profiles`
- Portable Claude and backups: `%LOCALAPPDATA%\ClaudeInstanceManager`

## Safety

- Starting SignIn closes all running Claude processes.
- Always choose **Restore** after completing SignIn, so the regular Claude profile returns to its original location.
- Back up profiles before testing imports or account changes.

macOS is intentionally not implemented yet: its Claude app installation, profile paths, and SSO behaviour need a dedicated platform adapter.
