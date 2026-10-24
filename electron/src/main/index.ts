import { app, BrowserWindow, ipcMain, Menu, Tray } from 'electron'
import path from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { WindowsAdapter } from './windows-adapter'
import { UnsupportedAdapter } from './unsupported-adapter'
import type { PlatformAdapter } from './platform'
import type { ManagerState, StartupSettings } from '../shared/contracts'

// Electron's fs patch treats any foreign `app.asar` as a directory: walking or
// removing the old portable copy opened its archive and kept the handle, so
// the file could never be deleted. The manager's own code is bundled into one
// file and already loaded here, so it does not need asar support in Node.
process.noAsar = true

let window: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let lastState: ManagerState | null = null
let trayTicks = 0
const adapter: PlatformAdapter = process.platform === 'win32' ? new WindowsAdapter() : new UnsupportedAdapter()
const isPortableRuntime = process.env.PORTABLE_EXECUTABLE_DIR !== undefined || process.execPath.includes(`${path.sep}win-unpacked${path.sep}`)
const startsAtLogin = process.argv.includes('--autostart')
// A pinned taskbar button relaunches an instance through the manager
// (`--launch-profile=<id>`), so the launch gets its taskbar identity back.
// Chromium hands a second instance's command line over with its switches
// reordered, so the value must travel inside the switch; the older
// space-separated form is still recognised by the shape of the id.
const launchProfileArgument = (argv: string[]): string | null => {
  const joined = argv.find(argument => argument.startsWith('--launch-profile='))
  if (joined) {
    return joined.slice('--launch-profile='.length) || null
  }
  if (!argv.includes('--launch-profile')) {
    return null
  }
  return argv.find(argument => argument === 'default' || argument.startsWith('instance-')) ?? null
}
const launchProfileId = launchProfileArgument(process.argv)
const loginItemArgs = ['--autostart']
const loginItemName = 'Claude Instance Manager'
const uiStatePath = () => path.join(app.getPath('userData'), 'ui-state.json')
const productionContentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'"
].join('; ')

// Electron defaults to %APPDATA%/<package name>. Keep its Chromium cache and
// window preferences beside the manager's other machine-local data instead.
if (process.platform === 'win32') {
  // A process started from a pinned instance button inherits that button's
  // AppUserModelID from the shortcut; the manager's own windows must not
  // group under an instance. The id matches the installer's Start menu entry.
  app.setAppUserModelId('com.claudeinstancemanager.desktop')
  const localAppData = process.env.LOCALAPPDATA ?? app.getPath('appData')
  const electronDataPath = path.join(localAppData, 'ClaudeInstanceManager', 'App')
  app.setPath('userData', electronDataPath)
  app.setPath('sessionData', path.join(electronDataPath, 'Session'))
}

