import { app, BrowserWindow, ipcMain, Menu, Tray } from 'electron'
import path from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { WindowsAdapter } from './windows-adapter'
import { UnsupportedAdapter } from './unsupported-adapter'
import type { PlatformAdapter } from './platform'
import type { StartupSettings } from '../shared/contracts'

let window: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
const adapter: PlatformAdapter = process.platform === 'win32' ? new WindowsAdapter() : new UnsupportedAdapter()
const isPortableRuntime = process.env.PORTABLE_EXECUTABLE_DIR !== undefined || process.execPath.includes(`${path.sep}win-unpacked${path.sep}`)
const startsAtLogin = process.argv.includes('--autostart')
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
  const localAppData = process.env.LOCALAPPDATA ?? app.getPath('appData')
  const electronDataPath = path.join(localAppData, 'ClaudeInstanceManager', 'App')
  app.setPath('userData', electronDataPath)
  app.setPath('sessionData', path.join(electronDataPath, 'Session'))
}

// A background login launch owns the one Manager process. If the user later
// opens a shortcut, bring that existing instance to the foreground instead of
// starting another tray process.
const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

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
    show: !startsAtLogin,
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
      if (targetUrl !== allowedUrl) event.preventDefault()
    })
  })
  if (process.env.ELECTRON_RENDERER_URL) window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else window.loadFile(path.join(__dirname, '../renderer/index.html'))
  window.on('close', event => {
    if (quitting) return
    event.preventDefault()
    window?.hide()
  })
}

function quitApp(): void {
  quitting = true
  app.quit()
}

function requestCloseAllFromTray(): void {
  window?.show()
  window?.focus()
  window?.webContents.send('manager:request-close-all')
}

function requestCloseProfileFromTray(id: string): void {
  window?.show()
  window?.focus()
  window?.webContents.send('manager:request-close-profile', id)
}

function notifyManagerStateChanged(): void {
  window?.webContents.send('manager:state-changed')
}

function startupSettings(): StartupSettings {
  if (process.platform !== 'win32') return { supported: false, enabled: false, reason: 'Startup is currently available on Windows only.' }
  if (isPortableRuntime) return { supported: false, enabled: false, reason: 'Startup is unavailable for portable builds because their location can change.' }
  return {
    supported: true,
    // Windows matches a login item by both its executable and arguments.
    // Use the exact same values that create the registry entry.
    enabled: app.getLoginItemSettings({ path: process.execPath, args: loginItemArgs }).openAtLogin
  }
}

function setStartupEnabled(enabled: boolean): StartupSettings {
  const current = startupSettings()
  if (!current.supported) return current
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
  } catch { return false }
}

async function setSidebarCollapsed(collapsed: boolean): Promise<void> {
  const file = uiStatePath()
  let state: Record<string, unknown> = {}
  try { state = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown> } catch { /* First run or corrupt state: overwrite safely. */ }
  state.sidebarCollapsed = collapsed
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

function trayIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'Assets', 'claude-instance-manager.ico')
    : path.join(app.getAppPath(), '..', 'Assets', 'claude-instance-manager.ico')
}

async function rebuildTray(startingProfileId?: string): Promise<void> {
  if (!tray) return
  const state = await adapter.getState()
  if (state.pendingSso) {
    const profileName = state.pendingSsoProfileName ?? 'selected instance'
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: `Continue Sign In — ${profileName}`, click: () => void adapter.continueSso() },
      { label: 'Finish Sign In & Restore', click: () => void adapter.restoreSso().then(() => rebuildTray()) },
      { type: 'separator' },
      { label: 'Open manager', click: () => { window?.show(); window?.focus() } },
      { label: 'Quit', click: quitApp }
    ]))
    return
  }
  const profiles = state.profiles
    .map(profile => ({ ...profile, running: profile.running || profile.id === startingProfileId }))
    .map(profile => ({
    label: `${profile.running ? '● ' : ''}${profile.isDefault ? 'Claude (Primary)' : profile.name}`,
    enabled: profile.isDefault || state.portableReady,
    submenu: profile.running
      ? [
          { label: 'Open', click: () => void adapter.startProfile(profile.id) },
          { label: 'Close', click: () => requestCloseProfileFromTray(profile.id) }
        ]
      : [{ label: 'Launch', click: () => void adapter.startProfile(profile.id).then(async () => { await rebuildTray(profile.id); notifyManagerStateChanged() }) }]
  }))
  const anyRunning = state.profiles.some(profile => profile.running || profile.id === startingProfileId)
  tray.setContextMenu(Menu.buildFromTemplate([...profiles, { type: 'separator' }, { label: 'Close all', enabled: anyRunning, click: requestCloseAllFromTray }, { type: 'separator' }, { label: 'Open manager', click: () => { window?.show(); window?.focus() } }, { label: 'Quit', click: quitApp }]))
}

