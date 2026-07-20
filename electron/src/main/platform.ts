import type { ClaudeProfile, CreateProfileOptions, ManagerState, PlatformName, ProfileColor, StorageItem, StorageItemKind } from '../shared/contracts'

export interface PlatformAdapter {
  readonly platform: PlatformName
  getState(): Promise<ManagerState>
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
}
