# Sign In flow

- Sign In for an isolated instance temporarily swaps that instance into `%APPDATA%\Claude`, because browser email and SSO callbacks are registered to the official MSIX Claude app.
- Before Sign In, all Claude processes are closed and the regular `%APPDATA%\Claude` profile is moved to a temporary recovery backup.
- The selected instance is moved to `%APPDATA%\Claude`, then official Claude starts for email, code, or SSO authentication.
- After authentication, the user must select **Quit** in Claude's tray menu. Do not force-close Claude during Finish & Restore: Claude needs a normal shutdown to persist the new session.
- Finish & Restore must refuse to move folders while any `Claude.exe` process is running. Once Claude has quit, move the temporary `%APPDATA%\Claude` folder back to the selected instance and restore the regular profile.
- An active Sign In flow locks other profiles and shows only Continue Sign In or Finish & Restore. Keep the recovery state in `%LOCALAPPDATA%\ClaudeInstanceManager\sso-state.json` until restoration is complete.
- Preserve compatibility recovery for an already-created legacy Sign In state; do not delete recovery data automatically.