app.on('second-instance', () => {
  window?.show()
  window?.focus()
})

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return
  // The app has its own UI actions; Windows does not need Electron's default
  // Edit/View/Window/Help menu bar.
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
  ipcMain.handle('manager:state', () => adapter.getState())
  ipcMain.handle('manager:running-states', () => adapter.profileRunningStates())
  ipcMain.handle('manager:create-profile', async (_, options) => { const profile = await adapter.createProfile(options); await rebuildTray(); return profile })
  ipcMain.handle('manager:rename-profile', async (_, id: string, name: string) => { const profile = await adapter.renameProfile(id, name); await rebuildTray(); return profile })
  ipcMain.handle('manager:set-profile-color', async (_, id: string, color) => { const profile = await adapter.setProfileColor(id, color); await rebuildTray(); return profile })
  ipcMain.handle('manager:set-profile-shortcuts', (_, id: string, options) => adapter.setProfileShortcuts(id, options))
  ipcMain.handle('manager:prepare-portable', () => adapter.preparePortable())
  ipcMain.handle('manager:update-portable', async () => { await adapter.updatePortable(); await rebuildTray() })
  ipcMain.handle('manager:start-profile', async (_, id: string) => { await adapter.startProfile(id); notifyManagerStateChanged(); void rebuildTray(id).catch(() => undefined) })
  ipcMain.handle('manager:stop-profile', async (_, id: string) => { await adapter.stopProfile(id); await rebuildTray(); notifyManagerStateChanged() })
  ipcMain.handle('manager:stop-all-portable', async () => { await adapter.stopAllPortable(); await rebuildTray() })
  ipcMain.handle('manager:backup-profile', (_, id: string) => adapter.backupProfile(id))
  ipcMain.handle('manager:archive-profile', async (_, id: string) => { const backup = await adapter.archiveProfile(id); await rebuildTray(); return backup })
  ipcMain.handle('manager:delete-profile', async (_, id: string) => { await adapter.deleteProfile(id); await rebuildTray() })
  ipcMain.handle('manager:import-storage-item', (_, targetId: string, kind, itemId: string, createBackup = true) => adapter.importStorageItem(targetId, kind, itemId, createBackup))
  ipcMain.handle('manager:begin-sso', async (_, id: string) => { await adapter.beginSso(id); await rebuildTray() })
  ipcMain.handle('manager:continue-sso', () => adapter.continueSso())
  ipcMain.handle('manager:restore-sso', async () => { await adapter.restoreSso(); await rebuildTray() })
  ipcMain.handle('manager:open-backups', () => adapter.openBackups())
  ipcMain.handle('manager:open-archives', () => adapter.openArchives())
  ipcMain.handle('manager:storage-items', (_, kind) => adapter.storageItems(kind))
  ipcMain.handle('manager:delete-storage-item', (_, kind, id: string) => adapter.deleteStorageItem(kind, id))
  ipcMain.handle('settings:startup', () => startupSettings())
  ipcMain.handle('settings:set-startup', (_, enabled: boolean) => setStartupEnabled(enabled))
  ipcMain.handle('settings:version', () => app.getVersion())
  ipcMain.handle('ui:sidebar-collapsed', () => sidebarCollapsed())
  ipcMain.handle('ui:set-sidebar-collapsed', (_, collapsed: boolean) => setSidebarCollapsed(collapsed))
  tray = new Tray(trayIconPath())
  tray.setToolTip('Claude Instance Manager')
  tray.on('click', () => { window?.show(); window?.focus() })
  await rebuildTray()
  setInterval(() => void rebuildTray(), 10_000)
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('before-quit', () => { quitting = true })
