import { contextBridge, ipcRenderer } from 'electron'
import type { ManagerApi } from '../shared/contracts'

const manager: ManagerApi = {
  state: () => ipcRenderer.invoke('manager:state'),
  profileRunningStates: () => ipcRenderer.invoke('manager:running-states'),
  createProfile: (options) => ipcRenderer.invoke('manager:create-profile', options),
  renameProfile: (id, name) => ipcRenderer.invoke('manager:rename-profile', id, name),
  setProfileColor: (id, color) => ipcRenderer.invoke('manager:set-profile-color', id, color),
  setProfileShortcuts: (id, options) => ipcRenderer.invoke('manager:set-profile-shortcuts', id, options),
  preparePortable: () => ipcRenderer.invoke('manager:prepare-portable'),
  updatePortable: () => ipcRenderer.invoke('manager:update-portable'),
  startProfile: (id) => ipcRenderer.invoke('manager:start-profile', id),
  stopProfile: (id) => ipcRenderer.invoke('manager:stop-profile', id),
  stopAllPortable: () => ipcRenderer.invoke('manager:stop-all-portable'),
  onRequestCloseProfile: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, id: string) => callback(id)
    ipcRenderer.on('manager:request-close-profile', listener)
    return () => ipcRenderer.removeListener('manager:request-close-profile', listener)
  },
  onRequestCloseAll: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('manager:request-close-all', listener)
    return () => ipcRenderer.removeListener('manager:request-close-all', listener)
  },
  onStateChanged: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('manager:state-changed', listener)
    return () => ipcRenderer.removeListener('manager:state-changed', listener)
  },
  backupProfile: (id) => ipcRenderer.invoke('manager:backup-profile', id),
  archiveProfile: (id) => ipcRenderer.invoke('manager:archive-profile', id),
  deleteProfile: (id) => ipcRenderer.invoke('manager:delete-profile', id),
  importStorageItem: (targetId, kind, itemId, createBackup = true) => ipcRenderer.invoke('manager:import-storage-item', targetId, kind, itemId, createBackup),
  beginSso: (id) => ipcRenderer.invoke('manager:begin-sso', id),
  continueSso: () => ipcRenderer.invoke('manager:continue-sso'),
  restoreSso: () => ipcRenderer.invoke('manager:restore-sso'),
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
