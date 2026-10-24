import type { BackupTier, ClaudeProfile, CopyTier, CreateProfileOptions, ImportResult, ImportSelection, ManagerSettings, ManagerState, PlatformName, ProfileColor, ProfileSizes, SourceContents, StorageItem, StorageItemKind } from '../shared/contracts'

export type DeepLinkRoute = { delivered: true } | { delivered: false, candidates: ClaudeProfile[] }

export interface PlatformAdapter {
  readonly platform: PlatformName
  getState(refreshInstall?: boolean): Promise<ManagerState>
  profileRunningStates(): Promise<Record<string, boolean>>
  createProfile(options: CreateProfileOptions): Promise<ClaudeProfile>
  renameProfile(id: string, name: string): Promise<ClaudeProfile>
  setProfileColor(id: string, color: ProfileColor): Promise<ClaudeProfile>
  setProfileShortcuts(id: string, options: Pick<CreateProfileOptions, 'desktopShortcut' | 'startMenuShortcut'>): Promise<ClaudeProfile>
  startProfile(id: string): Promise<void>
  stopProfile(id: string): Promise<void>
  stopAllClaude(): Promise<void>
  backupProfile(id: string, tier: BackupTier): Promise<string>
  profileSizes(id: string): Promise<ProfileSizes>
  cleanCaches(id: string, names: string[]): Promise<void>
  cloneSession(sourceId: string, targetId: string, createBackup?: boolean, tier?: CopyTier, selection?: ImportSelection | null): Promise<void>
  profileContents(id: string): Promise<SourceContents>
  storageItemContents(kind: StorageItemKind, itemId: string): Promise<SourceContents>
  archiveProfile(id: string): Promise<string>
  deleteProfile(id: string): Promise<void>
  importStorageItem(targetId: string, kind: StorageItemKind, itemId: string, createBackup?: boolean, selection?: ImportSelection | null): Promise<ImportResult>
  beginSignIn(id: string, closePrimary?: boolean): Promise<void>
  finishSignIn(): Promise<void>
  restoreSso(): Promise<void>
  removePortableRuntime(): Promise<void>
  dismissPortableCleanup(): Promise<void>
  getManagerSettings(): Promise<ManagerSettings>
  setDeepLinkRouter(enabled: boolean): Promise<ManagerSettings>
  openBackups(): Promise<void>
  openArchives(): Promise<void>
  storageItems(kind: StorageItemKind): Promise<StorageItem[]>
  deleteStorageItem(kind: StorageItemKind, id: string): Promise<void>
  /** Keeps the optional deep-link router in step with the settings and the primary process. */
  syncDeepLinkRouter(): Promise<void>
  onDeepLink(handler: (url: string) => void): void
  routeDeepLink(url: string): Promise<DeepLinkRoute>
  deliverDeepLink(url: string, profileId: string): Promise<void>
}
