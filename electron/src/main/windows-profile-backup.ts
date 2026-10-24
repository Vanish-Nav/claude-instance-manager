import { access, cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { BackupTier, ImportSelection, MissingProject, ProfileEntryCategory, ProfileSizes, SourceContents, SourceProject } from '../shared/contracts'

const exists = (file: string): Promise<boolean> => access(file).then(() => true, () => false)

/** Profile entries that hold the login, chats index and Code/Cowork session lists. */
export const sessionEntries = [
  'config.json', 'Local State', 'Network', 'Local Storage', 'IndexedDB', 'Session Storage', 'Preferences', 'ant-did',
  'claude_desktop_config.json', 'mcp-user-tool-toggles.json', 'claude-code-sessions', 'local-agent-mode-sessions',
  'spaces-present', 'Claude Extensions'
]

/** Re-downloadable content that a full backup leaves out and "clean caches" may delete. */
export const cacheEntries = [
  'Cache', 'Code Cache', 'GPUCache', 'GrShaderCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'ShaderCache',
  'vm_bundles', 'claude-code', 'claude-code-vm', 'logs'
]

/** Entries that carry the Windows-user-bound login and never leave the machine. */
export const secretEntries = ['Network', 'Local State']

/** Folder inside a backup that holds copies of `%USERPROFILE%\.claude\projects\<slug>`. */
export const projectsFolderName = '.cim-claude-projects'

const lower = (value: string) => value.toLowerCase()
const sessionSet = new Set(sessionEntries.map(lower))
const cacheSet = new Set(cacheEntries.map(lower))

export function categorize(entryName: string): ProfileEntryCategory {
  if (sessionSet.has(lower(entryName))) {
    return 'session'
  }
  if (cacheSet.has(lower(entryName))) {
    return 'cache'
  }
  return 'data'
}

/** Claude Code names a project folder after the working directory: `:` and `\` become `-`. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[:\\/]/g, '-')
}

export interface SessionProject {
  cwd: string
  title: string | null
  slug: string
  sessions: number
  files: string[]
}

/** Working directories referenced by the Code sessions of a profile. */
export async function sessionProjects(profilePath: string): Promise<SessionProject[]> {
  const result = new Map<string, SessionProject>()
  const root = path.join(profilePath, 'claude-code-sessions')
  for (const file of await walkFiles(root, 3)) {
    if (!/^local_.*\.json$/i.test(path.basename(file))) {
      continue
    }
    try {
      const session = JSON.parse(await readFile(file, 'utf8')) as { cwd?: unknown, title?: unknown }
      if (typeof session.cwd === 'string' && session.cwd.trim()) {
        const cwd = session.cwd.trim()
        const known = result.get(lower(cwd))
        if (known) {
          known.sessions += 1
          known.files.push(file)
        } else {
          result.set(lower(cwd), { cwd, title: typeof session.title === 'string' ? session.title : null, slug: projectSlug(cwd), sessions: 1, files: [file] })
        }
      }
    } catch { /* A session file being written, or a non-session json: skip it. */ }
  }
  return [...result.values()]
}

export interface CopyTierOptions {
  tier: BackupTier
  claudeProjectsRoot: string
  /** Restore only: which Code projects and whether Cowork tasks come along. */
  selection?: ImportSelection | null
}

/** What a backup, export or live profile would bring into another instance. */
export async function sourceContents(source: string): Promise<SourceContents> {
  const projects: SourceProject[] = []
  for (const project of await sessionProjects(source)) {
    projects.push({ cwd: project.cwd, title: project.title, sessions: project.sessions, exists: await exists(project.cwd) })
  }
  let coworkSessions = 0
  try {
    coworkSessions = (await readdir(path.join(source, 'local-agent-mode-sessions'))).length
  } catch { /* No Cowork data in this source. */ }
  return { projects: projects.sort((a, b) => a.cwd.localeCompare(b.cwd)), coworkSessions }
}

function projectSelected(selection: ImportSelection | null | undefined, cwd: string): boolean {
  if (!selection || selection.projects === null) {
    return true
  }
  return selection.projects.some(item => lower(item) === lower(cwd))
}

/**
 * Copies the entries of a tier from a profile folder into an empty backup
 * folder. The "settings" tier leaves the login out so the copy can travel to
 * another machine.
 */
export async function copyTier(source: string, target: string, options: CopyTierOptions): Promise<void> {
  await mkdir(target, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!includeInTier(entry.name, options.tier)) {
      continue
    }
    const from = path.join(source, entry.name)
    const to = path.join(target, entry.name)
    if (options.tier === 'settings' && lower(entry.name) === 'config.json') {
      await writeFile(to, stripSecrets(await readFile(from, 'utf8')), 'utf8')
      continue
    }
    await cp(from, to, { recursive: true, force: false })
  }
  const projects = await sessionProjects(source)
  for (const project of projects) {
    const projectPath = path.join(options.claudeProjectsRoot, project.slug)
    if (await exists(projectPath)) {
      await cp(projectPath, path.join(target, projectsFolderName, project.slug), { recursive: true, force: false })
    }
  }
}

export function includeInTier(entryName: string, tier: BackupTier): boolean {
  const name = lower(entryName)
  if (name === '.cim-storage.json') {
    return false
  }
  if (tier === 'full') {
    return !cacheSet.has(name)
  }
  if (tier === 'settings') {
    // The device id must not be duplicated on another machine either.
    return sessionSet.has(name) && !secretEntries.map(lower).includes(name) && name !== 'ant-did'
  }
  return sessionSet.has(name)
}

/** Removes the `oauth:*` keys from a profile config.json. */
export function stripSecrets(configJson: string): string {
  const config = JSON.parse(configJson) as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    if (!lower(key).startsWith('oauth:')) {
      result[key] = value
    }
  }
  return JSON.stringify(result, null, 2)
}

