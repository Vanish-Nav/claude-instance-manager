# Agent instructions

Read the relevant guide before changing or packaging the application:

- [Windows build](.project-guides/build.md) — before packaging.
- [Architecture and storage](.project-guides/architecture.md) — before changing profile storage, metadata, backups, archives, or shortcuts.
- [Sign In flow](.project-guides/sign-in.md) — before changing authentication, the deep-link relay or router, or Claude process handling.
- [Launching instances and the taskbar](.project-guides/runtime.md) — before changing install detection, launch arguments, taskbar grouping, icons, or TaskbarHelper.

Run `npm run typecheck` and `npm test` in `electron` after changes to the main process or the helper.
