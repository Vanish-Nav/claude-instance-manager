import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { access, mkdir, readdir, rename, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { app, shell } from 'electron'
import type { BackupTier, ClaudeProfile, CopyTier, CreateProfileOptions, ImportResult, ImportSelection, ManagerSettings, ManagerState, ProfileColor, ProfileSizes, SourceContents, StorageItem, StorageItemKind, StorageTier } from '../shared/contracts'
import type { DeepLinkRoute, PlatformAdapter } from './platform'
import { WindowsProfilePaths } from './windows-profile-paths'
import { ClaudeInstallResolver, installLabels, type ClaudeInstall } from './windows-claude-install'
import * as profileBackup from './windows-profile-backup'

const execFileAsync = promisify(execFile)
const missing = async (value: string): Promise<boolean> => access(value, constants.F_OK).then(() => false).catch(() => true)
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))
const supportedProfileColors: ProfileColor[] = ['default', 'green', 'teal', 'blue', 'indigo', 'violet', 'rose', 'red', 'amber']
const storageTiers: StorageTier[] = ['session', 'full', 'settings', 'archive']
const claudeProcessQuery = "Get-CimInstance Win32_Process -Filter \"Name='Claude.exe'\" | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress"

export class PowerShellError extends Error {}

export const primaryRunningMessage = 'The primary Claude is running. Close it first so its browser callbacks can be redirected to the selected instance.'

interface ClaudeProcess { processId: number, executablePath: string, commandLine: string }
interface SignInState { profileId: string, profileName: string, relayProcessId: number, title: string, startedAtUtc: string }
interface Settings { deepLinkRouter: boolean, portableCleanupDismissed: boolean, portableRemovalPending: boolean, lastPrimaryDataPath: string | null, lastFocusedProfileId: string | null }
interface Router { child: ChildProcess, title: string, lastEvent: string | null }

const defaultSettings: Settings = { deepLinkRouter: false, portableCleanupDismissed: false, portableRemovalPending: false, lastPrimaryDataPath: null, lastFocusedProfileId: null }

export class WindowsAdapter implements PlatformAdapter {
  readonly platform = 'windows' as const
  private readonly appData = process.env.APPDATA ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming')
  private readonly localAppData = process.env.LOCALAPPDATA ?? this.appData
  private readonly userProfile = process.env.USERPROFILE ?? path.dirname(this.appData)
  private readonly localData = path.join(this.localAppData, 'ClaudeInstanceManager')
  private readonly claudeProfilePath = path.join(this.appData, 'Claude')
  private readonly claudeProjectsRoot = path.join(this.userProfile, '.claude', 'projects')
  private readonly portablePath = path.join(this.localData, 'Portable')
  private readonly profilesPath = path.join(this.localData, 'Profiles')
  private readonly backupsPath = path.join(this.localData, 'Backups')
  private readonly archivesPath = path.join(this.localData, 'Archives')
  private readonly ssoStatePath = path.join(this.localData, 'sso-state.json')
  private readonly signInStatePath = path.join(this.localData, 'sign-in-state.json')
  private readonly settingsPath = path.join(this.localData, 'settings.json')
  private readonly resolver = new ClaudeInstallResolver({ localAppData: this.localAppData, powerShell: command => this.powerShell(command) })
  private installCache: Promise<ClaudeInstall | null> | null = null
  private installCandidates = 0
  private shortcutsMigrated = false
  private portableSize: Promise<number | null> | null = null
  private taskbarHelpers = new Map<string, ChildProcess>()
  private router: Router | null = null
  private deepLinkHandler: ((url: string) => void) | null = null

  async getState(refreshInstall = false): Promise<ManagerState> {
    if (refreshInstall) {
      this.installCache = null
    }
    // A failed process query shows every profile as stopped here; actions
    // that must know for sure query again and surface the failure.
    const processes = await this.claudeProcesses().catch(() => [] as ClaudeProcess[])
    const install = await this.install(processes).catch(() => null)
    await this.migrateShortcutsOnce(install, await this.profiles())
    const profiles = await this.profiles()
    const runningStates = this.runningStates(profiles, processes, install)
    const profilesWithStatus = profiles.map(profile => ({ ...profile, running: runningStates[profile.id] ?? false }))
    await this.ensureTaskbarIdentities(profilesWithStatus, processes, install)
    const signIn = await this.signInState()
    const settings = await this.settings()
    return {
      platform: this.platform,
      installedVersion: install?.version ?? null,
      install: install ? { kind: install.kind, label: installLabels[install.kind], version: install.version, launchTarget: install.launchTarget, candidates: this.installCandidates } : null,
      profiles: profilesWithStatus,
      pendingSignIn: signIn !== null,
      pendingSignInProfileId: signIn?.profileId ?? null,
      pendingSignInProfileName: signIn?.profileName ?? null,
      legacySignInRecovery: !(await missing(this.ssoStatePath)),
      portableCleanup: await this.portableCleanup(settings),
      deepLinkRouter: { enabled: settings.deepLinkRouter, active: this.router !== null }
    }
  }