// A background login launch owns the one Manager process. If the user later
// opens a shortcut, bring that existing instance to the foreground instead of
// starting another tray process.
const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1220,
    height: 780,
    minWidth: 980,
    minHeight: 650,
    resizable: true,
    minimizable: true,
    maximizable: true,
    closable: true,
    show: !startsAtLogin && !launchProfileId,
    // Windows keeps its familiar title bar and window controls. macOS retains
    // the integrated traffic-light controls without compromising resize.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#171717',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false
    }
  })
  // The packaged UI is entirely local. Do not permit it to load or open a
  // remote page that could try to call the limited IPC bridge in preload.
  if (!process.env.ELECTRON_RENDERER_URL) {
    window.webContents.session.webRequest.onHeadersReceived((details, callback) => {
      if (details.url.startsWith('file://')) {
        callback({
          responseHeaders: {
            ...details.responseHeaders,
            'Content-Security-Policy': [productionContentSecurityPolicy]
          }
        })
        return
      }
      callback({ responseHeaders: details.responseHeaders })
    })
  }
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.once('did-finish-load', () => {
    const allowedUrl = window?.webContents.getURL()
    window?.webContents.on('will-navigate', (event, targetUrl) => {
      if (targetUrl !== allowedUrl) {
        event.preventDefault()
      }
    })
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    window.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  window.on('close', event => {
    if (quitting) {
      return
    }
    event.preventDefault()
    window?.hide()
  })
}

function quitApp(): void {
  quitting = true
  app.quit()
}

function showManager(): void {
  window?.show()
  window?.focus()
}

function requestCloseAllFromTray(): void {
  showManager()
  window?.webContents.send('manager:request-close-all')
}

function requestCloseProfileFromTray(id: string): void {
  showManager()
  window?.webContents.send('manager:request-close-profile', id)
}

function notifyManagerStateChanged(): void {
  window?.webContents.send('manager:state-changed')
}

function startupSettings(): StartupSettings {
  if (process.platform !== 'win32') {
    return { supported: false, enabled: false, reason: 'Startup is currently available on Windows only.' }
  }
  if (isPortableRuntime) {
    return { supported: false, enabled: false, reason: 'Startup is unavailable for portable builds because their location can change.' }
  }
  return {
    supported: true,
    // Windows matches a login item by both its executable and arguments.
    // Use the exact same values that create the registry entry.
    enabled: app.getLoginItemSettings({ path: process.execPath, args: loginItemArgs }).openAtLogin
  }
}

function setStartupEnabled(enabled: boolean): StartupSettings {
  const current = startupSettings()
  if (!current.supported) {
    return current
  }
  app.setLoginItemSettings({
    openAtLogin: enabled,
    enabled,
    path: process.execPath,
    args: loginItemArgs,
    name: loginItemName
  })
  return startupSettings()
}

async function sidebarCollapsed(): Promise<boolean> {
  try {
    const state = JSON.parse(await readFile(uiStatePath(), 'utf8')) as { sidebarCollapsed?: unknown }
    return state.sidebarCollapsed === true
  } catch {
    return false
  }
}

async function setSidebarCollapsed(collapsed: boolean): Promise<void> {
  const file = uiStatePath()
  let state: Record<string, unknown> = {}
  try {
    state = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
  } catch { /* First run or corrupt state: overwrite safely. */ }
  state.sidebarCollapsed = collapsed
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

function trayIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'Assets', 'claude-instance-manager.ico')
    : path.join(app.getAppPath(), '..', 'Assets', 'claude-instance-manager.ico')
}

/**
 * Rebuilds the tray menu. A full refresh re-reads the whole manager state;
 * the periodic refresh only polls processes and reuses the last state.
 */
async function rebuildTray(startingProfileId?: string, full = true): Promise<void> {
  if (!tray) {
    return
  }
  if (full || !lastState) {
    lastState = await adapter.getState()
  } else {
    const runningStates = await adapter.profileRunningStates()
    lastState = { ...lastState, profiles: lastState.profiles.map(profile => ({ ...profile, running: runningStates[profile.id] ?? false })) }
  }
  const state = lastState
  const openManagerItems: Electron.MenuItemConstructorOptions[] = [{ label: 'Open manager', click: showManager }, { label: 'Quit', click: quitApp }]
  if (state.pendingSignIn) {
    const profileName = state.pendingSignInProfileName ?? 'selected instance'
    const profileId = state.pendingSignInProfileId
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: `Signing in — ${profileName}`, enabled: false },
      { label: `Open ${profileName}`, enabled: profileId !== null, click: () => { if (profileId) { void adapter.startProfile(profileId) } } },
      { label: 'Finish Sign In', click: () => void adapter.finishSignIn().then(() => rebuildTray()).then(notifyManagerStateChanged) },
      { type: 'separator' },
      ...openManagerItems
    ]))
    return
  }
  const profiles: Electron.MenuItemConstructorOptions[] = state.profiles
    .map(profile => ({ ...profile, running: profile.running || profile.id === startingProfileId }))
    .map(profile => ({
      label: `${profile.running ? '● ' : ''}${profile.isDefault ? 'Claude (Primary)' : profile.name}`,
      enabled: state.install !== null,
      submenu: profile.running
        ? [
            { label: 'Open', click: () => void adapter.startProfile(profile.id) },
            { label: 'Close', click: () => requestCloseProfileFromTray(profile.id) }
          ]
        : [{ label: 'Launch', click: () => void adapter.startProfile(profile.id).then(async () => { await rebuildTray(profile.id, false); notifyManagerStateChanged() }) }]
    }))
  const anyRunning = state.profiles.some(profile => profile.running || profile.id === startingProfileId)
  const recovery: Electron.MenuItemConstructorOptions[] = state.legacySignInRecovery
    ? [{ label: 'Finish legacy Sign In & Restore', click: () => void adapter.restoreSso().then(() => rebuildTray()).then(notifyManagerStateChanged) }, { type: 'separator' }]
    : []
  tray.setContextMenu(Menu.buildFromTemplate([...profiles, { type: 'separator' }, ...recovery, { label: 'Close all', enabled: anyRunning, click: requestCloseAllFromTray }, { type: 'separator' }, ...openManagerItems]))
}

