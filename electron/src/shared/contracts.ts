export type PlatformName = 'windows' | 'macos' | 'unsupported'
export type ProfileColor = 'default' | 'green' | 'teal' | 'blue' | 'indigo' | 'violet' | 'rose' | 'red' | 'amber'
export type ClaudeInstallKind = 'msix-direct' | 'msix-store' | 'squirrel'

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

export interface ClaudeInstallSummary {
  kind: ClaudeInstallKind
  label: string
  version: string | null
  launchTarget: string
  /** Number of Claude installations found on the machine. */
  candidates: number
}

export interface PortableCleanup {
  path: string
  sizeBytes: number | null
}

export interface DeepLinkRouterState {
  enabled: boolean
  active: boolean
}

export interface ManagerState {
  platform: PlatformName
  installedVersion: string | null
  install: ClaudeInstallSummary | null
  profiles: ClaudeProfile[]
  pendingSignIn: boolean
  pendingSignInProfileId: string | null
  pendingSignInProfileName: string | null
  /** A recovery state of the former profile-swap Sign In is still on disk. */
  legacySignInRecovery: boolean
  portableCleanup: PortableCleanup | null
  deepLinkRouter: DeepLinkRouterState
}

export interface StartupSettings {
  supported: boolean
  enabled: boolean
  reason?: string
}

export interface ManagerSettings {
  deepLinkRouter: boolean
}

export type StorageItemKind = 'backup' | 'archive'
export type BackupTier = 'session' | 'full' | 'settings'
export type StorageTier = BackupTier | 'archive'

export interface StorageItem {
  id: string
  profileId: string
  profileName: string
  createdAt: string
  sizeBytes: number | null
  tier: StorageTier
}

export type ProfileEntryCategory = 'session' | 'data' | 'cache'

export interface ProfileSizeEntry {
  name: string
  sizeBytes: number
  category: ProfileEntryCategory
}

export interface ProfileSizes {
  entries: ProfileSizeEntry[]
  projectsBytes: number
  sessionBytes: number
  fullBytes: number
  cacheBytes: number
}

export interface MissingProject {
  cwd: string
  title: string | null
}

export interface ImportResult {
  missingProjects: MissingProject[]
}

export interface SourceProject {
  cwd: string
  title: string | null
  sessions: number
  /** The working directory exists on this machine. */
  exists: boolean
}

/** What a backup, export or live profile would bring into another instance. */
export interface SourceContents {
  projects: SourceProject[]
  coworkSessions: number
}

export interface ImportSelection {
  /** Working directories whose Code sessions are imported; null means all. */
  projects: string[] | null
  cowork: boolean
}

export type CopyTier = 'settings' | 'session'

export interface DeepLinkRequest {
  url: string
  candidates: ClaudeProfile[]
}

export interface CreateProfileOptions {
  name: string
  desktopShortcut: boolean
  startMenuShortcut: boolean
  color: ProfileColor
}

export interface ManagerApi {
  state(refreshInstall?: boolean): Promise<ManagerState>
  profileRunningStates(): Promise<Record<string, boolean>>
  createProfile(options: CreateProfileOptions): Promise<ClaudeProfile>
  renameProfile(id: string, name: string): Promise<ClaudeProfile>
  setProfileColor(id: string, color: ProfileColor): Promise<ClaudeProfile>
  setProfileShortcuts(id: string, options: Pick<CreateProfileOptions, 'desktopShortcut' | 'startMenuShortcut'>): Promise<ClaudeProfile>
  startProfile(id: string): Promise<void>
  stopProfile(id: string): Promise<void>
  stopAllClaude(): Promise<void>
  onRequestCloseProfile(callback: (id: string) => void): () => void
  onRequestCloseAll(callback: () => void): () => void
  onStateChanged(callback: () => void): () => void
  onDeepLinkRequest(callback: (request: DeepLinkRequest) => void): () => void
  resolveDeepLink(url: string, profileId: string | null): Promise<void>
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
  getStartupSettings(): Promise<StartupSettings>
  setStartupEnabled(enabled: boolean): Promise<StartupSettings>
  getAppVersion(): Promise<string>
  getSidebarCollapsed(): Promise<boolean>
  setSidebarCollapsed(collapsed: boolean): Promise<void>
}