  async profileRunningStates(): Promise<Record<string, boolean>> {
    const processes = await this.claudeProcesses().catch(() => [] as ClaudeProcess[])
    const install = await this.install(processes).catch(() => null)
    const profiles = await this.profiles()
    const runningStates = this.runningStates(profiles, processes, install)
    // Instances started by a shortcut while the manager was closed get their
    // taskbar identity on the next poll.
    await this.ensureTaskbarIdentities(profiles.map(profile => ({ ...profile, running: runningStates[profile.id] ?? false })), processes, install)
    return runningStates
  }

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
    if (profile.isDefault) {
      throw new Error('The regular Claude profile name cannot be changed.')
    }
    const name = this.normalizeProfileName(nextName)
    const profiles = await this.profiles()
    if (profiles.some(item => item.id !== id && item.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0)) {
      throw new Error('An instance with this name already exists.')
    }
    await this.writeProfileMetadata(profile.path, name, profile.color)
    const renamed = { ...profile, name }
    // The taskbar display name is applied by a helper that keeps running with
    // the old name; restart it so the button shows the new one.
    const processId = await this.profileProcessId(renamed)
    if (processId) {
      await this.restartTaskbarHelper(renamed, processId)
    }
    await this.refreshPinnedShortcuts(renamed)
    return renamed
  }

  async setProfileColor(id: string, color: ProfileColor): Promise<ClaudeProfile> {
    if (!supportedProfileColors.includes(color)) {
      throw new Error('Unsupported profile color.')
    }
    const profile = await this.profile(id)
    if (profile.isDefault) {
      throw new Error('The regular Claude profile color cannot be changed.')
    }
    if (profile.color === color) {
      return profile
    }
    const wasRunning = await this.profileProcessId(profile)
    await this.writeProfileMetadata(profile.path, profile.name, color)
    if (wasRunning) {
      await this.stopProfile(profile.id)
      await delay(900)
      await this.startProfile(profile.id)
    }
    await this.refreshPinnedShortcuts({ ...profile, color })
    return { ...profile, color }
  }

  async setProfileShortcuts(id: string, options: Pick<CreateProfileOptions, 'desktopShortcut' | 'startMenuShortcut'>): Promise<ClaudeProfile> {
    const profile = await this.profile(id)
    if (profile.isDefault) {
      throw new Error('Shortcuts are only available for isolated instances.')
    }
    await this.removeProfileShortcuts(profile)
    await this.createShortcuts(profile, options)
    return { ...profile, ...options }
  }

  // Every child gets an explicit working directory: a child that inherits the
  // manager's folder (for example win-unpacked opened in Explorer) keeps that
  // folder locked for as long as it runs.
  async startProfile(id: string): Promise<void> {
    const profile = await this.profile(id)
    const install = await this.requireInstall()
    const processes = await this.claudeProcesses()
    if (this.profileProcesses(profile, processes, install).length > 0) {
      // Do not touch an already-running window with TaskbarHelper or WinAPI.
      // A second launch is forwarded by Claude's own ProcessSingleton, which
      // shows the window like its tray "Show App" action.
      await this.requestProfileShow(profile, install)
      return
    }
    if (profile.isDefault) {
      await this.startOfficial(install)
      return
    }
    await mkdir(profile.path, { recursive: true })
    const child = spawn(install.launchTarget, this.instanceArguments(profile), { detached: true, stdio: 'ignore', cwd: this.userProfile })
    child.unref()
    if (child.pid) {
      await this.applyTaskbarIdentity(profile, child.pid)
    }
    await this.rememberFocus(profile.id)
  }

  async stopProfile(id: string): Promise<void> {
    const profile = await this.profile(id)
    const install = await this.install()
    const processes = await this.claudeProcesses()
    const targets = this.profileProcesses(profile, processes, install)
    if (targets.length === 0) {
      return
    }
    // A plain taskkill sends WM_CLOSE so Claude can persist its state; the
    // forced variant runs only once the process had time to shut down.
    await this.taskkill(targets.map(item => item.processId), false)
    if (await this.waitForProfileStopped(profile, 24)) {
      return
    }
    await this.taskkill(targets.map(item => item.processId), true)
    await this.waitForProfileStopped(profile, 16)
  }

  async stopAllClaude(): Promise<void> {
    // Give Claude a normal shutdown first. Auth tokens can be written during
    // app shutdown, so immediately forcing every process can leave a newly
    // completed Sign In session incomplete on disk.
    await execFileAsync('taskkill.exe', ['/IM', 'Claude.exe', '/T'], { windowsHide: true }).catch(() => undefined)
    if (await this.waitForAllStopped(24)) {
      return
    }
    await execFileAsync('taskkill.exe', ['/IM', 'Claude.exe', '/F', '/T'], { windowsHide: true }).catch(() => undefined)
    if (!(await this.waitForAllStopped(16))) {
      throw new Error('Claude is still closing. Wait a moment and try again.')
    }
  }

  async backupProfile(id: string, tier: BackupTier = 'full'): Promise<string> {
    const profile = await this.profile(id)
    if (await missing(profile.path)) {
      throw new Error('The selected profile folder does not exist.')
    }
    if (!['session', 'full', 'settings'].includes(tier)) {
      throw new Error('Unsupported backup tier.')
    }
    // Chromium keeps its SQLite cookie database open while Claude is running.
    // Always close the selected profile first, then wait for all child
    // processes to release their file handles before copying.
    await this.stopProfile(profile.id)
    await this.waitForProfileProcessesStopped(profile)
    const target = await this.newStoragePath(this.backupsPath, profile)
    await profileBackup.copyTier(profile.path, target, { tier, claudeProjectsRoot: this.claudeProjectsRoot })
    await this.writeStorageMetadata(target, profile, 'backup', tier, await profileBackup.directorySize(target))
    return target
  }

  async profileSizes(id: string): Promise<ProfileSizes> {
    const profile = await this.profile(id)
    if (await missing(profile.path)) {
      return { entries: [], projectsBytes: 0, sessionBytes: 0, fullBytes: 0, cacheBytes: 0 }
    }
    return profileBackup.profileSizes(profile.path, this.claudeProjectsRoot)
  }

  async cleanCaches(id: string, names: string[]): Promise<void> {
    const profile = await this.profile(id)
    const allowed = new Set(profileBackup.cacheEntries.map(name => name.toLowerCase()))
    const unknown = names.find(name => !allowed.has(name.toLowerCase()))
    if (unknown) {
      throw new Error(`${unknown} is not a cache folder.`)
    }
    if (await this.profileProcessId(profile)) {
      throw new Error('Close this instance before cleaning its caches.')
    }
    for (const name of names) {
      await rm(path.join(profile.path, name), { recursive: true, force: true })
    }
  }

  async cloneSession(sourceId: string, targetId: string, createBackup = true, tier: CopyTier = 'session', selection: ImportSelection | null = null): Promise<void> {
    const source = await this.profile(sourceId)
    const target = await this.profile(targetId)
    if (target.isDefault) {
      throw new Error('Select an isolated instance as the copy target.')
    }
    if (source.id === target.id) {
      throw new Error('Choose a different instance to copy from.')
    }
    if (tier !== 'session' && tier !== 'settings') {
      throw new Error('Unsupported copy tier.')
    }
    if (await missing(source.path)) {
      throw new Error('The source profile folder does not exist.')
    }
    // The source must be closed as well: Chromium keeps its databases open.
    await this.stopProfile(source.id)
    await this.waitForProfileProcessesStopped(source)
    await this.stopProfile(target.id)
    await this.waitForProfileProcessesStopped(target)
    if (createBackup) {
      await this.backupProfile(target.id, 'session')
    }
    await profileBackup.restoreTier(source.path, target.path, { tier, claudeProjectsRoot: this.claudeProjectsRoot, selection })
    if (tier === 'session') {
      // Two instances must not share one device id.
      await writeFile(path.join(target.path, 'ant-did'), profileBackup.newDeviceId(), 'utf8')
    }
    await this.writeProfileMetadata(target.path, target.name, target.color)
  }

  async profileContents(id: string): Promise<SourceContents> {
    const profile = await this.profile(id)
    return profileBackup.sourceContents(profile.path)
  }

  async storageItemContents(kind: StorageItemKind, itemId: string): Promise<SourceContents> {
    const item = (await this.storageItems(kind)).find(candidate => candidate.id === itemId)
    if (!item) {
      throw new Error('The selected backup or archive was not found.')
    }
    return profileBackup.sourceContents(path.join(kind === 'backup' ? this.backupsPath : this.archivesPath, ...item.id.split('/')))
  }

  async archiveProfile(id: string): Promise<string> {
    const profile = await this.profile(id)
    if (profile.isDefault) {
      throw new Error('The regular Claude profile cannot be removed.')
    }
    await this.stopProfile(profile.id)
    await this.waitForProfileProcessesStopped(profile)
    const target = await this.newStoragePath(this.archivesPath, profile)
    await rename(profile.path, target)
    await this.writeStorageMetadata(target, profile, 'archive', 'archive', await profileBackup.directorySize(target))
    return target
  }

  async deleteProfile(id: string): Promise<void> {
    const profile = await this.profile(id)
    if (profile.isDefault) {
      throw new Error('The regular Claude profile cannot be deleted.')
    }
    await this.stopProfile(profile.id)
    await this.waitForProfileProcessesStopped(profile)
    await this.removeProfileShortcuts(profile)
    await rm(profile.path, { recursive: true, force: false })
  }

  async importStorageItem(targetId: string, kind: StorageItemKind, itemId: string, createBackup = true, selection: ImportSelection | null = null): Promise<ImportResult> {
    const target = await this.profile(targetId)
    if (target.isDefault) {
      throw new Error('Select an isolated instance to import data.')
    }
    const item = (await this.storageItems(kind)).find(candidate => candidate.id === itemId)
    if (!item) {
      throw new Error('The selected backup or archive was not found.')
    }
    const root = kind === 'backup' ? this.backupsPath : this.archivesPath
    const source = path.join(root, ...item.id.split('/'))
    const tier: BackupTier = item.tier === 'archive' ? 'full' : item.tier
    await this.stopProfile(target.id)
    await this.waitForProfileProcessesStopped(target)
    if (createBackup) {
      await this.backupProfile(target.id, 'full')
    }
    await profileBackup.restoreTier(source, target.path, { tier, claudeProjectsRoot: this.claudeProjectsRoot, selection })
    // Storage metadata belongs to the source item; keep the selected profile's
    // identity, name, and color after importing its data.
    await rm(this.storageMetadataPath(target.path), { force: true })
    await this.writeProfileMetadata(target.path, target.name, target.color)
    return { missingProjects: await profileBackup.missingProjects(target.path) }
  }

  async beginSignIn(id: string, closePrimary = false): Promise<void> {
    const target = await this.profile(id)
    if (target.isDefault) {
      throw new Error('Select an isolated instance to sign in.')
    }
    if (await this.signInState()) {
      throw new Error('A Sign In is already in progress. Finish it first.')
    }
    if (!(await missing(this.ssoStatePath))) {
      throw new Error('A Sign In from an earlier version is still waiting for Finish & Restore. Complete that recovery first.')
    }
    const install = await this.requireInstall()
    const helper = this.helperPath()
    if (await missing(helper)) {
      throw new Error('TaskbarHelper.exe is missing from the installation. Reinstall Claude Instance Manager.')
    }
    const processes = await this.claudeProcesses()
    const primary = (await this.profiles()).find(profile => profile.isDefault)!
    const primaryProcesses = this.profileProcesses(primary, processes, install)
    const settings = await this.settings()
    let title = settings.lastPrimaryDataPath
    if (primaryProcesses.length > 0) {
      // The live primary knows its own data folder best; its single-instance
      // window carries that path as the title. Read it before closing it.
      title = (await this.singletonTitle(primaryProcesses.map(item => item.processId))) ?? title
      if (!closePrimary) {
        throw new Error(primaryRunningMessage)
      }
      await this.stopProfile(primary.id)
      if (await this.profileProcessId(primary)) {
        throw new Error('The primary Claude is still closing. Wait a moment and try again.')
      }
    }
    if (!title) {
      title = await (await this.profilePaths()).primary()
    }
    await this.saveSettings({ lastPrimaryDataPath: title })
    await this.stopRouter()
    if (this.profileProcesses(target, processes, install).length === 0) {
      await this.startProfile(target.id)
    }
    const relay = spawn(helper, ['--relay', title, install.launchTarget, target.path], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, cwd: this.userProfile })
    const ready = await this.waitForRelayReady(relay)
    if (!ready || !relay.pid) {
      relay.kill()
      throw new Error('The sign-in relay could not take over the Claude single-instance window. Make sure no Claude.exe without a profile is running, then try again.')
    }
    relay.stdout?.destroy()
    relay.unref()
    const state: SignInState = { profileId: target.id, profileName: target.name, relayProcessId: relay.pid, title, startedAtUtc: new Date().toISOString() }
    await mkdir(this.localData, { recursive: true })
    await writeFile(this.signInStatePath, JSON.stringify(state, null, 2), 'utf8')
  }

  async finishSignIn(): Promise<void> {
    const state = await this.signInState()
    if (!state) {
      // The relay ends by itself when the primary Claude is started; finishing
      // an already finished Sign In is not an error.
      return
    }
    if (await this.isTaskbarHelper(state.relayProcessId)) {
      try {
        process.kill(state.relayProcessId)
      } catch { /* The relay already ended. */ }
    }
    await rm(this.signInStatePath, { force: true })
  }

  async restoreSso(): Promise<void> {
    // Recovery of the profile-swap Sign In used by versions before 1.1.
    if (await missing(this.ssoStatePath)) {
      throw new Error('There is no active SSO operation.')
    }
    const state = JSON.parse(await readFile(this.ssoStatePath, 'utf8')) as { mode?: 'swap', profilePath?: string, originalProfileBackup?: string, originalProfilePath?: string, signInProfilePath?: string, signInToken?: string }
    if (!state.originalProfileBackup || !state.profilePath) {
      throw new Error('The saved SSO recovery state is invalid.')
    }
    if (state.mode !== 'swap') {
      throw new Error('This recovery state was created by a junction-based Sign In that is no longer supported. Remove the link at the regular profile location by hand, then move the backup folder back.')
    }
    if (await missing(state.originalProfileBackup)) {
      throw new Error('The regular Claude profile backup is missing.')
    }
    const originalProfilePath = state.originalProfilePath ?? this.claudeProfilePath
    const signInProfilePath = state.signInProfilePath ?? this.claudeProfilePath
    const profilePaths = await this.profilePaths()
    if (!profilePaths.contains(originalProfilePath) || !profilePaths.contains(signInProfilePath)) {
      throw new Error('The saved Sign In profile location is invalid. Recovery was stopped for safety.')
    }
    if (await this.anyClaudeRunning()) {
      throw new Error('Quit Claude completely from its tray menu, then click Finish & Restore. This lets Claude save the new sign-in session first.')
    }
    // A Claude update can migrate the temporary profile during Sign In.
    // A per-operation marker identifies it without guessing from old folders.
    const alreadyReturned = state.signInToken && await readFile(path.join(state.profilePath, '.cim-sign-in'), 'utf8').catch(() => null) === state.signInToken
    if (alreadyReturned) {
      if (!(await missing(originalProfilePath))) {
        throw new Error('The regular Claude profile location is occupied. Recovery was stopped for safety; the recovery backup has been preserved.')
      }
    } else {
      const temporaryPath = state.signInToken ? await this.findSignInProfile(state.signInToken, profilePaths) : signInProfilePath
      if (!temporaryPath || await missing(temporaryPath)) {
        throw new Error('The temporary Claude profile is missing. Recovery was stopped for safety.')
      }
      if (!(await missing(state.profilePath))) {
        throw new Error('The original instance folder already exists. Recovery was stopped for safety.')
      }
      if (originalProfilePath !== temporaryPath && !(await missing(originalProfilePath))) {
        throw new Error('The regular Claude profile location is occupied. Recovery was stopped for safety; the recovery backup has been preserved.')
      }
      await rename(temporaryPath, state.profilePath)
    }
    await rename(state.originalProfileBackup, originalProfilePath)
    if (state.signInToken) {
      await rm(path.join(state.profilePath, '.cim-sign-in'), { force: true })
    }
    await rm(this.ssoStatePath, { force: true })
  }

  async removePortableRuntime(): Promise<void> {
    const processes = await this.claudeProcesses()
    if (processes.some(item => item.executablePath.toLowerCase().startsWith(this.portablePath.toLowerCase()))) {
      throw new Error('An instance started from the portable copy is still running. Close it first.')
    }
    this.portableSize = null
    try {
      await rm(this.portablePath, { recursive: true, force: true, maxRetries: 2, retryDelay: 300 })
    } catch (error) {
      const failure = error as NodeJS.ErrnoException
      const file = failure.path ? path.relative(this.portablePath, failure.path) : 'a file'
      const holders = failure.path ? await this.fileHolders(failure.path) : []
      // Everything deletable is gone; the rest is cleaned up quietly later.
      await this.saveSettings({ portableCleanupDismissed: true, portableRemovalPending: true })
      const by = holders.length > 0 ? `${holders.join(', ')} keeps it open` : 'another program keeps it open'
      throw new Error(`The portable copy was removed except ${file}: ${by} (${failure.code ?? 'error'}). The leftover is deleted automatically once it is released, at the latest after a Windows restart.`)
    }
    await this.saveSettings({ portableCleanupDismissed: true, portableRemovalPending: false })
  }

  async dismissPortableCleanup(): Promise<void> {
    await this.saveSettings({ portableCleanupDismissed: true })
  }

  async getManagerSettings(): Promise<ManagerSettings> {
    return { deepLinkRouter: (await this.settings()).deepLinkRouter }
  }

  async setDeepLinkRouter(enabled: boolean): Promise<ManagerSettings> {
    await this.saveSettings({ deepLinkRouter: enabled })
    await this.syncDeepLinkRouter()
    return this.getManagerSettings()
  }

  async openBackups(): Promise<void> {
    await mkdir(this.backupsPath, { recursive: true })
    await shell.openPath(this.backupsPath)
  }

  async openArchives(): Promise<void> {
    await mkdir(this.archivesPath, { recursive: true })
    await shell.openPath(this.archivesPath)
  }

  async storageItems(kind: StorageItemKind): Promise<StorageItem[]> {
    const root = kind === 'backup' ? this.backupsPath : this.archivesPath
    const result: StorageItem[] = []
    const activeProfileNames = new Map((await this.profiles()).map(profile => [profile.id, profile.name]))
    try {
      for (const profileDirectory of await readdir(root, { withFileTypes: true })) {
        if (!profileDirectory.isDirectory()) {
          continue
        }
        const profileRoot = path.join(root, profileDirectory.name)
        if (profileDirectory.name !== 'default' && !profileDirectory.name.startsWith('instance-')) {
          continue
        }
        for (const itemDirectory of await readdir(profileRoot, { withFileTypes: true })) {
          if (!itemDirectory.isDirectory()) {
            continue
          }
          const itemPath = path.join(profileRoot, itemDirectory.name)
          const metadata = await this.readStorageMetadata(itemPath)
          const createdAt = metadata?.createdAt ?? (await stat(itemPath)).birthtime.toISOString()
          const profileId = metadata?.profileId ?? profileDirectory.name
          // Items written before tiers existed were complete copies.
          const tier: StorageTier = metadata?.tier ?? (kind === 'archive' ? 'archive' : 'full')
          result.push({ id: `${profileDirectory.name}/${itemDirectory.name}`, profileId, profileName: activeProfileNames.get(profileId) ?? metadata?.profileName ?? profileDirectory.name, createdAt, sizeBytes: metadata?.sizeBytes ?? null, tier })
        }
      }
    } catch { /* The storage root is created on demand. */ }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async deleteStorageItem(kind: StorageItemKind, id: string): Promise<void> {
    const item = (await this.storageItems(kind)).find(candidate => candidate.id === id)
    if (!item) {
      throw new Error('Backup or archive item was not found.')
    }
    const root = kind === 'backup' ? this.backupsPath : this.archivesPath
    await rm(path.join(root, ...item.id.split('/')), { recursive: true, force: false })
  }

  // --- Deep-link router (optional) -----------------------------------------

  onDeepLink(handler: (url: string) => void): void {
    this.deepLinkHandler = handler
  }

  async syncDeepLinkRouter(): Promise<void> {
    const settings = await this.settings()
    if (!settings.deepLinkRouter || await this.signInState()) {
      await this.stopRouter()
      return
    }
    const install = await this.install()
    if (!install) {
      return
    }
    const processes = await this.claudeProcesses().catch(() => null)
    if (!processes) {
      return
    }
    const primary = (await this.profiles()).find(profile => profile.isDefault)!
    const primaryProcesses = this.profileProcesses(primary, processes, install)
    if (primaryProcesses.length > 0) {
      if (!settings.lastPrimaryDataPath) {
        const title = await this.singletonTitle(primaryProcesses.map(item => item.processId))
        if (title) {
          await this.saveSettings({ lastPrimaryDataPath: title })
        }
      }
      // A running primary owns its single-instance window; the router takes
      // the data folder back once it exits.
      await this.stopRouter()
      return
    }
    if (this.router) {
      return
    }
    const helper = this.helperPath()
    if (await missing(helper)) {
      return
    }
    const title = settings.lastPrimaryDataPath ?? await (await this.profilePaths()).primary()
    const child = spawn(helper, ['--router', title, '--parent', String(process.pid)], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, cwd: this.userProfile })
    const router: Router = { child, title, lastEvent: null }
    this.router = router
    let buffer = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const [event, value] = line.split('\t', 2)
        router.lastEvent = event
        if (event === 'URL' && value) {
          this.deepLinkHandler?.(value)
        }
      }
    })
    child.on('exit', () => {
      if (this.router === router) {
        this.router = null
      }
      // The user opened Claude itself: start the primary as a managed instance.
      if (router.lastEvent === 'LAUNCH') {
        void this.startOfficial(install).catch(() => undefined)
      }
    })
  }

  async routeDeepLink(url: string): Promise<DeepLinkRoute> {
    const processes = await this.claudeProcesses()
    const install = await this.requireInstall()
    const profiles = await this.profiles()
    const running = profiles.filter(profile => this.profileProcesses(profile, processes, install).length > 0)
    const settings = await this.settings()
    const preferred = running.find(profile => profile.id === settings.lastFocusedProfileId) ?? (running.length === 1 ? running[0] : null)
    if (preferred) {
      await this.deliverDeepLink(url, preferred.id)
      return { delivered: true }
    }
    return { delivered: false, candidates: running.length > 0 ? running : profiles }
  }

  async deliverDeepLink(url: string, profileId: string): Promise<void> {
    if (!/^claude:\/\//i.test(url)) {
      throw new Error('Only claude:// links can be delivered.')
    }
    const profile = await this.profile(profileId)
    const install = await this.requireInstall()
    if (profile.isDefault) {
      await this.stopRouter()
      const dataPath = (await this.settings()).lastPrimaryDataPath ?? await (await this.profilePaths()).primary()
      spawn(install.launchTarget, [`--user-data-dir=${dataPath}`, url], { detached: true, stdio: 'ignore', cwd: this.userProfile }).unref()
    } else {
      spawn(install.launchTarget, [...this.instanceArguments(profile), url], { detached: true, stdio: 'ignore', cwd: this.userProfile }).unref()
    }
    await this.rememberFocus(profile.id)
  }

  private async stopRouter(): Promise<void> {
    const router = this.router
    if (!router) {
      return
    }
    this.router = null
    router.lastEvent = 'STOPPED'
    router.child.kill()
    await delay(150)
  }

  // --- Installation --------------------------------------------------------

  private install(processes?: ClaudeProcess[]): Promise<ClaudeInstall | null> {
    if (this.installCache) {
      return this.installCache
    }
    // Concurrent callers share one query. The result stays cached for the
    // session only if the query succeeded: a timeout must not pin 'no
    // installation' until the next explicit refresh.
    const pending = (async () => {
      const running = processes ?? await this.claudeProcesses().catch(() => [] as ClaudeProcess[])
      const candidates = await this.resolver.candidates()
      this.installCandidates = candidates.length
      return ClaudeInstallResolver.choose(candidates, running.map(item => item.executablePath))
    })()
    this.installCache = pending
    pending.catch(() => {
      if (this.installCache === pending) {
        this.installCache = null
      }
    })
    return pending
  }

  private async requireInstall(): Promise<ClaudeInstall> {
    const install = await this.install()
    if (!install) {
      throw new Error('Claude Desktop was not found. Install and launch Claude Desktop first, then refresh the list.')
    }
    return install
  }

  private async profilePaths(): Promise<WindowsProfilePaths> {
    const install = await this.install().catch(() => null)
    return new WindowsProfilePaths(this.appData, this.localAppData, install?.packageFamily ? [install.packageFamily] : [])
  }

  private resourcesPath(): string {
    return process.resourcesPath ?? path.join(app.getAppPath(), '..')
  }

  private helperPath(): string {
    return app.isPackaged
      ? path.join(this.resourcesPath(), 'TaskbarHelper.exe')
      : path.join(app.getAppPath(), 'taskbar-helper', 'bin', 'Release', 'net10.0-windows', 'win-x64', 'publish', 'TaskbarHelper.exe')
  }

  // --- Processes -----------------------------------------------------------

  private async claudeProcesses(): Promise<ClaudeProcess[]> {
    const raw = await this.powerShell(claudeProcessQuery)
    if (!raw) {
      return []
    }
    const parsed = JSON.parse(raw) as unknown
    const records = Array.isArray(parsed) ? parsed : [parsed]
    return records.flatMap(record => {
      const item = record as { ProcessId?: unknown, ExecutablePath?: unknown, CommandLine?: unknown }
      const processId = Number(item.ProcessId)
      if (!Number.isInteger(processId) || processId <= 0) {
        return []
      }
      return [{ processId, executablePath: typeof item.ExecutablePath === 'string' ? item.ExecutablePath : '', commandLine: typeof item.CommandLine === 'string' ? item.CommandLine : '' }]
    })
  }

  /** Main (non-renderer) processes of a profile. */
  private profileProcesses(profile: ClaudeProfile, processes: ClaudeProcess[], install: ClaudeInstall | null): ClaudeProcess[] {
    return processes.filter(item => !item.commandLine.toLowerCase().includes('--type=') && this.belongsToProfile(profile, item, install))
  }

  private belongsToProfile(profile: ClaudeProfile, item: ClaudeProcess, install: ClaudeInstall | null): boolean {
    const commandLine = item.commandLine.toLowerCase()
    if (profile.isDefault) {
      const managed = commandLine.includes(`--user-data-dir=${profile.path.toLowerCase()}`)
      const official = install !== null && ClaudeInstallResolver.ownsExecutable(install, item.executablePath) && !commandLine.includes('--user-data-dir')
      return managed || official
    }
    return commandLine.includes(profile.path.toLowerCase())
  }

  private runningStates(profiles: ClaudeProfile[], processes: ClaudeProcess[], install: ClaudeInstall | null): Record<string, boolean> {
    const result: Record<string, boolean> = {}
    for (const profile of profiles) {
      result[profile.id] = this.profileProcesses(profile, processes, install).length > 0
    }
    return result
  }

  private async profileProcessId(profile: ClaudeProfile): Promise<number | null> {
    const processes = await this.claudeProcesses()
    return this.profileProcesses(profile, processes, await this.install())[0]?.processId ?? null
  }

  private async profileProcessIds(profile: ClaudeProfile): Promise<number[]> {
    const install = await this.install()
    return (await this.claudeProcesses()).filter(item => this.belongsToProfile(profile, item, install)).map(item => item.processId)
  }

  private async taskkill(processIds: number[], force: boolean): Promise<void> {
    const arguments_ = [...processIds.flatMap(processId => ['/PID', String(processId)]), '/T']
    if (force) {
      arguments_.push('/F')
    }
    await execFileAsync('taskkill.exe', arguments_, { windowsHide: true }).catch(() => undefined)
  }

  private async waitForProfileStopped(profile: ClaudeProfile, attempts: number): Promise<boolean> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (!(await this.profileProcessId(profile))) {
        return true
      }
      await delay(250)
    }
    return false
  }

  private async waitForProfileProcessesStopped(profile: ClaudeProfile): Promise<void> {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      if ((await this.profileProcessIds(profile)).length === 0) {
        return
      }
      await delay(250)
    }
    throw new Error('Claude is still closing. Wait a moment and try again.')
  }

  private async waitForAllStopped(attempts: number): Promise<boolean> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if ((await this.claudeProcesses()).length === 0) {
        return true
      }
      await delay(250)
    }
    return false
  }

  private async anyClaudeRunning(): Promise<boolean> {
    return (await this.claudeProcesses()).length > 0
  }

  private async isTaskbarHelper(processId: number): Promise<boolean> {
    const name = await this.powerShell(`(Get-Process -Id ${processId} -ErrorAction SilentlyContinue).ProcessName`).catch(() => '')
    return name.toLowerCase() === 'taskbarhelper'
  }

  /** Names of the processes holding a file open, via TaskbarHelper and the Restart Manager. */
  private async fileHolders(file: string): Promise<string[]> {
    const helper = this.helperPath()
    if (await missing(helper)) {
      return []
    }
    try {
      const { stdout } = await execFileAsync(helper, ['--file-holders', file], { windowsHide: true, timeout: 10_000 })
      return [...new Set(stdout.split(/\r?\n/).map(line => line.split('\t')[1]?.trim()).filter((name): name is string => Boolean(name)))]
    } catch {
      return []
    }
  }

  private async singletonTitle(processIds: number[]): Promise<string | null> {
    const helper = this.helperPath()
    if (await missing(helper)) {
      return null
    }
    try {
      const { stdout } = await execFileAsync(helper, ['--singleton-title', ...processIds.map(String)], { windowsHide: true, timeout: 5_000 })
      const title = stdout.trim()
      return title ? title : null
    } catch {
      return null
    }
  }

  private waitForRelayReady(relay: ChildProcess): Promise<boolean> {
    return new Promise(resolve => {
      let buffer = ''
      const timer = setTimeout(() => finish(false), 5_000)
      const finish = (value: boolean) => {
        clearTimeout(timer)
        relay.stdout?.removeAllListeners('data')
        resolve(value)
      }
      relay.stdout?.setEncoding('utf8')
      relay.stdout?.on('data', (chunk: string) => {
        buffer += chunk
        if (buffer.includes('READY\t')) {
          finish(true)
        } else if (buffer.includes('ERROR\t')) {
          finish(false)
        }
      })
      relay.once('exit', () => finish(false))
    })
  }

  // --- Launching -----------------------------------------------------------

  private instanceArguments(profile: ClaudeProfile): string[] {
    return [`--user-data-dir=${profile.path}`, `--app-user-model-id=${this.profileAppUserModelId(profile)}`]
  }

  private async startOfficial(install: ClaudeInstall): Promise<void> {
    const settings = await this.settings()
    if (settings.deepLinkRouter) {
      // In router mode the primary is a managed instance: its data folder is
      // passed explicitly, so the router must release that folder first.
      await this.stopRouter()
      const dataPath = settings.lastPrimaryDataPath ?? await (await this.profilePaths()).primary()
      spawn(install.launchTarget, [`--user-data-dir=${dataPath}`], { detached: true, stdio: 'ignore', cwd: this.userProfile }).unref()
    } else if (install.startAppId) {
      spawn('explorer.exe', [`shell:AppsFolder\\${install.startAppId}`], { detached: true, stdio: 'ignore', cwd: this.userProfile }).unref()
    } else {
      spawn(install.launchTarget, [], { detached: true, stdio: 'ignore', cwd: this.userProfile }).unref()
    }
    await this.rememberFocus('default')
  }

  private async requestProfileShow(profile: ClaudeProfile, install: ClaudeInstall): Promise<void> {
    if (profile.isDefault) {
      await this.startOfficial(install)
      return
    }
    spawn(install.launchTarget, this.instanceArguments(profile), { detached: true, stdio: 'ignore', cwd: this.userProfile }).unref()
    await this.rememberFocus(profile.id)
  }

  // Bump this identity when changing an icon resource: Windows caches taskbar
  // icons by AppUserModelID and otherwise keeps a stale (previously grayscale)
  // icon even after the ICO file has been replaced.
  private profileAppUserModelId(profile: ClaudeProfile): string {
    return `com.claude-instance-manager.profile.v3.${profile.id}`
  }

  // The window property store rejects a RelaunchCommand over 259 characters,
  // which a direct launch with the profile path and AUMID exceeds. The pinned
  // button therefore relaunches through the manager, which also re-applies
  // this identity.
  private relaunchCommand(profile: ClaudeProfile): string {
    return `"${process.execPath}" --launch-profile=${profile.id}`
  }

  private async applyTaskbarIdentity(profile: ClaudeProfile, processId: number): Promise<void> {
    const helper = this.helperPath()
    const install = await this.install()
    if (!install || await missing(helper)) {
      return
    }
    const icon = profile.color === 'default' ? '' : this.profileIconPath(profile.color, install)
    const child = spawn(helper, [String(processId), this.profileAppUserModelId(profile), profile.name, icon, this.relaunchCommand(profile)], { detached: true, stdio: 'ignore', windowsHide: true, cwd: this.userProfile })
    child.unref()
    this.taskbarHelpers.set(profile.id, child)
  }

  /** Re-attaches the identity helper to running instances that lost it (manager restart, helper exit). */
  private async ensureTaskbarIdentities(profiles: ClaudeProfile[], processes: ClaudeProcess[], install: ClaudeInstall | null): Promise<void> {
    const running = profiles.filter(profile => !profile.isDefault && profile.running)
    if (running.length === 0) {
      return
    }
    const helpers = await this.powerShell("Get-CimInstance Win32_Process -Filter \"Name='TaskbarHelper.exe'\" | Select-Object -ExpandProperty CommandLine").catch(() => null)
    if (helpers === null) {
      return
    }
    for (const profile of running) {
      const known = this.taskbarHelpers.get(profile.id)
      if (known && known.exitCode === null && !known.killed) {
        continue
      }
      const processId = this.profileProcesses(profile, processes, install)[0]?.processId
      if (!processId) {
        continue
      }
      const existing = helpers.split(/\r?\n/).find(line => line.includes(this.profileAppUserModelId(profile)))
      if (!existing) {
        await this.applyTaskbarIdentity(profile, processId)
      } else if (!existing.toLowerCase().includes(process.execPath.toLowerCase()) && !this.isDevelopmentBuild()) {
        // A helper started by a manager at another location would keep a
        // stale relaunch command on the window; a pin made now must use this one.
        await this.restartTaskbarHelper(profile, processId)
      }
    }
  }

  private async restartTaskbarHelper(profile: ClaudeProfile, processId: number): Promise<void> {
    const known = this.taskbarHelpers.get(profile.id)
    if (known) {
      known.kill()
      this.taskbarHelpers.delete(profile.id)
    }
    // A helper started by an earlier manager process is only known by its
    // command line, which carries the profile identity.
    await this.powerShell(`$id=${quote(this.profileAppUserModelId(profile))}; Get-CimInstance Win32_Process -Filter \"Name='TaskbarHelper.exe'\" | Where-Object { $_.CommandLine -like ('*' + $id + '*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`).catch(() => undefined)
    await this.applyTaskbarIdentity(profile, processId)
  }

  private profileIconPath(color: ProfileColor, install: ClaudeInstall): string {
    // Default must be the icon embedded in the actual Claude executable, not a
    // converted ICO. This preserves Claude's original color treatment exactly.
    return color === 'default' ? install.iconSource : path.join(this.resourcesPath(), 'Assets', `claude-profile-${color}.ico`)
  }

  // --- Profiles ------------------------------------------------------------

  private async profiles(): Promise<ClaudeProfile[]> {
    const primaryPath = await (await this.profilePaths()).primary()
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

  private async profile(id: string): Promise<ClaudeProfile> {
    const found = (await this.profiles()).find(p => p.id === id)
    if (!found) {
      throw new Error('Profile not found. Refresh the list and try again.')
    }
    return found
  }

  private normalizeProfileName(value: string): string {
    const name = value.trim().replace(/ +/g, ' ')
    if (!name) {
      throw new Error('Enter a name for the instance')
    }
    if (name.length > 20 || !/^[A-Za-z0-9 ]+$/.test(name)) {
      throw new Error('Use up to 20 English letters, numbers, and spaces only')
    }
    return name
  }

  private availableProfileName(requestedName: string, profiles: ClaudeProfile[]): string {
    const exists = (name: string) => profiles.some(profile => profile.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0)
    if (!exists(requestedName)) {
      return requestedName
    }
    for (let number = 1; ; number += 1) {
      const suffix = ` ${number}`
      const candidate = `${requestedName.slice(0, 20 - suffix.length)}${suffix}`
      if (!exists(candidate)) {
        return candidate
      }
    }
  }

  private profileMetaPath(profilePath: string): string {
    return path.join(profilePath, 'instance.json')
  }

  private async writeProfileMetadata(profilePath: string, name: string, color: ProfileColor): Promise<void> {
    await writeFile(this.profileMetaPath(profilePath), JSON.stringify({ name, color }, null, 2), 'utf8')
  }

  private async profileMetadata(profilePath: string, fallbackName: string): Promise<{ name: string, color: ProfileColor }> {
    try {
      const meta = JSON.parse(await readFile(this.profileMetaPath(profilePath), 'utf8')) as { name?: unknown, color?: unknown }
      return {
        name: typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : fallbackName,
        color: typeof meta.color === 'string' && supportedProfileColors.includes(meta.color as ProfileColor) ? meta.color as ProfileColor : 'default'
      }
    } catch {
      return { name: fallbackName, color: 'default' }
    }
  }

  private async findSignInProfile(token: string, profilePaths: WindowsProfilePaths): Promise<string | null> {
    const matches: string[] = []
    for (const candidate of profilePaths.candidates()) {
      const marker = await readFile(path.join(candidate, '.cim-sign-in'), 'utf8').catch(() => null)
      if (marker === token) {
        matches.push(candidate)
      }
    }
    return matches.length === 1 ? matches[0] : null
  }

  // --- Storage -------------------------------------------------------------

  /** A timestamped item folder; two items within one second get a suffix. */
  private async newStoragePath(root: string, profile: ClaudeProfile): Promise<string> {
    const base = path.join(root, profile.id, stamp())
    await mkdir(path.dirname(base), { recursive: true })
    let candidate = base
    for (let index = 2; !(await missing(candidate)); index += 1) {
      candidate = `${base}-${index}`
    }
    return candidate
  }

  private storageMetadataPath(itemPath: string): string {
    return path.join(itemPath, '.cim-storage.json')
  }

  private async writeStorageMetadata(itemPath: string, profile: ClaudeProfile, kind: StorageItemKind, tier: StorageTier, sizeBytes: number): Promise<void> {
    await writeFile(this.storageMetadataPath(itemPath), JSON.stringify({ profileId: profile.id, profileName: profile.name, kind, tier, createdAt: new Date().toISOString(), sizeBytes }, null, 2), 'utf8')
  }

  private async readStorageMetadata(itemPath: string): Promise<{ profileId: string, profileName: string, createdAt: string, sizeBytes: number | null, tier: StorageTier | null } | null> {
    try {
      const value = JSON.parse(await readFile(this.storageMetadataPath(itemPath), 'utf8')) as { profileId?: unknown, profileName?: unknown, createdAt?: unknown, sizeBytes?: unknown, tier?: unknown }
      if (typeof value.profileId !== 'string' || typeof value.profileName !== 'string' || typeof value.createdAt !== 'string') {
        return null
      }
      return {
        profileId: value.profileId,
        profileName: value.profileName,
        createdAt: value.createdAt,
        sizeBytes: typeof value.sizeBytes === 'number' && Number.isFinite(value.sizeBytes) ? value.sizeBytes : null,
        tier: typeof value.tier === 'string' && storageTiers.includes(value.tier as StorageTier) ? value.tier as StorageTier : null
      }
    } catch {
      return null
    }
  }

  // --- Sign In state and settings -----------------------------------------

  private async signInState(): Promise<SignInState | null> {
    let state: SignInState
    try {
      state = JSON.parse(await readFile(this.signInStatePath, 'utf8')) as SignInState
    } catch {
      return null
    }
    if (typeof state.profileId !== 'string' || typeof state.relayProcessId !== 'number') {
      await rm(this.signInStatePath, { force: true })
      return null
    }
    // The relay ends by itself when the user opens the primary Claude.
    if (!(await this.isTaskbarHelper(state.relayProcessId))) {
      await rm(this.signInStatePath, { force: true })
      return null
    }
    return state
  }

  private async settings(): Promise<Settings> {
    try {
      const value = JSON.parse(await readFile(this.settingsPath, 'utf8')) as Partial<Settings>
      return {
        deepLinkRouter: value.deepLinkRouter === true,
        portableCleanupDismissed: value.portableCleanupDismissed === true,
        portableRemovalPending: value.portableRemovalPending === true,
        lastPrimaryDataPath: typeof value.lastPrimaryDataPath === 'string' && value.lastPrimaryDataPath ? value.lastPrimaryDataPath : null,
        lastFocusedProfileId: typeof value.lastFocusedProfileId === 'string' ? value.lastFocusedProfileId : null
      }
    } catch {
      return { ...defaultSettings }
    }
  }

  private async saveSettings(changes: Partial<Settings>): Promise<void> {
    const next = { ...(await this.settings()), ...changes }
    await mkdir(this.localData, { recursive: true })
    await writeFile(this.settingsPath, JSON.stringify(next, null, 2), 'utf8')
  }

  private async rememberFocus(profileId: string): Promise<void> {
    await this.saveSettings({ lastFocusedProfileId: profileId }).catch(() => undefined)
  }

  private async portableCleanup(settings: Settings): Promise<ManagerState['portableCleanup']> {
    if (await missing(this.portablePath)) {
      return null
    }
    if (settings.portableRemovalPending) {
      // A removal that left locked files behind (delete-pending leftovers)
      // is finished quietly once the holder lets go, typically after a restart.
      await rm(this.portablePath, { recursive: true, force: true }).catch(() => undefined)
      return null
    }
    if (settings.portableCleanupDismissed) {
      return null
    }
    if (!this.portableSize) {
      this.portableSize = profileBackup.directorySize(this.portablePath).catch(() => null)
    }
    return { path: this.portablePath, sizeBytes: await this.portableSize }
  }

  // --- Shortcuts -----------------------------------------------------------

  private shortcutDirectories(): Array<{ key: 'desktopShortcut' | 'startMenuShortcut', path: string }> {
    return [
      { key: 'desktopShortcut', path: app.getPath('desktop') },
      { key: 'startMenuShortcut', path: path.join(this.appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs') }
    ]
  }

  private shortcutRemovalDirectories(): Array<{ key: 'desktopShortcut' | 'startMenuShortcut', path: string }> {
    const directories = this.shortcutDirectories()
    const legacyDesktop = path.join(this.userProfile, 'Desktop')
    if (legacyDesktop.toLowerCase() !== app.getPath('desktop').toLowerCase()) {
      directories.push({ key: 'desktopShortcut', path: legacyDesktop })
    }
    return directories
  }

  /** A shortcut belongs to a profile when it launches it directly or through the manager. */
  private shortcutBelongsTo(details: Electron.ShortcutDetails, profile: ClaudeProfile): boolean {
    const args = details.args?.replaceAll('"', '') ?? ''
    return args.includes(`--user-data-dir=${profile.path}`) || args.includes(`--launch-profile=${profile.id}`)
  }

  private async shortcutState(profile: ClaudeProfile): Promise<Pick<ClaudeProfile, 'desktopShortcut' | 'startMenuShortcut'>> {
    const result = { desktopShortcut: false, startMenuShortcut: false }
    for (const directory of this.shortcutDirectories()) {
      for (const shortcut of await this.readShortcuts(directory.path)) {
        if (this.shortcutBelongsTo(shortcut.details, profile)) {
          result[directory.key] = true
        }
      }
    }
    return result
  }

  private async removeProfileShortcuts(profile: ClaudeProfile): Promise<void> {
    for (const directory of this.shortcutRemovalDirectories()) {
      for (const shortcut of await this.readShortcuts(directory.path)) {
        if (this.shortcutBelongsTo(shortcut.details, profile)) {
          await rm(shortcut.path, { force: true })
        }
      }
    }
  }

  // A packaged Claude.exe ignores --app-user-model-id (the package identity
  // wins), so only TaskbarHelper gives a window its own button. Shortcuts
  // therefore launch through the manager, like a pinned button does.
  private shortcutDetails(profile: ClaudeProfile, install: ClaudeInstall): Electron.ShortcutDetails {
    return { target: process.execPath, args: `--launch-profile=${profile.id}`, cwd: this.userProfile, description: `Claude profile: ${profile.name}`, icon: this.profileIconPath(profile.color, install), iconIndex: 0, appUserModelId: this.profileAppUserModelId(profile) }
  }

  private async createShortcuts(profile: ClaudeProfile, options: Pick<CreateProfileOptions, 'desktopShortcut' | 'startMenuShortcut'>): Promise<void> {
    if (!options.desktopShortcut && !options.startMenuShortcut) {
      return
    }
    const install = await this.requireInstall()
    const shortcutName = `Claude — ${profile.name}.lnk`
    const details = this.shortcutDetails(profile, install)
    for (const destination of this.shortcutDirectories()) {
      if (!options[destination.key]) {
        continue
      }
      await mkdir(destination.path, { recursive: true })
      if (!shell.writeShortcutLink(path.join(destination.path, shortcutName), 'create', details)) {
        throw new Error(`Could not create the shortcut for ${profile.name}.`)
      }
    }
  }

  /** Points shortcuts of the removed portable runtime at the installed Claude. */
  private async migrateShortcutsOnce(install: ClaudeInstall | null, profiles: ClaudeProfile[]): Promise<void> {
    if (this.shortcutsMigrated || !install) {
      return
    }
    this.shortcutsMigrated = true
    const portableExe = path.join(this.portablePath, 'Claude.exe').toLowerCase()
    for (const directory of [...this.shortcutRemovalDirectories().map(item => item.path), ...(await this.pinnedShortcutDirectories())]) {
      for (const shortcut of await this.readShortcuts(directory)) {
        const args = shortcut.details.args?.replaceAll('"', '') ?? ''
        const profile = profiles.find(candidate => !candidate.isDefault && (args.includes(`--user-data-dir=${candidate.path}`) || args.includes(`--launch-profile=${candidate.id}`)))
        try {
          if (profile && args.includes('--user-data-dir=')) {
            // A direct launch (portable copy or alias) gets no taskbar identity.
            shell.writeShortcutLink(shortcut.path, 'replace', this.shortcutDetails(profile, install))
          } else if (profile && this.isForeignManager(shortcut.details.target)) {
            // A shortcut or pin created by a manager at another location (an
            // unpacked build, an older install) keeps working through this one.
            shell.writeShortcutLink(shortcut.path, 'update', { target: process.execPath, icon: this.profileIconPath(profile.color, install), iconIndex: 0 })
          } else if (shortcut.details.target?.toLowerCase() === portableExe) {
            const iconWasPortable = !shortcut.details.icon || shortcut.details.icon.toLowerCase() === portableExe
            shell.writeShortcutLink(shortcut.path, 'update', { target: install.launchTarget, ...(iconWasPortable ? { icon: install.iconSource, iconIndex: 0 } : {}) })
          }
        } catch { /* A read-only or foreign shortcut stays as it is. */ }
      }
    }
  }

  /** Another manager executable than this one; never claimed by an unpacked development build. */
  private isForeignManager(target: string | undefined): boolean {
    if (!target || this.isDevelopmentBuild()) {
      return false
    }
    return path.basename(target).toLowerCase() === path.basename(process.execPath).toLowerCase() && target.toLowerCase() !== process.execPath.toLowerCase()
  }

  private isDevelopmentBuild(): boolean {
    return process.execPath.toLowerCase().includes(`${path.sep}win-unpacked${path.sep}`) || !app.isPackaged
  }

  /**
   * Keeps the icon and description of taskbar pins in step with the profile.
   * A pin's label is its file name, which Windows references by path, so the
   * name itself cannot follow a rename without re-pinning.
   */
  private async refreshPinnedShortcuts(profile: ClaudeProfile): Promise<void> {
    const install = await this.install().catch(() => null)
    if (!install) {
      return
    }
    for (const directory of await this.pinnedShortcutDirectories()) {
      for (const shortcut of await this.readShortcuts(directory)) {
        if (!(shortcut.details.args?.replaceAll('"', '') ?? '').includes(`--launch-profile=${profile.id}`)) {
          continue
        }
        try {
          shell.writeShortcutLink(shortcut.path, 'update', { target: shortcut.details.target ?? process.execPath, icon: this.profileIconPath(profile.color, install), iconIndex: 0, description: `Claude profile: ${profile.name}` })
        } catch { /* A pin that cannot be written keeps its old look. */ }
      }
    }
  }

  /** Taskbar pins: explicit ones and the per-AUMID "implicit" ones Windows makes for pinned windows. */
  private async pinnedShortcutDirectories(): Promise<string[]> {
    const root = path.join(this.appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned')
    const result = [path.join(root, 'TaskBar')]
    try {
      const implicit = path.join(root, 'ImplicitAppShortcuts')
      for (const entry of await readdir(implicit, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          result.push(path.join(implicit, entry.name))
        }
      }
    } catch { /* No implicit pins. */ }
    return result
  }

  private async readShortcuts(directory: string): Promise<Array<{ path: string, details: Electron.ShortcutDetails }>> {
    const result: Array<{ path: string, details: Electron.ShortcutDetails }> = []
    try {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.lnk')) {
          continue
        }
        const shortcutPath = path.join(directory, entry.name)
        try {
          const details = shell.readShortcutLink(shortcutPath)
          if (details) {
            result.push({ path: shortcutPath, details })
          }
        } catch { /* Not a readable shell link. */ }
      }
    } catch { /* A shortcut folder may not exist yet. */ }
    return result
  }

  // --- PowerShell ----------------------------------------------------------

  /** Runs a command and returns its trimmed output; a failure or timeout throws. */
  private async powerShell(command: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 15_000, maxBuffer: 16 * 1024 * 1024 })
      return stdout.trim()
    } catch (error) {
      throw new PowerShellError(`PowerShell query failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '')
