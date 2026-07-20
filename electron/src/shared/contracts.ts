export type PlatformName = 'windows' | 'macos' | 'unsupported'
export type ProfileColor = 'default' | 'green' | 'teal' | 'blue' | 'indigo' | 'violet' | 'rose' | 'red' | 'amber'

export interface ClaudeProfile {
  id: string
  name: string
  path: string
  isDefault: boolean
  exists: boolean
  running: boolean
  color: ProfileColor
  desktopShortcut: boolean
  startMenuShortcut: boolean
}

export interface ManagerState {
  platform: PlatformName
  installedVersion: string | null
  portableVersion: string | null
  portableReady: boolean
  portablePath: string
  profiles: ClaudeProfile[]
  pendingSso: boolean
  pendingSsoProfileId: string | null
  pendingSsoProfileName: string | null
}

export interface StartupSettings {
  supported: boolean
  enabled: boolean
  reason?: string
}

export type StorageItemKind = 'backup' | 'archive'

export interface StorageItem {
  id: string
  profileId: string
  profileName: string
  createdAt: string
  sizeBytes: number | null
}

export interface CreateProfileOptions {
  name: string
  desktopShortcut: boolean
  startMenuShortcut: boolean
  color: ProfileColor
}

export interface ManagerApi {
  state(): Promise<ManagerState>
  profileRunningStates(): Promise<Record<string, boolean>>
  createProfile(options: CreateProfileOptions): Promise<ClaudeProfile>
  renameProfile(id: string, name: string): Promise<ClaudeProfile>
  setProfileColor(id: string, color: ProfileColor): Promise<ClaudeProfile>
  setProfileShortcuts(id: string, options: Pick<CreateProfileOptions, 'desktopShortcut' | 'startMenuShortcut'>): Promise<ClaudeProfile>
  preparePortable(): Promise<void>
  updatePortable(): Promise<void>
  startProfile(id: string): Promise<void>
  stopProfile(id: string): Promise<void>
  stopAllPortable(): Promise<void>
  onRequestCloseProfile(callback: (id: string) => void): () => void
  onRequestCloseAll(callback: () => void): () => void
  onStateChanged(callback: () => void): () => void
  backupProfile(id: string): Promise<string>
  archiveProfile(id: string): Promise<string>
  deleteProfile(id: string): Promise<void>
  importStorageItem(targetId: string, kind: StorageItemKind, itemId: string, createBackup?: boolean): Promise<void>
  beginSso(id: string): Promise<void>
  continueSso(): Promise<void>
  restoreSso(): Promise<void>
  openBackups(): Promise<void>
  openArchives(): Promise<void>
  storageItems(kind: StorageItemKind): Promise<StorageItem[]>
  deleteStorageItem(kind: StorageItemKind, id: string): Promise<void>
  getStartupSettings(): Promise<StartupSettings>
  setStartupEnabled(enabled: boolean): Promise<StartupSettings>
  getAppVersion(): Promise<string>
  getSidebarCollapsed(): Promise<boolean>
  setSidebarCollapsed(collapsed: boolean): Promise<void>
}
