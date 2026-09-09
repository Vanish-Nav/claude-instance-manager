import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { access, cp, mkdir, readdir, rename, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { app, shell } from 'electron'
import type { ClaudeProfile, CreateProfileOptions, ManagerState, ProfileColor, StorageItem, StorageItemKind } from '../shared/contracts'
import type { PlatformAdapter } from './platform'

const execFileAsync = promisify(execFile)
const missing = async (value: string): Promise<boolean> => access(value, constants.F_OK).then(() => false).catch(() => true)
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
const supportedProfileColors: ProfileColor[] = ['default', 'green', 'teal', 'blue', 'indigo', 'violet', 'rose', 'red', 'amber']

export class WindowsAdapter implements PlatformAdapter {
  readonly platform = 'windows' as const
  private readonly appData = process.env.APPDATA ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming')
  private readonly localData = path.join(process.env.LOCALAPPDATA ?? this.appData, 'ClaudeInstanceManager')
  // Claude Desktop has used both names for its primary roaming profile. Keep
  // the original path as the Sign In hand-off location because the official
  // app's callback is registered against it, but recognise either location
  // when displaying and preserving the user's regular profile.
  private readonly claudeProfilePath = path.join(this.appData, 'Claude')
  private readonly claudeCodeProfilePath = path.join(this.appData, 'Claude Code')
  private readonly portablePath = path.join(this.localData, 'Portable')
  private readonly profilesPath = path.join(this.localData, 'Profiles')
  private readonly portableExe = path.join(this.portablePath, 'Claude.exe')
  private readonly backupsPath = path.join(this.localData, 'Backups')
  private readonly archivesPath = path.join(this.localData, 'Archives')
  private readonly ssoStatePath = path.join(this.localData, 'sso-state.json')

  async getState(): Promise<ManagerState> {
    const [installedVersion, profiles] = await Promise.all([this.installedVersion(), this.profiles()])
    const runningStates = await this.runningStates(profiles)
    const profilesWithStatus = profiles.map(profile => ({ ...profile, running: runningStates[profile.id] ?? false }))
    const portableReady = !(await missing(this.portableExe))
    const sso = await this.ssoState()
    return { platform: this.platform, installedVersion, portableVersion: portableReady ? await this.fileVersion(this.portableExe) : null, portableReady, portablePath: this.portablePath, profiles: profilesWithStatus, pendingSso: sso !== null, pendingSsoProfileId: sso?.profileId ?? null, pendingSsoProfileName: sso?.profileName ?? null }
  }

  async profileRunningStates(): Promise<Record<string, boolean>> { return this.runningStates(await this.profiles()) }

  async createProfile(options: CreateProfileOptions): Promise<ClaudeProfile> {
    const requestedName = this.normalizeProfileName(options.name)
    const profiles = await this.profiles()
    const name = this.availableProfileName(requestedName, profiles)
    const directoryName = `CIM-Profile-${randomUUID()}`
    const profile: ClaudeProfile = { id: `instance-${directoryName}`, name, path: path.join(this.profilesPath, directoryName), isDefault: false, exists: true, running: false, color: options.color, desktopShortcut: options.desktopShortcut, startMenuShortcut: options.startMenuShortcut }
    await mkdir(profile.path, { recursive: true })
    await this.writeProfileMetadata(profile.path, profile.name, profile.color)
    await this.createShortcuts(profile, options)
    return profile
  }

  async renameProfile(id: string, nextName: string): Promise<ClaudeProfile> {
    const profile = await this.profile(id)
    if (profile.isDefault) throw new Error('The regular Claude profile name cannot be changed.')
    const name = this.normalizeProfileName(nextName)
    const profiles = await this.profiles()
    if (profiles.some(item => item.id !== id && item.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0)) throw new Error('An instance with this name already exists.')
    await this.writeProfileMetadata(profile.path, name, profile.color)
    return { ...profile, name }
  }

  async setProfileColor(id: string, color: ProfileColor): Promise<ClaudeProfile> {
    if (!supportedProfileColors.includes(color)) throw new Error('Unsupported profile color.')
    const profile = await this.profile(id)
    if (profile.isDefault) throw new Error('The regular Claude profile color cannot be changed.')
    if (profile.color === color) return profile
    const wasRunning = await this.profileProcessId(profile)
    await this.writeProfileMetadata(profile.path, profile.name, color)
    if (wasRunning) { await this.stopProfile(profile.id); await new Promise(resolve => setTimeout(resolve, 900)); await this.startProfile(profile.id) }
    return { ...profile, color }
  }

  async setProfileShortcuts(id: string, options: Pick<CreateProfileOptions, 'desktopShortcut' | 'startMenuShortcut'>): Promise<ClaudeProfile> {
    const profile = await this.profile(id)
    if (profile.isDefault) throw new Error('Shortcuts are only available for isolated instances.')
    await this.removeProfileShortcuts(profile)
    await this.createShortcuts(profile, options)
    return { ...profile, ...options }
  }

  async preparePortable(): Promise<void> {
    const source = await this.appInstallPath()
    if (!source) throw new Error('Claude Desktop MSIX was not found. Install and launch Claude Desktop first.')
    await mkdir(this.localData, { recursive: true })
    // Robocopy needs elevation to read the WindowsApps installation directory.
    // Run that fixed command through UAC directly instead of creating a .ps1
    // file and bypassing the user's PowerShell execution policy.
    // Robocopy reserves 0 through 7 for successful outcomes (for example,
    // files copied or extra files removed). Explicitly return 0 for all of
    // them so the UAC launcher and Electron do not report a false failure.
    const copyCommand = `& robocopy.exe ${ps(source)} ${ps(this.portablePath)} /MIR /COPY:DAT /DCOPY:DAT /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null; if ($LASTEXITCODE -gt 7) { exit $LASTEXITCODE }; exit 0`
    // Passing a nested -Command through Start-Process makes Windows command
    // line parsing responsible for two layers of quotes. WindowsApps paths
    // and user profile paths can expose that issue. EncodedCommand keeps the
    // elevated invocation a fixed command without needing a temporary script.
    const encodedCopyCommand = Buffer.from(copyCommand, 'utf16le').toString('base64')
    const elevatedArguments = `-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${encodedCopyCommand}`
    const launcher = `$process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList ${ps(elevatedArguments)}; if ($process.ExitCode -gt 7) { exit $process.ExitCode }`
    try {
      await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', launcher])
    } catch (error) {
      const exitCode = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'unknown'
      throw new Error(`Could not copy the installed Claude runtime (robocopy exit code ${exitCode}). Close Claude, approve the administrator prompt, and try again.`)
    }
    if (await missing(this.portableExe)) throw new Error('The portable copy was not created. Approve the administrator prompt and try again.')
  }

  async updatePortable(): Promise<void> {
    // Updating files below WindowsApps while Claude is still running can leave
    // the installed app's tray/process-singleton in an inconsistent state.
    // Let the user close Claude normally, so it can persist its state first.
    if (await this.anyClaudeRunning()) throw new Error('Quit every Claude instance from its tray menu, then try updating the portable runtime again.')
    await this.preparePortable()
  }

  async startProfile(id: string): Promise<void> {
    const profile = await this.profile(id)
    const runningProcessIds = await this.profileProcessIds(profile)
    if (runningProcessIds.length > 0) {
      // Do not touch an already-running window with TaskbarHelper or WinAPI.
      // Ask Claude itself to show the profile instead. Its
      // ProcessSingleton forwards the second launch to the primary process,
      // which is equivalent to its own tray "Show App" action and restores
      // the app's custom title-bar state.
      this.requestProfileShow(profile)
      return
    }
    if (profile.isDefault) {
      await this.startOfficial()
      return
    }
    if (await missing(this.portableExe)) throw new Error('Prepare the portable Claude copy first.')
    await mkdir(profile.path, { recursive: true })
    const child = spawn(this.portableExe, [`--user-data-dir=${profile.path}`, `--app-user-model-id=${this.profileAppUserModelId(profile)}`], { detached: true, stdio: 'ignore' })
    child.unref()
    if (child.pid) void this.applyTaskbarIdentity(profile, child.pid)
  }

  async stopProfile(id: string): Promise<void> {
    const profile = await this.profile(id)
    if (profile.isDefault) {
      await this.stopOfficialClaude()
      await this.waitForProfileStopped(profile)
      return
    }
    await this.powerShell(`$target=${quote(profile.path)}; Get-CimInstance Win32_Process -Filter \"Name='Claude.exe'\" | Where-Object { $_.CommandLine -like ('*' + $target + '*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`)
    await this.waitForProfileStopped(profile)
  }

  async stopAllPortable(): Promise<void> {
    await this.stopAllClaude()
  }

  async backupProfile(id: string): Promise<string> {
    const profile = await this.profile(id)
    if (await missing(profile.path)) throw new Error('The selected profile folder does not exist.')
    // Chromium keeps its SQLite cookie database open while Claude is running.
    // Always close the selected profile first, even when the user initiated a
    // backup while it was already stopped, then wait for all child processes
    // to release their file handles before copying.
    await this.stopProfile(profile.id)
    await this.waitForProfileProcessesStopped(profile)
    const target = path.join(this.backupsPath, profile.id, stamp())
    await mkdir(path.dirname(target), { recursive: true }); await cp(profile.path, target, { recursive: true, force: false })
    await this.writeStorageMetadata(target, profile, 'backup', await this.directorySize(target))
    return target
  }

  async archiveProfile(id: string): Promise<string> {
    const profile = await this.profile(id)
    if (profile.isDefault) throw new Error('The regular Claude profile cannot be removed.')
    await this.stopProfile(profile.id)
    await this.waitForProfileProcessesStopped(profile)
    const target = path.join(this.archivesPath, profile.id, stamp())
    await mkdir(path.dirname(target), { recursive: true }); await rename(profile.path, target)
    await this.writeStorageMetadata(target, profile, 'archive', await this.directorySize(target))
    return target
  }

  async deleteProfile(id: string): Promise<void> {
    const profile = await this.profile(id)
    if (profile.isDefault) throw new Error('The regular Claude profile cannot be deleted.')
    await this.stopProfile(profile.id)
    await this.waitForProfileProcessesStopped(profile)
    await this.removeProfileShortcuts(profile)
    await rm(profile.path, { recursive: true, force: false })
  }

  async importStorageItem(targetId: string, kind: StorageItemKind, itemId: string, createBackup = true): Promise<void> {
    const target = await this.profile(targetId)
    if (target.isDefault) throw new Error('Select an isolated instance to import data.')
    const item = (await this.storageItems(kind)).find(candidate => candidate.id === itemId)
    if (!item) throw new Error('The selected backup or archive was not found.')
    const root = kind === 'backup' ? this.backupsPath : this.archivesPath
    const source = path.join(root, ...item.id.split('/'))
    await this.stopProfile(target.id)
    if (createBackup) await this.backupProfile(target.id)
    await rm(target.path, { recursive: true, force: true })
    await cp(source, target.path, { recursive: true, force: false })
    // Storage metadata belongs to the source item; keep the selected profile's
    // identity, name, and color after importing its complete data snapshot.
    await rm(this.storageMetadataPath(target.path), { force: true })
    await this.writeProfileMetadata(target.path, target.name, target.color)
  }

  async beginSso(id: string): Promise<void> {
    const target = await this.profile(id)
    if (target.isDefault) throw new Error('Select an isolated instance for SSO.')
    if (!(await missing(this.ssoStatePath))) throw new Error('An SSO session is already in progress. Restore the regular profile first.')
    const originalProfilePath = await this.primaryProfilePath()
    if (await missing(originalProfilePath)) throw new Error('The regular Claude profile folder was not found.')
    const [installedVersion, portableVersion] = await Promise.all([this.installedVersion(), this.fileVersion(this.portableExe)])
    if (!this.sameVersion(installedVersion, portableVersion)) throw new Error('Update the portable runtime to match the installed Claude Desktop version before signing in.')
    await this.stopAllClaude()
    await mkdir(this.localData, { recursive: true })
    await mkdir(target.path, { recursive: true })
    const backup = path.join(this.appData, `${path.basename(originalProfilePath)}.normal-profile-backup-for-${path.basename(target.path)}-${stamp()}`)
    await rename(originalProfilePath, backup)
    try {
      // Claude's browser callback is registered to the official MSIX app. A
      // junction can leave that app on a blank code screen, so the selected
      // profile is temporarily moved to the exact path that Claude expects.
      await rename(target.path, this.claudeProfilePath)
      await writeFile(this.ssoStatePath, JSON.stringify({ mode: 'swap', profileId: target.id, profileName: target.name, profilePath: target.path, originalProfileBackup: backup, originalProfilePath, startedAtUtc: new Date().toISOString() }), 'utf8')
      await this.startOfficial()
    } catch (error) {
      if (!(await missing(this.claudeProfilePath)) && (await missing(target.path))) await rename(this.claudeProfilePath, target.path)
      if ((await missing(originalProfilePath)) && !(await missing(backup))) await rename(backup, originalProfilePath)
      await rm(this.ssoStatePath, { force: true })
      throw error
    }
  }

  async continueSso(): Promise<void> {
    if (await missing(this.ssoStatePath)) throw new Error('There is no active Sign In operation.')
    await this.startOfficial()
  }

  async restoreSso(): Promise<void> {
    if (await missing(this.ssoStatePath)) throw new Error('There is no active SSO operation.')
    const state = JSON.parse(await readFile(this.ssoStatePath, 'utf8')) as { mode?: 'swap', profilePath?: string, originalProfileBackup?: string, originalProfilePath?: string }
    if (!state.originalProfileBackup || !state.profilePath) throw new Error('The saved SSO recovery state is invalid.')
    if (await missing(state.originalProfileBackup)) throw new Error('The regular Claude profile backup is missing.')
    // Older recovery states did not record the original path and always used
    // %APPDATA%\\Claude. Only accept the two paths controlled by this adapter.
    const originalProfilePath = state.originalProfilePath === this.claudeCodeProfilePath ? this.claudeCodeProfilePath : this.claudeProfilePath
    if (await this.anyClaudeRunning()) throw new Error('Quit Claude completely from its tray menu, then click Finish & Restore. This lets Claude save the new sign-in session first.')
    if (state.mode === 'swap') {
      if (await missing(this.claudeProfilePath)) throw new Error('The temporary Claude profile is missing. Recovery was stopped for safety.')
      if (!(await missing(state.profilePath))) throw new Error('The original instance folder already exists. Recovery was stopped for safety.')
      await rename(this.claudeProfilePath, state.profilePath)
    } else {
      // Recover sessions created by earlier app versions that used a junction.
      if (!(await this.isJunction(this.claudeProfilePath))) throw new Error('The regular Claude profile is no longer the temporary SSO link. Recovery was stopped for safety.')
      await this.removeJunction(this.claudeProfilePath)
    }
    await rename(state.originalProfileBackup, originalProfilePath)
    await rm(this.ssoStatePath, { force: true })
  }

  async openBackups(): Promise<void> { await mkdir(this.backupsPath, { recursive: true }); await shell.openPath(this.backupsPath) }
  async openArchives(): Promise<void> { await mkdir(this.archivesPath, { recursive: true }); await shell.openPath(this.archivesPath) }
  async storageItems(kind: StorageItemKind): Promise<StorageItem[]> {
    const root = kind === 'backup' ? this.backupsPath : this.archivesPath
    const result: StorageItem[] = []
    const activeProfileNames = new Map((await this.profiles()).map(profile => [profile.id, profile.name]))
    try {
      for (const profileDirectory of await readdir(root, { withFileTypes: true })) {
        if (!profileDirectory.isDirectory()) continue
        const profileRoot = path.join(root, profileDirectory.name)
        if (profileDirectory.name !== 'default' && !profileDirectory.name.startsWith('instance-')) continue
        for (const itemDirectory of await readdir(profileRoot, { withFileTypes: true })) {
          if (!itemDirectory.isDirectory()) continue
          const itemPath = path.join(profileRoot, itemDirectory.name)
          const metadata = await this.readStorageMetadata(itemPath)
          const createdAt = metadata?.createdAt ?? (await stat(itemPath)).birthtime.toISOString()
          const profileId = metadata?.profileId ?? profileDirectory.name
          result.push({ id: `${profileDirectory.name}/${itemDirectory.name}`, profileId, profileName: activeProfileNames.get(profileId) ?? metadata?.profileName ?? profileDirectory.name, createdAt, sizeBytes: metadata?.sizeBytes ?? null })
        }
      }
    } catch { /* The storage root is created on demand. */ }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  async deleteStorageItem(kind: StorageItemKind, id: string): Promise<void> {
    const item = (await this.storageItems(kind)).find(candidate => candidate.id === id)
    if (!item) throw new Error('Backup or archive item was not found.')
    const root = kind === 'backup' ? this.backupsPath : this.archivesPath
    await rm(path.join(root, ...item.id.split('/')), { recursive: true, force: false })
  }

  private async profiles(): Promise<ClaudeProfile[]> {
    const primaryPath = await this.primaryProfilePath()
    const result: ClaudeProfile[] = [{ id: 'default', name: 'Claude', path: primaryPath, isDefault: true, exists: !(await missing(primaryPath)), running: false, color: 'default', desktopShortcut: false, startMenuShortcut: false }]
    try {
      for (const entry of await readdir(this.profilesPath, { withFileTypes: true })) {
        const legacyMatch = /^Claude-Instance(\d+)$/.exec(entry.name)
        const namedMatch = /^CIM-Profile-([A-Za-z0-9_-]+)$/.exec(entry.name)
        if (entry.isDirectory() && (legacyMatch || namedMatch)) {
          const profilePath = path.join(this.profilesPath, entry.name)
          const fallback = legacyMatch ? `Instance ${legacyMatch[1]}` : namedMatch![1].replaceAll('_', ' ')
          const metadata = await this.profileMetadata(profilePath, fallback)
          const profile: ClaudeProfile = { id: `instance-${legacyMatch ? legacyMatch[1] : entry.name}`, name: metadata.name, path: profilePath, isDefault: false, exists: true, running: false, color: metadata.color, desktopShortcut: false, startMenuShortcut: false }
          result.push({ ...profile, ...(await this.shortcutState(profile)) })
        }
      }
    } catch { /* The profile root is created on demand. */ }
    return result.sort((a, b) => a.isDefault ? -1 : b.isDefault ? 1 : a.name.localeCompare(b.name))
  }

  private async ssoState(): Promise<{ profileId?: string, profileName?: string } | null> {
    try {
      const state = JSON.parse(await readFile(this.ssoStatePath, 'utf8')) as { profileId?: unknown, profileName?: unknown }
      return { profileId: typeof state.profileId === 'string' ? state.profileId : undefined, profileName: typeof state.profileName === 'string' ? state.profileName : undefined }
    } catch { return null }
  }

  private async primaryProfilePath(): Promise<string> {
    // Prefer the original location if both folders exist. This preserves the
    // legacy behaviour and leaves the newer Claude Code location untouched.
    if (!(await missing(this.claudeProfilePath))) return this.claudeProfilePath
    if (!(await missing(this.claudeCodeProfilePath))) return this.claudeCodeProfilePath
    return this.claudeProfilePath
  }

  private async profile(id: string): Promise<ClaudeProfile> { const found = (await this.profiles()).find(p => p.id === id); if (!found) throw new Error('Profile not found. Refresh the list and try again.'); return found }
  private normalizeProfileName(value: string): string {
    const name = value.trim().replace(/ +/g, ' ')
    if (!name) throw new Error('Enter a name for the instance')
    if (name.length > 20 || !/^[A-Za-z0-9 ]+$/.test(name)) throw new Error('Use up to 20 English letters, numbers, and spaces only')
    return name
  }
  private availableProfileName(requestedName: string, profiles: ClaudeProfile[]): string {
    const exists = (name: string) => profiles.some(profile => profile.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0)
    if (!exists(requestedName)) return requestedName
    for (let number = 1; ; number += 1) {
      const suffix = ` ${number}`
      const candidate = `${requestedName.slice(0, 60 - suffix.length)}${suffix}`
      if (!exists(candidate)) return candidate
    }
  }
  private storageMetadataPath(itemPath: string): string { return path.join(itemPath, '.cim-storage.json') }
  private async writeStorageMetadata(itemPath: string, profile: ClaudeProfile, kind: StorageItemKind, sizeBytes: number): Promise<void> { await writeFile(this.storageMetadataPath(itemPath), JSON.stringify({ profileId: profile.id, profileName: profile.name, kind, createdAt: new Date().toISOString(), sizeBytes }, null, 2), 'utf8') }
  private async readStorageMetadata(itemPath: string): Promise<{ profileId: string, profileName: string, createdAt: string, sizeBytes: number | null } | null> { try { const value = JSON.parse(await readFile(this.storageMetadataPath(itemPath), 'utf8')) as { profileId?: unknown, profileName?: unknown, createdAt?: unknown, sizeBytes?: unknown }; return typeof value.profileId === 'string' && typeof value.profileName === 'string' && typeof value.createdAt === 'string' ? { profileId: value.profileId, profileName: value.profileName, createdAt: value.createdAt, sizeBytes: typeof value.sizeBytes === 'number' && Number.isFinite(value.sizeBytes) ? value.sizeBytes : null } : null } catch { return null } }
  private async directorySize(directory: string): Promise<number> { let total = 0; for (const entry of await readdir(directory, { withFileTypes: true })) { const entryPath = path.join(directory, entry.name); if (entry.isDirectory()) total += await this.directorySize(entryPath); else if (entry.isFile()) total += (await stat(entryPath)).size } return total }
  private profileProcessCommand(profile: ClaudeProfile): string {
    return profile.isDefault
      ? `$items=@(Get-CimInstance Win32_Process -Filter \"Name='Claude.exe'\" | Where-Object { $_.ExecutablePath -like '*\\WindowsApps\\Claude_*' -and $_.CommandLine -notlike '*--type=*' }); $windowProcess=($items | ForEach-Object { $process=Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; if ($process -and $process.MainWindowHandle -ne 0) { $_.ProcessId } } | Select-Object -First 1); if ($windowProcess) { $windowProcess } else { ($items | Select-Object -First 1).ProcessId }`
      : `$target=${quote(profile.path)}; $items=@(Get-CimInstance Win32_Process -Filter \"Name='Claude.exe'\" | Where-Object { $_.CommandLine -like ('*' + $target + '*') -and $_.CommandLine -notlike '*--type=*' }); $windowProcess=($items | ForEach-Object { $process=Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; if ($process -and $process.MainWindowHandle -ne 0) { $_.ProcessId } } | Select-Object -First 1); if ($windowProcess) { $windowProcess } else { ($items | Select-Object -First 1).ProcessId }`
  }
  private profileProcessIdsCommand(profile: ClaudeProfile): string {
    return profile.isDefault
      ? "Get-CimInstance Win32_Process -Filter \"Name='Claude.exe'\" | Where-Object { $_.ExecutablePath -like '*\\WindowsApps\\Claude_*' } | Select-Object -ExpandProperty ProcessId"
      : `$target=${quote(profile.path)}; Get-CimInstance Win32_Process -Filter \"Name='Claude.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine -like ('*' + $target + '*') } | Select-Object -ExpandProperty ProcessId`
  }
  private async profileProcessIds(profile: ClaudeProfile): Promise<number[]> {
    const raw = await this.powerShell(this.profileProcessIdsCommand(profile))
    return [...new Set((raw.match(/\d+/g) ?? []).map(Number).filter(processId => Number.isInteger(processId) && processId > 0))]
  }
  private async profileProcessId(profile: ClaudeProfile): Promise<number | null> { const processId = Number(await this.powerShell(this.profileProcessCommand(profile))); return Number.isInteger(processId) && processId > 0 ? processId : null }
  private async waitForProfileStopped(profile: ClaudeProfile): Promise<void> {
    for (let attempt = 0; attempt < 24; attempt += 1) {
      if (!(await this.profileProcessId(profile))) return
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
  private async waitForProfileProcessesStopped(profile: ClaudeProfile): Promise<void> {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      if ((await this.profileProcessIds(profile)).length === 0) return
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    throw new Error('Claude is still closing. Wait a moment and try the backup again.')
  }
  private async runningStates(profiles: ClaudeProfile[]): Promise<Record<string, boolean>> {
    const raw = await this.powerShell("Get-CimInstance Win32_Process -Filter \"Name='Claude.exe'\" | Select-Object ExecutablePath,CommandLine | ConvertTo-Json -Compress")
    let processes: Array<{ ExecutablePath?: string, CommandLine?: string }> = []
    try { const parsed = JSON.parse(raw) as unknown; processes = Array.isArray(parsed) ? parsed as Array<{ ExecutablePath?: string, CommandLine?: string }> : parsed ? [parsed as { ExecutablePath?: string, CommandLine?: string }] : [] } catch { /* No running Claude process or no process query access. */ }
    const result: Record<string, boolean> = {}
    for (const profile of profiles) {
      result[profile.id] = profile.isDefault
        ? processes.some(process => process.ExecutablePath?.toLowerCase().includes('\\windowsapps\\claude_'))
        : processes.some(process => process.CommandLine?.toLowerCase().includes(profile.path.toLowerCase()) && !process.CommandLine.toLowerCase().includes('--type='))
    }
    return result
  }
  private profileMetaPath(profilePath: string): string { return path.join(profilePath, 'instance.json') }
  private async writeProfileMetadata(profilePath: string, name: string, color: ProfileColor): Promise<void> { await writeFile(this.profileMetaPath(profilePath), JSON.stringify({ name, color }, null, 2), 'utf8') }
  private async profileMetadata(profilePath: string, fallbackName: string): Promise<{ name: string, color: ProfileColor }> { try { const meta = JSON.parse(await readFile(this.profileMetaPath(profilePath), 'utf8')) as { name?: unknown, color?: unknown }; return { name: typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : fallbackName, color: typeof meta.color === 'string' && supportedProfileColors.includes(meta.color as ProfileColor) ? meta.color as ProfileColor : 'default' } } catch { return { name: fallbackName, color: 'default' } } }
  // Bump this identity when changing an icon resource: Windows caches taskbar
  // icons by AppUserModelID and otherwise keeps a stale (previously grayscale)
  // icon even after the ICO file has been replaced.
  private profileAppUserModelId(profile: ClaudeProfile): string { return `com.claude-instance-manager.profile.v3.${profile.id}` }
  private async applyTaskbarIdentity(profile: ClaudeProfile, processId: number): Promise<void> {
    const helper = path.join(process.resourcesPath, 'TaskbarHelper.exe')
    if (await missing(helper)) return
    spawn(helper, [String(processId), this.profileAppUserModelId(profile), profile.name, this.profileIconPath(profile.color)], { detached: true, stdio: 'ignore' }).unref()
  }
  private requestProfileShow(profile: ClaudeProfile): void {
    if (profile.isDefault) {
      void this.startOfficial()
      return
    }
    spawn(this.portableExe, [`--user-data-dir=${profile.path}`, `--app-user-model-id=${this.profileAppUserModelId(profile)}`], { detached: true, stdio: 'ignore' }).unref()
  }
  // Default must be the icon embedded in the actual Claude executable, not a
  // converted ICO. This preserves Claude's original color treatment exactly.
  private profileIconPath(color: ProfileColor): string { return color === 'default' ? this.portableExe : path.join(process.resourcesPath, 'Assets', `claude-profile-${color}.ico`) }
  private shortcutDirectories(): Array<{ key: 'desktopShortcut' | 'startMenuShortcut', path: string }> {
    return [
      { key: 'desktopShortcut', path: app.getPath('desktop') },
      { key: 'startMenuShortcut', path: path.join(this.appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs') }
    ]
  }
  private shortcutRemovalDirectories(): Array<{ key: 'desktopShortcut' | 'startMenuShortcut', path: string }> {
    const directories = this.shortcutDirectories()
    const legacyDesktop = path.join(process.env.USERPROFILE ?? '', 'Desktop')
    if (legacyDesktop.toLowerCase() !== app.getPath('desktop').toLowerCase()) directories.push({ key: 'desktopShortcut', path: legacyDesktop })
    return directories
  }
  private async shortcutState(profile: ClaudeProfile): Promise<Pick<ClaudeProfile, 'desktopShortcut' | 'startMenuShortcut'>> {
    const result = { desktopShortcut: false, startMenuShortcut: false }
    for (const directory of this.shortcutDirectories()) {
      try {
        for (const entry of await readdir(directory.path, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.lnk')) continue
          const details = shell.readShortcutLink(path.join(directory.path, entry.name))
          if (details?.args?.replaceAll('"', '').includes(`--user-data-dir=${profile.path}`)) result[directory.key] = true
        }
      } catch { /* A shortcut folder may not exist yet. */ }
    }
    return result
  }
  private async removeProfileShortcuts(profile: ClaudeProfile): Promise<void> {
    for (const directory of this.shortcutRemovalDirectories()) {
      try {
        for (const entry of await readdir(directory.path, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.lnk')) continue
          const shortcutPath = path.join(directory.path, entry.name)
          const details = shell.readShortcutLink(shortcutPath)
          if (details?.args?.replaceAll('"', '').includes(`--user-data-dir=${profile.path}`)) await rm(shortcutPath, { force: true })
        }
      } catch { /* Nothing to remove. */ }
    }
  }
  private async createShortcuts(profile: ClaudeProfile, options: Pick<CreateProfileOptions, 'desktopShortcut' | 'startMenuShortcut'>): Promise<void> {
    if (!options.desktopShortcut && !options.startMenuShortcut) return
    if (await missing(this.portableExe)) throw new Error('Prepare the portable Claude copy before creating shortcuts.')
    const shortcutName = `Claude — ${profile.name}.lnk`
    const appUserModelId = this.profileAppUserModelId(profile)
    const details = { target: this.portableExe, args: `--user-data-dir=${profile.path} --app-user-model-id=${appUserModelId}`, description: `Claude profile: ${profile.name}`, icon: this.profileIconPath(profile.color), iconIndex: 0, appUserModelId }
    for (const destination of this.shortcutDirectories()) {
      if (!options[destination.key]) continue
      await mkdir(destination.path, { recursive: true })
      if (!shell.writeShortcutLink(path.join(destination.path, shortcutName), 'create', details)) throw new Error(`Could not create the shortcut for ${profile.name}.`)
    }
  }
  private async installedVersion(): Promise<string | null> { const value = await this.powerShell("(Get-AppxPackage -Name 'Claude*' | Where-Object {$_.PackageFullName -notlike '42109FactoriaDatacenter*'} | Sort-Object Version -Descending | Select-Object -First 1 -ExpandProperty Version)"); return value || null }
  private async appInstallPath(): Promise<string | null> { const value = await this.powerShell("(Get-AppxPackage -Name 'Claude*' | Where-Object {$_.PackageFullName -notlike '42109FactoriaDatacenter*'} | Sort-Object Version -Descending | Select-Object -First 1 -ExpandProperty InstallLocation)"); return value ? path.join(value, 'app') : null }
  private async fileVersion(file: string): Promise<string | null> {
    return (await this.powerShell(`$version=(Get-Item ${quote(file)}).VersionInfo; '{0}.{1}.{2}.{3}' -f $version.ProductMajorPart,$version.ProductMinorPart,$version.ProductBuildPart,$version.ProductPrivatePart`)) || null
  }
  private sameVersion(left: string | null, right: string | null): boolean { return !!left && !!right && left.replace(/(?:\.0)+$/, '') === right.replace(/(?:\.0)+$/, '') }
  private async startOfficial(): Promise<void> { const aumid = await this.powerShell("(Get-StartApps | Where-Object {$_.AppID -like 'Claude_*' -and $_.AppID -like '*!Claude'} | Select-Object -First 1 -ExpandProperty AppID)"); if (!aumid) throw new Error('Claude Desktop was not found.'); spawn('explorer.exe', [`shell:AppsFolder\\${aumid}`], { detached: true, stdio: 'ignore' }).unref() }
  private async stopOfficialClaude(): Promise<void> { await this.powerShell("Get-CimInstance Win32_Process -Filter \"Name='Claude.exe'\" | Where-Object { $_.ExecutablePath -like '*\\WindowsApps\\Claude_*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }") }
  private async stopAllClaude(): Promise<void> {
    // Give Claude a normal shutdown first. Auth tokens can be written during
    // app shutdown, so immediately forcing every process can leave a newly
    // completed Sign In session incomplete on disk.
    await execFileAsync('taskkill.exe', ['/IM', 'Claude.exe', '/T'], { windowsHide: true }).catch(() => undefined)
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const remaining = await this.powerShell("@(Get-Process Claude -ErrorAction SilentlyContinue).Count")
      if (remaining === '0') return
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    // Claude may be hidden in its tray or keep a child process alive. Use the
    // forced fallback only after it had time to persist its normal shutdown.
    await execFileAsync('taskkill.exe', ['/IM', 'Claude.exe', '/F', '/T'], { windowsHide: true }).catch(() => undefined)
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const remaining = await this.powerShell("@(Get-Process Claude -ErrorAction SilentlyContinue).Count")
      if (remaining === '0') return
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    throw new Error('Claude is still closing. Wait a moment and start SignIn again.')
  }
  private async anyClaudeRunning(): Promise<boolean> { return (await this.powerShell("@(Get-Process Claude -ErrorAction SilentlyContinue).Count")) !== '0' }
  private async removeJunction(linkPath: string): Promise<void> { await execFileAsync('cmd.exe', ['/c', 'rmdir', linkPath]) }
  private async isJunction(directory: string): Promise<boolean> { return (await this.powerShell(`if (Test-Path -LiteralPath ${quote(directory)}) { ((Get-Item -Force -LiteralPath ${quote(directory)}).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }`)).toLowerCase() === 'true' }
  private async powerShell(command: string): Promise<string> { try { const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 15_000 }); return stdout.trim() } catch { return '' } }
}

const ps = (value: string) => `'${value.replaceAll("'", "''")}'`
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '')