/** Merges an exported config.json into a target, keeping the target's login keys. */
export function mergeSettings(exportedJson: string, targetJson: string | null): string {
  const exported = JSON.parse(stripSecrets(exportedJson)) as Record<string, unknown>
  let target: Record<string, unknown> = {}
  try {
    target = targetJson ? JSON.parse(targetJson) as Record<string, unknown> : {}
  } catch { /* A corrupt target config is replaced by the export. */ }
  const result: Record<string, unknown> = { ...exported }
  for (const [key, value] of Object.entries(target)) {
    if (lower(key).startsWith('oauth:')) {
      result[key] = value
    }
  }
  return JSON.stringify(result, null, 2)
}

/** `ant-did` is a base64 UUID; a cloned instance needs one of its own. */
export function newDeviceId(): string {
  return Buffer.from(randomUUID(), 'utf8').toString('base64')
}

/**
 * Restores a backup of the given tier into a profile folder. A full backup
 * replaces the folder; the session tier replaces only its entries; the
 * settings tier keeps the target login.
 */
export async function restoreTier(backup: string, target: string, options: CopyTierOptions): Promise<void> {
  if (options.tier === 'full') {
    await rm(target, { recursive: true, force: true })
    await mkdir(target, { recursive: true })
  } else {
    await mkdir(target, { recursive: true })
  }
  for (const entry of await readdir(backup, { withFileTypes: true })) {
    // The source can be a live profile (clone), so the tier filter applies here too.
    if (entry.name === projectsFolderName || !includeInTier(entry.name, options.tier)) {
      continue
    }
    if (lower(entry.name) === 'local-agent-mode-sessions' && options.selection && !options.selection.cowork) {
      continue
    }
    const from = path.join(backup, entry.name)
    const to = path.join(target, entry.name)
    if (options.tier === 'settings' && lower(entry.name) === 'config.json') {
      const current = await readFile(to, 'utf8').catch(() => null)
      await writeFile(to, mergeSettings(await readFile(from, 'utf8'), current), 'utf8')
      continue
    }
    await rm(to, { recursive: true, force: true })
    await cp(from, to, { recursive: true, force: false })
  }
  await pruneSessions(target, options.selection)
  await restoreProjects(backup, options.claudeProjectsRoot, options.selection)
}

/** Drops the sidebar entries of Code projects the user left out. */
async function pruneSessions(target: string, selection: ImportSelection | null | undefined): Promise<void> {
  if (!selection || selection.projects === null) {
    return
  }
  for (const project of await sessionProjects(target)) {
    if (!projectSelected(selection, project.cwd)) {
      for (const file of project.files) {
        await rm(file, { force: true })
      }
    }
  }
}

/** Copies saved project transcripts back, without overwriting newer local files. */
export async function restoreProjects(backup: string, claudeProjectsRoot: string, selection?: ImportSelection | null): Promise<void> {
  const root = path.join(backup, projectsFolderName)
  let entries: string[] = []
  try {
    entries = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch {
    return
  }
  const selectedSlugs = selection && selection.projects !== null ? new Set(selection.projects.map(cwd => lower(projectSlug(cwd)))) : null
  for (const slug of entries) {
    if (selectedSlugs && !selectedSlugs.has(lower(slug))) {
      continue
    }
    await cp(path.join(root, slug), path.join(claudeProjectsRoot, slug), { recursive: true, force: false, errorOnExist: false })
  }
}

/** Code sessions whose working directory no longer exists will not open. */
export async function missingProjects(profilePath: string): Promise<MissingProject[]> {
  const result: MissingProject[] = []
  for (const project of await sessionProjects(profilePath)) {
    if (!(await exists(project.cwd))) {
      result.push({ cwd: project.cwd, title: project.title })
    }
  }
  return result
}

export async function profileSizes(profilePath: string, claudeProjectsRoot: string): Promise<ProfileSizes> {
  const entries: ProfileSizes['entries'] = []
  for (const entry of await readdir(profilePath, { withFileTypes: true })) {
    const entryPath = path.join(profilePath, entry.name)
    const sizeBytes = entry.isDirectory() ? await directorySize(entryPath) : entry.isFile() ? (await stat(entryPath)).size : 0
    entries.push({ name: entry.name, sizeBytes, category: categorize(entry.name) })
  }
  let projectsBytes = 0
  for (const project of await sessionProjects(profilePath)) {
    const projectPath = path.join(claudeProjectsRoot, project.slug)
    if (await exists(projectPath)) {
      projectsBytes += await directorySize(projectPath)
    }
  }
  const sum = (category: ProfileEntryCategory) => entries.filter(entry => entry.category === category).reduce((total, entry) => total + entry.sizeBytes, 0)
  const sessionBytes = sum('session') + projectsBytes
  return { entries: entries.sort((a, b) => b.sizeBytes - a.sizeBytes), projectsBytes, sessionBytes, fullBytes: sessionBytes + sum('data'), cacheBytes: sum('cache') }
}

export async function directorySize(directory: string): Promise<number> {
  let total = 0
  let entries: Dirent[] = []
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      total += await directorySize(entryPath)
    } else if (entry.isFile()) {
      total += await stat(entryPath).then(info => info.size, () => 0)
    }
  }
  return total
}

async function walkFiles(root: string, depth: number): Promise<string[]> {
  const result: string[] = []
  let entries: Dirent[] = []
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return result
  }
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name)
    if (entry.isDirectory() && depth > 0) {
      result.push(...await walkFiles(entryPath, depth - 1))
    } else if (entry.isFile()) {
      result.push(entryPath)
    }
  }
  return result
}
