import { access, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { ClaudeInstallKind } from '../shared/contracts'

const exists = (file: string): Promise<boolean> => access(file).then(() => true, () => false)

export interface ClaudeInstall {
  kind: ClaudeInstallKind
  /** Package family of an MSIX install; null for the Squirrel installer. */
  packageFamily: string | null
  /** Folder that holds the install, shown to the user and used for the protocol check. */
  installRoot: string
  /** Executable the manager spawns for isolated instances and deep-link forwarding. */
  launchTarget: string
  /** Start menu application id (`<family>!Claude`); null for Squirrel. */
  startAppId: string | null
  /** The real Claude.exe, readable by the user, used as the icon source. */
  iconSource: string
  version: string | null
  /** A running Claude.exe belongs to this install when its path matches both parts. */
  executablePrefix: string
  executableInfix: string
  protocolOwner: boolean
}

export const knownPackageFamilies: Record<Exclude<ClaudeInstallKind, 'squirrel'>, string> = {
  'msix-direct': 'Claude_pzs8sxrjxfjjc',
  'msix-store': 'AnthropicPBC.Claude_fnn82j28hfe8t'
}

const aliasNames: Record<Exclude<ClaudeInstallKind, 'squirrel'>, string> = {
  'msix-direct': 'claude-desktop.exe',
  'msix-store': 'claude-desktop-msstore.exe'
}

export const installLabels: Record<ClaudeInstallKind, string> = {
  'msix-direct': 'Claude Desktop (MSIX)',
  'msix-store': 'Claude Desktop (Microsoft Store)',
  squirrel: 'Claude Desktop (Squirrel installer)'
}

// Packages are matched by family or publisher only. A `-Name 'Claude*'` mask
// also catches unrelated packages and misses the Store package name.
export const installQuery = [
  `$families = @(${Object.values(knownPackageFamilies).map(family => `'${family}'`).join(',')})`,
  "$packages = @(Get-AppxPackage | Where-Object { $families -contains $_.PackageFamilyName -or ($_.Publisher -like '*Anthropic*' -and $_.PackageFamilyName -like '*Claude_*') } | Select-Object PackageFamilyName,InstallLocation,Version)",
  "$protocol = (Get-ItemProperty -LiteralPath 'Registry::HKEY_CLASSES_ROOT\\claude\\shell\\open\\command' -ErrorAction SilentlyContinue).'(default)'",
  '@{ packages = $packages; protocol = $protocol } | ConvertTo-Json -Compress -Depth 3'
].join('; ')

interface PackageRecord { PackageFamilyName?: unknown, InstallLocation?: unknown, Version?: unknown }

export class ClaudeInstallResolver {
  constructor(private readonly options: { localAppData: string, powerShell: (command: string) => Promise<string> }) {}

  async candidates(): Promise<ClaudeInstall[]> {
    // A failing query propagates: a missing package must not be cached as 'no install'.
    const raw = await this.options.powerShell(installQuery)
    let packages: PackageRecord[] = []
    let protocol = ''
    try {
      const parsed = JSON.parse(raw) as { packages?: unknown, protocol?: unknown }
      packages = Array.isArray(parsed.packages) ? parsed.packages as PackageRecord[] : parsed.packages ? [parsed.packages as PackageRecord] : []
      protocol = typeof parsed.protocol === 'string' ? parsed.protocol : ''
    } catch { /* No packaged Claude: the Squirrel check below still runs. */ }
    const result: ClaudeInstall[] = []
    for (const record of packages) {
      const install = await this.packagedInstall(record, protocol)
      if (install) {
        result.push(install)
      }
    }
    const squirrel = await this.squirrelInstall(protocol)
    if (squirrel) {
      result.push(squirrel)
    }
    return result
  }

  async resolve(runningExecutables: string[]): Promise<ClaudeInstall | null> {
    return ClaudeInstallResolver.choose(await this.candidates(), runningExecutables)
  }

  static choose(candidates: ClaudeInstall[], runningExecutables: string[]): ClaudeInstall | null {
    const order: ClaudeInstallKind[] = ['msix-direct', 'msix-store', 'squirrel']
    const ranked = [...candidates].sort((left, right) => {
      const leftRunning = runningExecutables.some(executable => ClaudeInstallResolver.ownsExecutable(left, executable))
      const rightRunning = runningExecutables.some(executable => ClaudeInstallResolver.ownsExecutable(right, executable))
      if (leftRunning !== rightRunning) {
        return leftRunning ? -1 : 1
      }
      if (left.protocolOwner !== right.protocolOwner) {
        return left.protocolOwner ? -1 : 1
      }
      return order.indexOf(left.kind) - order.indexOf(right.kind)
    })
    return ranked[0] ?? null
  }

  static ownsExecutable(install: ClaudeInstall, executablePath: string | undefined | null): boolean {
    if (!executablePath) {
      return false
    }
    const candidate = executablePath.toLowerCase()
    return candidate.startsWith(install.executablePrefix.toLowerCase()) && candidate.includes(install.executableInfix.toLowerCase())
  }

  private async packagedInstall(record: PackageRecord, protocol: string): Promise<ClaudeInstall | null> {
    const family = typeof record.PackageFamilyName === 'string' ? record.PackageFamilyName : ''
    const location = typeof record.InstallLocation === 'string' ? record.InstallLocation : ''
    const familyMatch = /^([A-Za-z0-9.-]+)_([a-z0-9]+)$/.exec(family)
    if (!familyMatch || !location) {
      return null
    }
    const [, name, publisherId] = familyMatch
    const kind: ClaudeInstallKind = family === knownPackageFamilies['msix-store'] || name.includes('.') ? 'msix-store' : 'msix-direct'
    const aliasRoot = path.join(this.options.localAppData, 'Microsoft', 'WindowsApps')
    const alias = aliasNames[kind]
    const scopedAlias = path.join(aliasRoot, family, alias)
    const launchTarget = await exists(scopedAlias) ? scopedAlias : path.join(aliasRoot, alias)
    // Package folders are named <Name>_<version>_<arch>__<publisherId>, so a
    // process path is matched by the parts that survive an update.
    const executablePrefix = path.join(path.dirname(location), `${name}_`)
    const executableInfix = `__${publisherId}${path.sep}`
    return {
      kind,
      packageFamily: family,
      installRoot: location,
      launchTarget,
      startAppId: `${family}!Claude`,
      iconSource: path.join(location, 'app', 'Claude.exe'),
      version: typeof record.Version === 'string' ? record.Version : null,
      executablePrefix,
      executableInfix,
      protocolOwner: protocol.toLowerCase().includes(location.toLowerCase())
    }
  }

  private async squirrelInstall(protocol: string): Promise<ClaudeInstall | null> {
    const root = path.join(this.options.localAppData, 'AnthropicClaude')
    let versions: string[] = []
    try {
      const entries = await readdir(root, { withFileTypes: true })
      for (const entry of entries) {
        const match = /^app-(\d+(?:\.\d+)*)$/.exec(entry.name)
        if (entry.isDirectory() && match && await exists(path.join(root, entry.name, 'claude.exe'))) {
          versions.push(match[1])
        }
      }
    } catch {
      return null
    }
    if (versions.length === 0) {
      return null
    }
    versions = versions.sort(compareVersions).reverse()
    const stub = path.join(root, 'claude.exe')
    const newest = path.join(root, `app-${versions[0]}`, 'claude.exe')
    return {
      kind: 'squirrel',
      packageFamily: null,
      installRoot: root,
      launchTarget: await exists(stub) ? stub : newest,
      startAppId: null,
      iconSource: newest,
      version: versions[0],
      executablePrefix: root + path.sep,
      executableInfix: path.sep,
      protocolOwner: protocol.toLowerCase().includes(root.toLowerCase())
    }
  }
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number)
  const rightParts = right.split('.').map(Number)
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) {
      return difference
    }
  }
  return 0
}
