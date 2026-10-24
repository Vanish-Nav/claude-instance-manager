import type { ClaudeProfile, CreateProfileOptions, ImportResult, ManagerSettings, ManagerState, ProfileColor, ProfileSizes, SourceContents, StorageItem, StorageItemKind } from '../shared/contracts'
import type { DeepLinkRoute, PlatformAdapter } from './platform'

export class UnsupportedAdapter implements PlatformAdapter {
  readonly platform = 'unsupported' as const
  private unavailable(): never { throw new Error('This operating system is not supported yet.') }
  async getState(): Promise<ManagerState> {
    return { platform: this.platform, installedVersion: null, install: null, profiles: [], pendingSignIn: false, pendingSignInProfileId: null, pendingSignInProfileName: null, legacySignInRecovery: false, portableCleanup: null, deepLinkRouter: { enabled: false, active: false } }
  }
  async profileRunningStates(): Promise<Record<string, boolean>> { return {} }
  async createProfile(_options: CreateProfileOptions): Promise<ClaudeProfile> { return this.unavailable() }
  async renameProfile(_id: string, _name: string): Promise<ClaudeProfile> { return this.unavailable() }
  async setProfileColor(_id: string, _color: ProfileColor): Promise<ClaudeProfile> { return this.unavailable() }
  async setProfileShortcuts(_id: string, _options: Pick<CreateProfileOptions, 'desktopShortcut' | 'startMenuShortcut'>): Promise<ClaudeProfile> { return this.unavailable() }
  async startProfile(): Promise<void> { return this.unavailable() }
  async stopProfile(): Promise<void> { return this.unavailable() }
  async stopAllClaude(): Promise<void> { return this.unavailable() }
  async backupProfile(): Promise<string> { return this.unavailable() }
  async profileSizes(): Promise<ProfileSizes> { return this.unavailable() }
  async cleanCaches(): Promise<void> { return this.unavailable() }
  async cloneSession(): Promise<void> { return this.unavailable() }
  async profileContents(): Promise<SourceContents> { return this.unavailable() }
  async storageItemContents(): Promise<SourceContents> { return this.unavailable() }
  async archiveProfile(): Promise<string> { return this.unavailable() }
  async deleteProfile(): Promise<void> { return this.unavailable() }
  async importStorageItem(): Promise<ImportResult> { return this.unavailable() }
  async beginSignIn(): Promise<void> { return this.unavailable() }
  async finishSignIn(): Promise<void> { return this.unavailable() }
  async restoreSso(): Promise<void> { return this.unavailable() }
  async removePortableRuntime(): Promise<void> { return this.unavailable() }
  async dismissPortableCleanup(): Promise<void> { return this.unavailable() }
  async getManagerSettings(): Promise<ManagerSettings> { return { deepLinkRouter: false } }
  async setDeepLinkRouter(): Promise<ManagerSettings> { return this.unavailable() }
  async openBackups(): Promise<void> { return this.unavailable() }
  async openArchives(): Promise<void> { return this.unavailable() }
  async storageItems(_kind: StorageItemKind): Promise<StorageItem[]> { return this.unavailable() }
  async deleteStorageItem(_kind: StorageItemKind, _id: string): Promise<void> { return this.unavailable() }
  async syncDeepLinkRouter(): Promise<void> {}
  onDeepLink(): void {}
  async routeDeepLink(): Promise<DeepLinkRoute> { return { delivered: false, candidates: [] } }
  async deliverDeepLink(): Promise<void> { return this.unavailable() }
}
