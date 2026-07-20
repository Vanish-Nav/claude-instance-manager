import type { ClaudeProfile, CreateProfileOptions, ManagerState, ProfileColor, StorageItem, StorageItemKind } from '../shared/contracts'
import type { PlatformAdapter } from './platform'

export class UnsupportedAdapter implements PlatformAdapter {
  readonly platform = 'unsupported' as const
  private unavailable(): never { throw new Error('This operating system is not supported yet.') }
  async getState(): Promise<ManagerState> {
    return { platform: this.platform, installedVersion: null, portableVersion: null, portableReady: false, portablePath: '', profiles: [], pendingSso: false, pendingSsoProfileId: null, pendingSsoProfileName: null }
  }
  async profileRunningStates(): Promise<Record<string, boolean>> { return {} }
  async createProfile(_options: CreateProfileOptions): Promise<ClaudeProfile> { return this.unavailable() }
  async renameProfile(_id: string, _name: string): Promise<ClaudeProfile> { return this.unavailable() }
  async setProfileColor(_id: string, _color: ProfileColor): Promise<ClaudeProfile> { return this.unavailable() }
  async setProfileShortcuts(_id: string, _options: Pick<CreateProfileOptions, 'desktopShortcut' | 'startMenuShortcut'>): Promise<ClaudeProfile> { return this.unavailable() }
  async preparePortable(): Promise<void> { return this.unavailable() }
  async updatePortable(): Promise<void> { return this.unavailable() }
  async startProfile(): Promise<void> { return this.unavailable() }
  async stopProfile(): Promise<void> { return this.unavailable() }
  async stopAllPortable(): Promise<void> { return this.unavailable() }
  async backupProfile(): Promise<string> { return this.unavailable() }
  async archiveProfile(): Promise<string> { return this.unavailable() }
  async deleteProfile(): Promise<void> { return this.unavailable() }
  async importStorageItem(): Promise<void> { return this.unavailable() }
  async beginSso(): Promise<void> { return this.unavailable() }
  async continueSso(): Promise<void> { return this.unavailable() }
  async restoreSso(): Promise<void> { return this.unavailable() }
  async openBackups(): Promise<void> { return this.unavailable() }
  async openArchives(): Promise<void> { return this.unavailable() }
  async storageItems(_kind: StorageItemKind): Promise<StorageItem[]> { return this.unavailable() }
  async deleteStorageItem(_kind: StorageItemKind, _id: string): Promise<void> { return this.unavailable() }
}
