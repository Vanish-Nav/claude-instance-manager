import { access, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

const exists = (file: string): Promise<boolean> => access(file).then(() => true, () => false)
const directoryExists = (directory: string): Promise<boolean> => stat(directory).then(info => info.isDirectory(), () => false)

export class WindowsProfilePaths {
  readonly roamingClaude: string
  readonly roamingClaudeCode: string
  private readonly dataRoot: string
  private readonly packages: Array<{ family: string, roaming: string, relocated: string }>

  constructor(appData: string, localAppData: string, packageFamilies: string[]) {
    this.roamingClaude = path.join(appData, 'Claude')
    this.roamingClaudeCode = path.join(appData, 'Claude Code')
    this.dataRoot = path.join(localAppData, 'Claude-Data')
    // Windows supplies the registered PackageFamilyName. Validate its shape
    // before using it as a folder name; never assume a fixed publisher suffix.
    this.packages = packageFamilies.filter(family => /^[a-z0-9.-]+_[a-z0-9]+$/i.test(family)).map(family => ({
      family: family.toLowerCase(),
      roaming: path.join(localAppData, 'Packages', family, 'LocalCache', 'Roaming', 'Claude'),
      relocated: path.join(this.dataRoot, family.toLowerCase())
    }))
  }

  candidates(): string[] {
    return [this.roamingClaude, this.roamingClaudeCode, this.dataRoot, ...this.packages.flatMap(item => [item.roaming, item.relocated])]
  }

  contains(candidate: string): boolean {
    return this.candidates().some(known => path.resolve(known).toLowerCase() === path.resolve(candidate).toLowerCase())
  }

  signInPath(primaryPath: string): string {
    // Legacy Claude Code profiles still hand browser callbacks to Roaming\Claude.
    // MSIX and relocated profiles must stay at the location the official app uses.
    return primaryPath === this.roamingClaudeCode ? this.roamingClaude : primaryPath
  }

  async primary(): Promise<string> {
    for (const item of this.packages) {
      const movedBack = await exists(path.join(item.roaming, `.user-data-back.${item.family}`))
      if (movedBack) continue
      // Claude leaves this marker after moving its profile out of the MSIX
      // container. Keep pointing to that location even if it is now missing;
      // the old, marker-only directory is not a usable profile.
      if (await exists(path.join(item.roaming, `.user-data-left.${item.family}`))) return item.relocated
      if (await directoryExists(item.relocated) && !(await this.hasProfileEntries(item.roaming))) return item.relocated
    }
    for (const item of this.packages) {
      if (await directoryExists(item.roaming)) return item.roaming
    }
    // The root can also be a profile (for example, after UNC relocation), but
    // an empty root or a root containing only package subdirectories is not.
    const profileFiles = ['Local State', 'Preferences', 'config.json', 'ant-did']
    if ((await Promise.all(profileFiles.map(file => exists(path.join(this.dataRoot, file))))).some(Boolean)) return this.dataRoot
    if (await directoryExists(this.roamingClaude)) return this.roamingClaude
    if (await directoryExists(this.roamingClaudeCode)) return this.roamingClaudeCode
    return this.roamingClaude
  }

  private async hasProfileEntries(directory: string): Promise<boolean> {
    try {
      return (await readdir(directory)).some(name => !name.startsWith('.user-data-') && name !== 'lockfile')
    } catch (error) {
      // An inaccessible old profile must not be mistaken for an empty one.
      return (error as NodeJS.ErrnoException).code !== 'ENOENT'
    }
  }
}
