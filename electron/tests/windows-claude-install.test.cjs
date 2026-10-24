const assert = require('node:assert/strict')
const { test } = require('node:test')
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { loadSource } = require('./load-source.cjs')

const { ClaudeInstallResolver } = loadSource(path.resolve(__dirname, '../src/main/windows-claude-install.ts'))

const directPackage = { PackageFamilyName: 'Claude_pzs8sxrjxfjjc', InstallLocation: 'C:\\Program Files\\WindowsApps\\Claude_3.6556.2.0_x64__pzs8sxrjxfjjc', Version: '3.6556.2.0' }
const storePackage = { PackageFamilyName: 'AnthropicPBC.Claude_fnn82j28hfe8t', InstallLocation: 'C:\\Program Files\\WindowsApps\\AnthropicPBC.Claude_3.6556.2.0_x64__fnn82j28hfe8t', Version: '3.6556.2.0' }

async function fixture(t, { packages = [], protocol = '', squirrelVersions = [], withStub = true, scopedAlias = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'cim-install-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const localAppData = path.join(root, 'Local')
  for (const item of packages) {
    if (scopedAlias) {
      const aliasDirectory = path.join(localAppData, 'Microsoft', 'WindowsApps', item.PackageFamilyName)
      await mkdir(aliasDirectory, { recursive: true })
      await writeFile(path.join(aliasDirectory, item.PackageFamilyName.startsWith('AnthropicPBC.') ? 'claude-desktop-msstore.exe' : 'claude-desktop.exe'), '')
    }
  }
  for (const version of squirrelVersions) {
    const appDirectory = path.join(localAppData, 'AnthropicClaude', `app-${version}`)
    await mkdir(appDirectory, { recursive: true })
    await writeFile(path.join(appDirectory, 'claude.exe'), '')
  }
  if (squirrelVersions.length > 0 && withStub) {
    await writeFile(path.join(localAppData, 'AnthropicClaude', 'claude.exe'), '')
  }
  const commands = []
  const powerShell = async command => {
    commands.push(command)
    return JSON.stringify({ packages: packages.length === 1 ? packages[0] : packages, protocol: protocol || null })
  }
  return { localAppData, commands, resolver: new ClaudeInstallResolver({ localAppData, powerShell }) }
}

test('direct MSIX install resolves to the family alias and Start app id', async t => {
  const f = await fixture(t, { packages: [directPackage], protocol: '"C:\\Program Files\\WindowsApps\\Claude_3.6556.2.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe" "%1"' })
  const install = await f.resolver.resolve([])
  assert.equal(install.kind, 'msix-direct')
  assert.equal(install.packageFamily, 'Claude_pzs8sxrjxfjjc')
  assert.equal(install.launchTarget, path.join(f.localAppData, 'Microsoft', 'WindowsApps', 'Claude_pzs8sxrjxfjjc', 'claude-desktop.exe'))
  assert.equal(install.startAppId, 'Claude_pzs8sxrjxfjjc!Claude')
  assert.equal(install.iconSource, 'C:\\Program Files\\WindowsApps\\Claude_3.6556.2.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe')
  assert.equal(install.version, '3.6556.2.0')
  assert.equal(install.protocolOwner, true)
  assert.ok(f.commands[0].includes("$families -contains $_.PackageFamilyName"))
  assert.ok(!f.commands[0].includes("-Name 'Claude*'"))
})

test('store MSIX install uses the msstore alias and is matched by family, not by name mask', async t => {
  const f = await fixture(t, { packages: [storePackage] })
  const install = await f.resolver.resolve([])
  assert.equal(install.kind, 'msix-store')
  assert.equal(install.launchTarget, path.join(f.localAppData, 'Microsoft', 'WindowsApps', 'AnthropicPBC.Claude_fnn82j28hfe8t', 'claude-desktop-msstore.exe'))
  assert.equal(install.startAppId, 'AnthropicPBC.Claude_fnn82j28hfe8t!Claude')
  assert.equal(install.protocolOwner, false)
})

test('alias falls back to the unscoped WindowsApps entry when the family folder is missing', async t => {
  const f = await fixture(t, { packages: [directPackage], scopedAlias: false })
  const install = await f.resolver.resolve([])
  assert.equal(install.launchTarget, path.join(f.localAppData, 'Microsoft', 'WindowsApps', 'claude-desktop.exe'))
})

test('Squirrel install is found from the app-* folders and launched through the stub', async t => {
  const f = await fixture(t, { squirrelVersions: ['0.9.0', '0.12.1', '0.10.3'] })
  const install = await f.resolver.resolve([])
  assert.equal(install.kind, 'squirrel')
  assert.equal(install.packageFamily, null)
  assert.equal(install.startAppId, null)
  assert.equal(install.version, '0.12.1')
  assert.equal(install.launchTarget, path.join(f.localAppData, 'AnthropicClaude', 'claude.exe'))
  assert.equal(install.iconSource, path.join(f.localAppData, 'AnthropicClaude', 'app-0.12.1', 'claude.exe'))
  assert.equal(install.installRoot, path.join(f.localAppData, 'AnthropicClaude'))
})

test('Squirrel install without a stub launches the newest app folder directly', async t => {
  const f = await fixture(t, { squirrelVersions: ['0.9.0', '0.12.1'], withStub: false })
  const install = await f.resolver.resolve([])
  assert.equal(install.launchTarget, path.join(f.localAppData, 'AnthropicClaude', 'app-0.12.1', 'claude.exe'))
})

test('no install at all resolves to null', async t => {
  const f = await fixture(t)
  assert.equal(await f.resolver.resolve([]), null)
})

test('process ownership survives a package update because only the stable name parts are compared', async t => {
  const f = await fixture(t, { packages: [directPackage] })
  const install = await f.resolver.resolve([])
  assert.equal(ClaudeInstallResolver.ownsExecutable(install, 'C:\\Program Files\\WindowsApps\\Claude_3.7000.1.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe'), true)
  assert.equal(ClaudeInstallResolver.ownsExecutable(install, 'C:\\Program Files\\WindowsApps\\Claude_3.7000.1.0_x64__other\\app\\Claude.exe'), false)
  assert.equal(ClaudeInstallResolver.ownsExecutable(install, 'C:\\Users\\me\\AppData\\Local\\ClaudeInstanceManager\\Portable\\Claude.exe'), false)
  assert.equal(ClaudeInstallResolver.ownsExecutable(install, undefined), false)
})

test('with several installs the running one wins, then the protocol owner, then the direct package', async t => {
  const protocol = '"C:\\Program Files\\WindowsApps\\AnthropicPBC.Claude_3.6556.2.0_x64__fnn82j28hfe8t\\app\\Claude.exe" "%1"'
  const f = await fixture(t, { packages: [directPackage, storePackage], protocol, squirrelVersions: ['0.12.1'] })
  const candidates = await f.resolver.candidates()
  assert.deepEqual(candidates.map(item => item.kind), ['msix-direct', 'msix-store', 'squirrel'])
  assert.equal(ClaudeInstallResolver.choose(candidates, []).kind, 'msix-store')
  assert.equal(ClaudeInstallResolver.choose(candidates, [path.join(f.localAppData, 'AnthropicClaude', 'app-0.12.1', 'claude.exe')]).kind, 'squirrel')
  const unowned = candidates.map(item => ({ ...item, protocolOwner: false }))
  assert.equal(ClaudeInstallResolver.choose(unowned, []).kind, 'msix-direct')
})

test('a malformed package record does not break discovery, a failing query propagates', async t => {
  const f = await fixture(t, { squirrelVersions: ['1.0.0'] })
  f.resolver.options.powerShell = async () => { throw new Error('timeout') }
  await assert.rejects(f.resolver.resolve([]), /timeout/)
  f.resolver.options.powerShell = async () => JSON.stringify({ packages: { PackageFamilyName: 'bad family name', InstallLocation: 'C:\\x' }, protocol: null })
  assert.equal((await f.resolver.resolve([])).kind, 'squirrel')
})