async function handleDeepLink(url: string): Promise<void> {
  try {
    const route = await adapter.routeDeepLink(url)
    if (route.delivered) {
      return
    }
    showManager()
    window?.webContents.send('manager:deep-link-request', { url, candidates: route.candidates })
  } catch {
    showManager()
    window?.webContents.send('manager:deep-link-request', { url, candidates: lastState?.profiles ?? [] })
  }
}

async function trayTick(): Promise<void> {
  trayTicks += 1
  // Processes are polled every tick; the full state (installation, Sign In
  // relay, settings) is re-read once a minute, or every tick while a Sign In
  // is pending: the relay ends by itself when the primary Claude is started.
  const wasPendingSignIn = lastState?.pendingSignIn ?? false
  await rebuildTray(undefined, trayTicks % 6 === 0 || wasPendingSignIn).catch(() => undefined)
  if (wasPendingSignIn && lastState && !lastState.pendingSignIn) {
    notifyManagerStateChanged()
  }
  await adapter.syncDeepLinkRouter().catch(() => undefined)
}

function launchProfileFromArguments(id: string): void {
  void adapter.startProfile(id).then(async () => { await rebuildTray(id, false); notifyManagerStateChanged() }).catch(() => undefined)
}

app.on('second-instance', (_event, argv) => {
  const id = launchProfileArgument(argv)
  if (id) {
    launchProfileFromArguments(id)
    return
  }
  showManager()
})

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) {
    return
  }
  // The app has its own UI actions; Windows does not need Electron's default
  // Edit/View/Window/Help menu bar.
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
  }
  adapter.onDeepLink(url => void handleDeepLink(url))
  ipcMain.handle('manager:state', async (_, refreshInstall = false) => { lastState = await adapter.getState(refreshInstall === true); return lastState })
  ipcMain.handle('manager:running-states', () => adapter.profileRunningStates())
  ipcMain.handle('manager:create-profile', async (_, options) => { const profile = await adapter.createProfile(options); await rebuildTray(); return profile })
  ipcMain.handle('manager:rename-profile', async (_, id: string, name: string) => { const profile = await adapter.renameProfile(id, name); await rebuildTray(); return profile })
  ipcMain.handle('manager:set-profile-color', async (_, id: string, color) => { const profile = await adapter.setProfileColor(id, color); await rebuildTray(); return profile })
  ipcMain.handle('manager:set-profile-shortcuts', (_, id: string, options) => adapter.setProfileShortcuts(id, options))
  ipcMain.handle('manager:start-profile', async (_, id: string) => { await adapter.startProfile(id); notifyManagerStateChanged(); void rebuildTray(id, false).catch(() => undefined) })
  ipcMain.handle('manager:stop-profile', async (_, id: string) => { await adapter.stopProfile(id); await rebuildTray(undefined, false); notifyManagerStateChanged() })
  ipcMain.handle('manager:stop-all-claude', async () => { await adapter.stopAllClaude(); await rebuildTray(undefined, false) })
  ipcMain.handle('manager:backup-profile', (_, id: string, tier) => adapter.backupProfile(id, tier))
  ipcMain.handle('manager:profile-sizes', (_, id: string) => adapter.profileSizes(id))
  ipcMain.handle('manager:clean-caches', (_, id: string, names: string[]) => adapter.cleanCaches(id, names))
  ipcMain.handle('manager:clone-session', (_, sourceId: string, targetId: string, createBackup = true, tier = 'session', selection = null) => adapter.cloneSession(sourceId, targetId, createBackup, tier, selection))
  ipcMain.handle('manager:profile-contents', (_, id: string) => adapter.profileContents(id))
  ipcMain.handle('manager:storage-item-contents', (_, kind, itemId: string) => adapter.storageItemContents(kind, itemId))
  ipcMain.handle('manager:archive-profile', async (_, id: string) => { const backup = await adapter.archiveProfile(id); await rebuildTray(); return backup })
  ipcMain.handle('manager:delete-profile', async (_, id: string) => { await adapter.deleteProfile(id); await rebuildTray() })
  ipcMain.handle('manager:import-storage-item', (_, targetId: string, kind, itemId: string, createBackup = true, selection = null) => adapter.importStorageItem(targetId, kind, itemId, createBackup, selection))
  ipcMain.handle('manager:begin-sign-in', async (_, id: string, closePrimary = false) => { await adapter.beginSignIn(id, closePrimary === true); await rebuildTray() })
  ipcMain.handle('manager:finish-sign-in', async () => { await adapter.finishSignIn(); await rebuildTray(); await adapter.syncDeepLinkRouter().catch(() => undefined) })
  ipcMain.handle('manager:restore-sso', async () => { await adapter.restoreSso(); await rebuildTray() })
  ipcMain.handle('manager:remove-portable-runtime', () => adapter.removePortableRuntime())
  ipcMain.handle('manager:dismiss-portable-cleanup', () => adapter.dismissPortableCleanup())
  ipcMain.handle('manager:resolve-deep-link', async (_, url: string, profileId: string | null) => { if (profileId) { await adapter.deliverDeepLink(url, profileId) } })
  ipcMain.handle('manager:open-backups', () => adapter.openBackups())
  ipcMain.handle('manager:open-archives', () => adapter.openArchives())
  ipcMain.handle('manager:storage-items', (_, kind) => adapter.storageItems(kind))
  ipcMain.handle('manager:delete-storage-item', (_, kind, id: string) => adapter.deleteStorageItem(kind, id))
  ipcMain.handle('settings:manager', () => adapter.getManagerSettings())
  ipcMain.handle('settings:set-deep-link-router', (_, enabled: boolean) => adapter.setDeepLinkRouter(enabled === true))
  ipcMain.handle('settings:startup', () => startupSettings())
  ipcMain.handle('settings:set-startup', (_, enabled: boolean) => setStartupEnabled(enabled))
  ipcMain.handle('settings:version', () => app.getVersion())
  ipcMain.handle('ui:sidebar-collapsed', () => sidebarCollapsed())
  ipcMain.handle('ui:set-sidebar-collapsed', (_, collapsed: boolean) => setSidebarCollapsed(collapsed))
  tray = new Tray(trayIconPath())
  tray.setToolTip('Claude Instance Manager')
  tray.on('click', showManager)
  await rebuildTray()
  await adapter.syncDeepLinkRouter().catch(() => undefined)
  setInterval(() => void trayTick(), 10_000)
  createWindow()
  if (launchProfileId) {
    launchProfileFromArguments(launchProfileId)
  }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) { createWindow() } })
})
app.on('before-quit', () => { quitting = true })
