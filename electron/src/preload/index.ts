import { contextBridge, ipcRenderer } from 'electron'
import type { DeepLinkRequest, ManagerApi } from '../shared/contracts'

const subscribe = <T>(channel: string, callback: (payload: T) => void) => {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const manager: ManagerApi = {
  state: (refreshInstall = false) => ipcRenderer.invoke('manager:state', refreshInstall),
  profileRunningStates: () => ipcRenderer.invoke('manager:running-states'),
  createProfile: (options) => ipcRenderer.invoke('manager:create-profile', options),
  renameProfile: (id, name) => ipcRenderer.invoke('manager:rename-profile', id, name),
  setProfileColor: (id, color) => ipcRenderer.invoke('manager:set-profile-color', id, color),
  setProfileShortcuts: (id, options) => ipcRenderer.invoke('manager:set-profile-shortcuts', id, options),
  startProfile: (id) => ipcRenderer.invoke('manager:start-profile', id),
  stopProfile: (id) => ipcRenderer.invoke('manager:stop-profile', id),
  stopAllClaude: () => ipcRenderer.invoke('manager:stop-all-claude'),
  onRequestCloseProfile: (callback) => subscribe<string>('manager:request-close-profile', callback),
  onRequestCloseAll: (callback) => subscribe<void>('manager:request-close-all', () => callback()),
  onStateChanged: (callback) => subscribe<void>('manager:state-changed', () => callback()),
  onDeepLinkRequest: (callback) => subscribe<DeepLinkRequest>('manager:deep-link-request', callback),
  resolveDeepLink: (url, profileId) => ipcRenderer.invoke('manager:resolve-deep-link', url, profileId),
  backupProfile: (id, tier) => ipcRenderer.invoke('manager:backup-profile', id, tier),
  profileSizes: (id) => ipcRenderer.invoke('manager:profile-sizes', id),
  cleanCaches: (id, names) => ipcRenderer.invoke('manager:clean-caches', id, names),
  cloneSession: (sourceId, targetId, createBackup = true, tier = 'session', selection = null) => ipcRenderer.invoke('manager:clone-session', sourceId, targetId, createBackup, tier, selection),
  profileContents: (id) => ipcRenderer.invoke('manager:profile-contents', id),
  storageItemContents: (kind, itemId) => ipcRenderer.invoke('manager:storage-item-contents', kind, itemId),
  archiveProfile: (id) => ipcRenderer.invoke('manager:archive-profile', id),
  deleteProfile: (id) => ipcRenderer.invoke('manager:delete-profile', id),
  importStorageItem: (targetId, kind, itemId, createBackup = true, selection = null) => ipcRenderer.invoke('manager:import-storage-item', targetId, kind, itemId, createBackup, selection),
  beginSignIn: (id, closePrimary = false) => ipcRenderer.invoke('manager:begin-sign-in', id, closePrimary),
  finishSignIn: () => ipcRenderer.invoke('manager:finish-sign-in'),
  restoreSso: () => ipcRenderer.invoke('manager:restore-sso'),
  removePortableRuntime: () => ipcRenderer.invoke('manager:remove-portable-runtime'),
  dismissPortableCleanup: () => ipcRenderer.invoke('manager:dismiss-portable-cleanup'),
  getManagerSettings: () => ipcRenderer.invoke('settings:manager'),
  setDeepLinkRouter: (enabled) => ipcRenderer.invoke('settings:set-deep-link-router', enabled),
  openBackups: () => ipcRenderer.invoke('manager:open-backups'),
  openArchives: () => ipcRenderer.invoke('manager:open-archives'),
  storageItems: (kind) => ipcRenderer.invoke('manager:storage-items', kind),
  deleteStorageItem: (kind, id) => ipcRenderer.invoke('manager:delete-storage-item', kind, id),
  getStartupSettings: () => ipcRenderer.invoke('settings:startup'),
  setStartupEnabled: (enabled) => ipcRenderer.invoke('settings:set-startup', enabled),
  getAppVersion: () => ipcRenderer.invoke('settings:version'),
  getSidebarCollapsed: () => ipcRenderer.invoke('ui:sidebar-collapsed'),
  setSidebarCollapsed: (collapsed) => ipcRenderer.invoke('ui:set-sidebar-collapsed', collapsed)
}
contextBridge.exposeInMainWorld('manager', manager)
