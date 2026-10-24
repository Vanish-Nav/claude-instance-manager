const assert = require('node:assert/strict')
const { test } = require('node:test')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const { mkdtemp, mkdir, readdir, readFile, writeFile, rename, rm, access } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { loadSource, electronStub } = require('./load-source.cjs')

const family = 'Claude_pzs8sxrjxfjjc'
const installLocation = 'C:\\Program Files\\WindowsApps\\Claude_3.6556.2.0_x64__pzs8sxrjxfjjc'
const officialExe = `${installLocation}\\app\\Claude.exe`
const exists = file => access(file).then(() => true, () => false)

// One module graph per fixture: the adapter's child_process and electron are
// replaced so tests cannot launch or close Claude or touch a user.
function loadAdapter(childProcess, electron) {
  const overrides = { 'node:child_process': childProcess }
  if (electron) {
    overrides.electron = electron
  }
  return loadSource(path.resolve(__dirname, '../src/main/windows-adapter.ts'), overrides)
}

function fakeChild(pid, { ready = true } = {}) {
  const child = new EventEmitter()
  child.pid = pid
  child.exitCode = null
  child.killed = false
  child.stdout = new PassThrough()
  child.unref = () => {}
  child.kill = () => { child.killed = true; child.exitCode = 0; child.emit('exit', 0) }
  if (ready) {
    setTimeout(() => child.stdout.write('READY\tC:\\data\r\n'), 5)
  } else {
    setTimeout(() => child.stdout.write('ERROR\tRegisterClassEx failed\r\n'), 5)
  }
  return child
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'cim-profile-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const appData = path.join(root, 'Roaming')
  const localData = path.join(root, 'Local')
  const userProfile = root
  const roaming = path.join(appData, 'Claude')
  const code = path.join(appData, 'Claude Code')
  const cached = path.join(localData, 'Packages', family, 'LocalCache', 'Roaming', 'Claude')
  const relocated = path.join(localData, 'Claude-Data', family.toLowerCase())
  const dataRoot = path.dirname(relocated)
  const managerData = path.join(localData, 'ClaudeInstanceManager')
  const target = path.join(managerData, 'Profiles', 'CIM-Profile-test')
  // A stand-in for TaskbarHelper.exe: only its presence is checked here.
  const helper = path.join(root, 'TaskbarHelper.exe')
  const spawned = []
  const execFileCalls = []
  const childProcess = {
    spawn: (file, args, spawnOptions) => { const child = fakeChild(4321 + spawned.length, options.relay ?? {}); spawned.push({ file, args, spawnOptions, child }); return child },
    execFile: (file, args, execOptions, callback) => {
      const done = typeof execOptions === 'function' ? execOptions : callback
      execFileCalls.push({ file, args })
      if (file === 'powershell.exe') {
        Promise.resolve().then(() => f.powerShell(args[args.length - 1])).then(stdout => done(null, { stdout, stderr: '' }), error => done(error))
      } else if (path.basename(file).toLowerCase() === 'taskbarhelper.exe') {
        done(null, { stdout: f.singletonTitle ?? '', stderr: '' })
      } else {
        done(null, { stdout: '', stderr: '' })
      }
    }
  }
  const electron = electronStub()
  electron.app.getPath = () => path.join(userProfile, 'Desktop')
  // The adapter reads its folders from the environment when it is constructed.
  // Point it at the fixture for exactly that moment, never at the real user.
  const withFixtureEnvironment = fn => {
    const previous = { APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA, USERPROFILE: process.env.USERPROFILE }
    process.env.APPDATA = appData
    process.env.LOCALAPPDATA = localData
    process.env.USERPROFILE = userProfile
    try {
      return fn()
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    }
  }
  const { WindowsAdapter, PowerShellError } = withFixtureEnvironment(() => loadAdapter(childProcess, electron))
  const f = {
    root, appData, localData, roaming, code, cached, relocated, dataRoot, managerData, target, helper, spawned, execFileCalls, electron, PowerShellError,
    processes: [],
    packages: [{ PackageFamilyName: family, InstallLocation: installLocation, Version: '3.6556.2.0' }],
    singletonTitle: null,
    helperPids: new Set(),
    powerShellFails: false,
    powerShell: async command => {
      if (f.powerShellFails) {
        throw new Error('timeout')
      }
      if (command.includes('Get-AppxPackage')) {
        return JSON.stringify({ packages: f.packages, protocol: `"${officialExe}" "%1"` })
      }
      if (command.includes("Name='Claude.exe'")) {
        return f.processes.length === 0 ? '' : JSON.stringify(f.processes.map(item => ({ ProcessId: item.pid, ExecutablePath: item.exe, CommandLine: item.cmd })))
      }
      const helperMatch = /Get-Process -Id (\d+)/.exec(command)
      if (helperMatch) {
        return f.helperPids.has(Number(helperMatch[1])) ? 'TaskbarHelper' : ''
      }
      if (command.includes("Name='TaskbarHelper.exe'")) {
        return ''
      }
      throw new Error(`Unexpected PowerShell command in test: ${command}`)
    },
    put: async (directory, name = 'Local State', contents = 'profile-data') => {
      await mkdir(directory, { recursive: true })
      await writeFile(path.join(directory, name), contents)
    },
    createAdapter: () => {
      const adapter = withFixtureEnvironment(() => new WindowsAdapter())
      assert.equal(adapter.localData, managerData, 'the adapter must never see the real user folders')
      adapter.helperPath = () => f.helper
      return adapter
    },
    official: pid => ({ pid, exe: officialExe, cmd: `"${officialExe}" ` }),
    managedPrimary: (pid, dataPath) => ({ pid, exe: officialExe, cmd: `"${officialExe}" --user-data-dir=${dataPath}` }),
    isolated: (pid, profilePath) => ({ pid, exe: officialExe, cmd: `"${officialExe}" --user-data-dir=${profilePath} --app-user-model-id=x` }),
    renderer: (pid, profilePath) => ({ pid, exe: officialExe, cmd: `"${officialExe}" --type=renderer --user-data-dir=${profilePath}` })
  }
  f.adapter = f.createAdapter()
  f.paths = () => f.adapter.profilePaths()
  await mkdir(managerData, { recursive: true })
  await writeFile(f.helper, '')
  return f
}

// --- primary profile detection -------------------------------------------

test('legacy profile detection preserves Claude preference and Claude Code fallback', async t => {
  const f = await fixture(t)
  assert.equal(await (await f.paths()).primary(), f.roaming)
  assert.equal((await f.adapter.getState()).profiles[0].exists, false)
  await f.put(f.code)
  assert.equal(await (await f.paths()).primary(), f.code)
  await f.put(f.roaming)
  assert.equal(await (await f.paths()).primary(), f.roaming)
})

test('running MSIX Claude with no real Roaming folder has an existing primary profile', async t => {
  const f = await fixture(t)
  await f.put(f.cached)
  f.processes = [f.official(100)]
  const profile = (await f.adapter.getState()).profiles[0]
  assert.equal(profile.path, f.cached)
  assert.equal(profile.exists, true)
  assert.equal(profile.running, true)
})

test('new Claude-Data package profile is detected', async t => {
  const f = await fixture(t)
  await f.put(f.relocated)
  assert.equal((await f.adapter.getState()).profiles[0].path, f.relocated)
  assert.equal((await f.adapter.getState()).profiles[0].exists, true)
})

test('package paths use the registered family instead of a fixed publisher suffix', async t => {
  const f = await fixture(t)
  f.packages = [{ PackageFamilyName: 'Claude_abc123def4567', InstallLocation: 'C:\\Program Files\\WindowsApps\\Claude_3.0.0.0_x64__abc123def4567', Version: '3.0.0.0' }]
  const cached = path.join(f.localData, 'Packages', 'Claude_abc123def4567', 'LocalCache', 'Roaming', 'Claude')
  await f.put(cached)
  assert.equal((await f.adapter.getState()).profiles[0].path, cached)
  await f.put(cached, '.user-data-left.claude_abc123def4567', '')
  await f.put(path.join(f.dataRoot, 'claude_abc123def4567'))
  assert.equal((await f.adapter.getState()).profiles[0].path, path.join(f.dataRoot, 'claude_abc123def4567'))
})

test('migration markers distinguish the active relocated profile from a rollback', async t => {
  const f = await fixture(t)
  await f.put(f.relocated)
  await f.put(f.cached, `.user-data-left.${family.toLowerCase()}`, '')
  assert.equal(await (await f.paths()).primary(), f.relocated)
  await f.put(f.cached, `.user-data-back.${family.toLowerCase()}`, '')
  assert.equal(await (await f.paths()).primary(), f.cached)
})

test('Claude-Data root is detected only when it contains actual profile files', async t => {
  const f = await fixture(t)
  await mkdir(f.dataRoot, { recursive: true })
  await f.put(f.roaming)
  assert.equal(await (await f.paths()).primary(), f.roaming)
  await f.put(f.dataRoot)
  assert.equal(await (await f.paths()).primary(), f.dataRoot)
})

// --- installation and processes ------------------------------------------

test('state reports the resolved installation and caches it until an explicit refresh', async t => {
  const f = await fixture(t)
  const state = await f.adapter.getState()
  assert.equal(state.install.kind, 'msix-direct')
  assert.equal(state.installedVersion, '3.6556.2.0')
  const before = f.execFileCalls.filter(call => call.args.at(-1).includes('Get-AppxPackage')).length
  await f.adapter.getState()
  await f.adapter.profileRunningStates()
  assert.equal(f.execFileCalls.filter(call => call.args.at(-1).includes('Get-AppxPackage')).length, before)
  await f.adapter.getState(true)
  assert.equal(f.execFileCalls.filter(call => call.args.at(-1).includes('Get-AppxPackage')).length, before + 1)
})

test('running states: official and managed primary, isolated by profile path, renderers ignored', async t => {
  const f = await fixture(t)
  await f.put(f.roaming)
  await f.put(f.target, 'instance.json', JSON.stringify({ name: 'Test', color: 'blue' }))
  const states = async () => f.adapter.profileRunningStates()
  f.processes = [f.renderer(1, f.target)]
  assert.deepEqual(await states(), { default: false, 'instance-CIM-Profile-test': false })
  f.processes = [f.isolated(2, f.target)]
  assert.deepEqual(await states(), { default: false, 'instance-CIM-Profile-test': true })
  f.processes = [f.official(3)]
  assert.deepEqual(await states(), { default: true, 'instance-CIM-Profile-test': false })
  f.processes = [f.managedPrimary(4, f.roaming)]
  assert.deepEqual(await states(), { default: true, 'instance-CIM-Profile-test': false })
  f.processes = [{ pid: 5, exe: path.join(f.managerData, 'Portable', 'Claude.exe'), cmd: 'Claude.exe' }]
  assert.deepEqual(await states(), { default: false, 'instance-CIM-Profile-test': false })
})

test('a failed process query shows profiles as stopped in state but fails actions that must know', async t => {
  const f = await fixture(t)
  await f.put(f.roaming)
  f.powerShellFails = true
  assert.equal((await f.adapter.getState()).profiles[0].running, false)
  await assert.rejects(f.adapter.startProfile('default'), f.PowerShellError)
  await mkdir(f.managerData, { recursive: true })
  await writeFile(path.join(f.managerData, 'sso-state.json'), JSON.stringify({ mode: 'swap', profilePath: f.target, originalProfilePath: f.roaming, originalProfileBackup: path.join(f.appData, 'Claude.backup') }))
  await f.put(path.join(f.appData, 'Claude.backup'))
  f.powerShellFails = false
  f.packages = []
  f.adapter = f.createAdapter()
  f.powerShellFails = true
  await assert.rejects(f.adapter.restoreSso(), error => error instanceof f.PowerShellError && !/Quit Claude/.test(error.message))
})

test('an isolated instance is launched through the installed Claude with its profile and taskbar identity', async t => {
  const f = await fixture(t)
  await f.put(f.target, 'instance.json', JSON.stringify({ name: 'Test', color: 'blue' }))
  await f.adapter.startProfile('instance-CIM-Profile-test')
  const [launch, helper] = f.spawned
  assert.equal(launch.file, path.join(f.localData, 'Microsoft', 'WindowsApps', 'claude-desktop.exe'))
  assert.deepEqual(launch.args, [`--user-data-dir=${f.target}`, '--app-user-model-id=com.claude-instance-manager.profile.v3.instance-CIM-Profile-test'])
  assert.equal(helper.file, f.helper)
  assert.equal(helper.args[0], String(launch.child.pid))
  assert.equal(helper.args[2], 'Test')
  assert.equal(helper.args[4], `"${process.execPath}" --launch-profile=instance-CIM-Profile-test`)
  assert.ok(helper.args[4].length < 260, 'the shell rejects a RelaunchCommand of 260 characters or more')
})

test('a running instance without a live helper gets its taskbar identity re-applied on refresh', async t => {
  const f = await fixture(t)
  await f.put(f.target, 'instance.json', JSON.stringify({ name: 'Test', color: 'blue' }))
  f.processes = [f.isolated(11, f.target)]
  await f.adapter.getState()
  const helpers = f.spawned.filter(item => item.file === f.helper)
  assert.equal(helpers.length, 1)
  assert.equal(helpers[0].args[0], '11')
  await f.adapter.getState()
  assert.equal(f.spawned.filter(item => item.file === f.helper).length, 1, 'a live helper is not duplicated')
  helpers[0].child.kill()
  await f.adapter.getState()
  assert.equal(f.spawned.filter(item => item.file === f.helper).length, 2, 'an exited helper is replaced')
})

test('stopping a profile asks it to close first and forces only after it stays alive', async t => {
  const f = await fixture(t)
  await f.put(f.target, 'instance.json', JSON.stringify({ name: 'Test', color: 'blue' }))
  f.processes = [f.isolated(7, f.target)]
  let queries = 0
  const original = f.powerShell
  f.powerShell = async command => {
    if (command.includes("Name='Claude.exe'")) {
      queries += 1
      if (queries > 6) {
        f.processes = []
      }
    }
    return original(command)
  }
  f.adapter.waitForProfileStopped = async function (profile, attempts) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (!(await this.profileProcessId(profile))) {
        return true
      }
    }
    return false
  }
  await f.adapter.stopProfile('instance-CIM-Profile-test')
  const kills = f.execFileCalls.filter(call => call.file === 'taskkill.exe').map(call => call.args)
  assert.equal(kills.length, 1)
  assert.deepEqual(kills[0], ['/PID', '7', '/T'])
  queries = 0
  f.processes = [f.isolated(8, f.target)]
  f.adapter.waitForProfileStopped = async () => false
  await f.adapter.stopProfile('instance-CIM-Profile-test')
  const forced = f.execFileCalls.filter(call => call.file === 'taskkill.exe').map(call => call.args)
  assert.deepEqual(forced.slice(-2), [['/PID', '8', '/T'], ['/PID', '8', '/T', '/F']])
})

// --- shortcuts and portable runtime ---------------------------------------

test('profile shortcuts launch through the manager and are recognised in both forms', async t => {
  const f = await fixture(t)
  const written = []
  f.electron.shell.writeShortcutLink = (file, operation, details) => { written.push({ file, operation, details }); return true }
  const profile = await f.adapter.createProfile({ name: 'Linked', color: 'teal', desktopShortcut: true, startMenuShortcut: false })
  assert.equal(written.length, 1)
  assert.equal(written[0].details.target, process.execPath)
  assert.equal(written[0].details.args, `--launch-profile=${profile.id}`)
  assert.equal(written[0].details.appUserModelId, `com.claude-instance-manager.profile.v3.${profile.id}`)
  assert.ok(written[0].details.icon.endsWith('claude-profile-teal.ico'))
  f.electron.shell.readShortcutLink = () => written[0].details
  await mkdir(f.electron.app.getPath(), { recursive: true })
  await writeFile(path.join(f.electron.app.getPath(), 'Claude — Linked.lnk'), '')
  const listed = (await f.adapter.getState()).profiles.find(item => item.id === profile.id)
  assert.equal(listed.desktopShortcut, true)
  f.electron.shell.readShortcutLink = () => ({ target: 'C:\\alias.exe', args: `--user-data-dir=${profile.path} --app-user-model-id=x` })
  assert.equal((await f.adapter.getState()).profiles.find(item => item.id === profile.id).desktopShortcut, true)
})

test('direct and portable shortcuts are migrated once to launch through the manager', async t => {
  const f = await fixture(t)
  const portableExe = path.join(f.managerData, 'Portable', 'Claude.exe')
  await f.put(f.target, 'instance.json', JSON.stringify({ name: 'Test', color: 'blue' }))
  const desktop = f.electron.app.getPath()
  await mkdir(desktop, { recursive: true })
  for (const name of ['Claude — Test.lnk', 'Alias.lnk', 'Claude.lnk', 'Other.lnk']) {
    await writeFile(path.join(desktop, name), '')
  }
  const written = []
  f.electron.shell.readShortcutLink = file => {
    if (file.endsWith('Other.lnk')) {
      return { target: 'C:\\other.exe', args: '' }
    }
    if (file.endsWith('Claude.lnk')) {
      return { target: portableExe, args: '', icon: portableExe }
    }
    if (file.endsWith('Alias.lnk')) {
      return { target: path.join(f.localData, 'Microsoft', 'WindowsApps', 'claude-desktop.exe'), args: `--user-data-dir=${f.target} --app-user-model-id=x` }
    }
    return { target: portableExe, args: `--user-data-dir=${f.target}`, icon: portableExe }
  }
  f.electron.shell.writeShortcutLink = (file, operation, details) => { written.push({ file: path.basename(file), operation, details }); return true }
  await f.adapter.getState()
  await f.adapter.getState()
  assert.deepEqual(written.map(item => [item.file, item.operation]).sort(), [['Alias.lnk', 'replace'], ['Claude — Test.lnk', 'replace'], ['Claude.lnk', 'update']])
  for (const item of written.filter(item => item.operation === 'replace')) {
    assert.equal(item.details.target, process.execPath)
    assert.equal(item.details.args, '--launch-profile=instance-CIM-Profile-test')
  }
  const plain = written.find(item => item.file === 'Claude.lnk')
  assert.equal(plain.details.target, path.join(f.localData, 'Microsoft', 'WindowsApps', 'claude-desktop.exe'))
  assert.equal(plain.details.icon, officialExe)
})

test('the portable folder is offered for removal once and refused while it is in use', async t => {
  const f = await fixture(t)
  const portable = path.join(f.managerData, 'Portable')
  await f.put(portable, 'Claude.exe', 'binary')
  assert.equal((await f.adapter.getState()).portableCleanup.path, portable)
  f.processes = [{ pid: 9, exe: path.join(portable, 'Claude.exe'), cmd: 'Claude.exe --user-data-dir=x' }]
  await assert.rejects(f.adapter.removePortableRuntime(), /still running/)
  f.processes = []
  await f.adapter.removePortableRuntime()
  assert.equal(await exists(portable), false)
  assert.equal((await f.adapter.getState()).portableCleanup, null)
  await f.put(portable, 'Claude.exe', 'binary')
  assert.equal((await f.adapter.getState()).portableCleanup, null)
  await f.adapter.dismissPortableCleanup()
})

// --- Sign In through the relay -------------------------------------------

test('Sign In refuses while the primary runs, remembers its data folder, and closes it on request', async t => {
  const f = await fixture(t)
  await f.put(f.roaming)
  await f.put(f.target, 'instance.json', JSON.stringify({ name: 'Test', color: 'blue' }))
  f.processes = [f.official(100)]
  f.singletonTitle = 'C:\\live\\primary\\data\r\n'
  await assert.rejects(f.adapter.beginSignIn('instance-CIM-Profile-test'), /primary Claude is running/)
  assert.equal(f.spawned.length, 0)
  f.adapter.stopProfile = async id => { assert.equal(id, 'default'); f.processes = [] }
  await f.adapter.beginSignIn('instance-CIM-Profile-test', true)
  const relay = f.spawned.find(item => item.args[0] === '--relay')
  assert.deepEqual(relay.args, ['--relay', 'C:\\live\\primary\\data', path.join(f.localData, 'Microsoft', 'WindowsApps', 'claude-desktop.exe'), f.target])
  assert.ok(f.spawned.some(item => item.args[0] === `--user-data-dir=${f.target}`), 'the instance is started')
  const state = JSON.parse(await readFile(path.join(f.managerData, 'sign-in-state.json'), 'utf8'))
  assert.equal(state.relayProcessId, relay.child.pid)
  const settings = JSON.parse(await readFile(path.join(f.managerData, 'settings.json'), 'utf8'))
  assert.equal(settings.lastPrimaryDataPath, 'C:\\live\\primary\\data')
})

test('Sign In without a live primary uses the detected profile path and ends when the relay is gone', async t => {
  const f = await fixture(t)
  await f.put(f.relocated)
  await f.put(f.target, 'instance.json', JSON.stringify({ name: 'Test', color: 'blue' }))
  f.processes = [f.isolated(5, f.target)]
  await f.adapter.beginSignIn('instance-CIM-Profile-test')
  const relay = f.spawned.find(item => item.args[0] === '--relay')
  assert.equal(relay.args[1], f.relocated)
  assert.equal(f.spawned.length, 1, 'a running instance is not started again')
  f.helperPids.add(relay.child.pid)
  let state = await f.adapter.getState()
  assert.equal(state.pendingSignIn, true)
  assert.equal(state.pendingSignInProfileName, 'Test')
  await assert.rejects(f.adapter.beginSignIn('instance-CIM-Profile-test'), /already in progress/)
  f.helperPids.clear()
  state = await f.adapter.getState()
  assert.equal(state.pendingSignIn, false)
  assert.equal(await exists(path.join(f.managerData, 'sign-in-state.json')), false)
})

test('Finish Sign In stops the relay and nothing on disk is moved', async t => {
  const f = await fixture(t)
  await f.put(f.roaming, 'Local State', 'regular')
  await f.put(f.target, 'instance.json', JSON.stringify({ name: 'Test', color: 'blue' }))
  await f.put(f.target, 'Local State', 'isolated')
  await f.adapter.beginSignIn('instance-CIM-Profile-test')
  const relay = f.spawned.find(item => item.args[0] === '--relay')
  f.helperPids.add(relay.child.pid)
  const killed = []
  const originalKill = process.kill
  process.kill = (pid, signal) => { killed.push([pid, signal]) }
  t.after(() => { process.kill = originalKill })
  await f.adapter.finishSignIn()
  assert.deepEqual(killed, [[relay.child.pid, undefined]])
  assert.equal(await readFile(path.join(f.roaming, 'Local State'), 'utf8'), 'regular')
  assert.equal(await readFile(path.join(f.target, 'Local State'), 'utf8'), 'isolated')
  assert.equal((await f.adapter.getState()).pendingSignIn, false)
  await f.adapter.finishSignIn()
  assert.equal((await f.adapter.getState()).pendingSignIn, false, 'finishing twice is harmless')
})

test('a relay that cannot take the window fails Sign In without leaving state behind', async t => {
  const f = await fixture(t, { relay: { ready: false } })
  await f.put(f.roaming)
  await f.put(f.target, 'instance.json', JSON.stringify({ name: 'Test', color: 'blue' }))
  await assert.rejects(f.adapter.beginSignIn('instance-CIM-Profile-test'), /could not take over/)
  assert.equal(await exists(path.join(f.managerData, 'sign-in-state.json')), false)
})

// --- legacy recovery -----------------------------------------------------

for (const location of ['roaming', 'code', 'cached', 'relocated', 'dataRoot']) {
  test(`legacy swap recovery restores both profiles at the ${location} location`, async t => {
    const f = await fixture(t)
    const primary = f[location]
    const temporary = location === 'code' ? f.roaming : primary
    const backup = path.join(path.dirname(primary), `${path.basename(primary)}.normal-profile-backup-for-CIM-Profile-test-20250101T000000`)
    await f.put(backup, 'Local State', 'regular-session')
    await f.put(temporary, 'Local State', 'signed-in-session')
    await f.put(temporary, '.cim-sign-in', 'token-1')
    await writeFile(path.join(f.managerData, 'sso-state.json'), JSON.stringify({ mode: 'swap', profileId: 'instance-CIM-Profile-test', profileName: 'Test', profilePath: f.target, originalProfileBackup: backup, originalProfilePath: primary, signInProfilePath: temporary, signInToken: 'token-1' }))
    await mkdir(path.dirname(f.target), { recursive: true })
    assert.equal((await f.adapter.getState()).legacySignInRecovery, true)
    f.processes = [f.official(1)]
    await assert.rejects(f.adapter.restoreSso(), /Quit Claude completely/)
    f.processes = []
    await f.adapter.restoreSso()
    assert.equal(await readFile(path.join(primary, 'Local State'), 'utf8'), 'regular-session')
    assert.equal(await readFile(path.join(f.target, 'Local State'), 'utf8'), 'signed-in-session')
    assert.equal(await exists(path.join(f.target, '.cim-sign-in')), false)
    assert.equal(await exists(backup), false)
    assert.equal((await f.adapter.getState()).legacySignInRecovery, false)
  })
}

test('legacy recovery refuses an unrelated folder and preserves the regular backup', async t => {
  const f = await fixture(t)
  const backup = path.join(f.dataRoot, `${path.basename(f.relocated)}.backup`)
  await f.put(backup, 'Local State', 'regular-session')
  await f.put(f.relocated, 'Local State', 'signed-in-session')
  await writeFile(path.join(f.managerData, 'sso-state.json'), JSON.stringify({ mode: 'swap', profilePath: f.target, originalProfileBackup: backup, originalProfilePath: f.relocated, signInProfilePath: f.relocated, signInToken: 'token-2' }))
  await assert.rejects(f.adapter.restoreSso(), /temporary Claude profile is missing/)
  assert.equal(await exists(backup), true)
})

test('legacy recovery finds a temporary profile migrated by Claude during Sign In', async t => {
  const f = await fixture(t)
  const backup = path.join(f.appData, 'Claude.backup')
  await f.put(backup, 'Local State', 'regular-session')
  await f.put(f.relocated, 'Local State', 'signed-in-session')
  await f.put(f.relocated, '.cim-sign-in', 'token-3')
  await writeFile(path.join(f.managerData, 'sso-state.json'), JSON.stringify({ mode: 'swap', profilePath: f.target, originalProfileBackup: backup, originalProfilePath: f.roaming, signInProfilePath: f.roaming, signInToken: 'token-3' }))
  await mkdir(path.dirname(f.target), { recursive: true })
  await f.adapter.restoreSso()
  assert.equal(await readFile(path.join(f.roaming, 'Local State'), 'utf8'), 'regular-session')
  assert.equal(await readFile(path.join(f.target, 'Local State'), 'utf8'), 'signed-in-session')
})

test('legacy recovery rejects a saved profile path outside the supported locations and junction states', async t => {
  const f = await fixture(t)
  const backup = path.join(f.appData, 'Claude.backup')
  await f.put(backup)
  await writeFile(path.join(f.managerData, 'sso-state.json'), JSON.stringify({ mode: 'swap', profilePath: f.target, originalProfileBackup: backup, originalProfilePath: path.join(f.root, 'unrelated') }))
  await assert.rejects(f.adapter.restoreSso(), /location is invalid/)
  await writeFile(path.join(f.managerData, 'sso-state.json'), JSON.stringify({ mode: 'junction', profilePath: f.target, originalProfileBackup: backup }))
  await assert.rejects(f.adapter.restoreSso(), /junction/)
  assert.equal(await exists(backup), true)
})

// --- backups, clone, caches ----------------------------------------------

async function profileWithSession(f, directory, label) {
  await f.put(directory, 'instance.json', JSON.stringify({ name: label, color: 'blue' }))
  await f.put(directory, 'config.json', JSON.stringify({ locale: label, 'oauth:tokenCache': `${label}-token` }))
  await f.put(directory, 'Local State', `${label}-key`)
  await f.put(path.join(directory, 'Network'), 'Cookies', `${label}-cookies`)
  await f.put(directory, 'ant-did', `${label}-device`)
  await f.put(path.join(directory, 'Cache'), 'blob', `${label}-cache`)
  await f.put(path.join(directory, 'Partitions'), 'p', `${label}-partition`)
}

test('backups are tiered, listed with their tier, and imported according to it', async t => {
  const f = await fixture(t)
  await profileWithSession(f, f.target, 'test')
  const session = await f.adapter.backupProfile('instance-CIM-Profile-test', 'session')
  const full = await f.adapter.backupProfile('instance-CIM-Profile-test', 'full')
  const settings = await f.adapter.backupProfile('instance-CIM-Profile-test', 'settings')
  assert.equal(await exists(path.join(session, 'Partitions')), false)
  assert.equal(await exists(path.join(full, 'Partitions')), true)
  assert.equal(await exists(path.join(full, 'Cache')), false)
  assert.equal(await exists(path.join(settings, 'Network')), false)
  const items = await f.adapter.storageItems('backup')
  assert.deepEqual(items.map(item => item.tier).sort(), ['full', 'session', 'settings'])
  assert.ok(items.every(item => item.profileName === 'test'))
  await f.put(f.target, 'config.json', JSON.stringify({ locale: 'changed', 'oauth:tokenCache': 'new-token' }))
  const settingsItem = items.find(item => item.tier === 'settings')
  await f.adapter.importStorageItem('instance-CIM-Profile-test', 'backup', settingsItem.id, false)
  const config = JSON.parse(await readFile(path.join(f.target, 'config.json'), 'utf8'))
  assert.equal(config.locale, 'test')
  assert.equal(config['oauth:tokenCache'], 'new-token')
  assert.equal(await readFile(path.join(f.target, 'Cache', 'blob'), 'utf8'), 'test-cache')
  assert.deepEqual(JSON.parse(await readFile(path.join(f.target, 'instance.json'), 'utf8')), { name: 'test', color: 'blue' })
})

test('old backups without a tier import as full copies', async t => {
  const f = await fixture(t)
  await profileWithSession(f, f.target, 'test')
  const item = path.join(f.managerData, 'Backups', 'instance-CIM-Profile-test', '20240101T000000')
  await f.put(item, 'Local State', 'old-key')
  await writeFile(path.join(item, '.cim-storage.json'), JSON.stringify({ profileId: 'instance-CIM-Profile-test', profileName: 'Old', kind: 'backup', createdAt: '2024-01-01T00:00:00.000Z', sizeBytes: 7 }))
  const [listed] = await f.adapter.storageItems('backup')
  assert.equal(listed.tier, 'full')
  await f.adapter.importStorageItem('instance-CIM-Profile-test', 'backup', listed.id, false)
  assert.equal(await readFile(path.join(f.target, 'Local State'), 'utf8'), 'old-key')
  assert.equal(await exists(path.join(f.target, 'Cache')), false)
  assert.equal(await exists(path.join(f.target, '.cim-storage.json')), false)
})

test('cloning a session copies the login and gives the target a new device id', async t => {
  const f = await fixture(t)
  await f.put(f.roaming)
  await profileWithSession(f, f.roaming, 'primary')
  await profileWithSession(f, f.target, 'test')
  await f.adapter.cloneSession('default', 'instance-CIM-Profile-test', true)
  assert.equal(await readFile(path.join(f.target, 'Network', 'Cookies'), 'utf8'), 'primary-cookies')
  assert.equal(await readFile(path.join(f.target, 'Local State'), 'utf8'), 'primary-key')
  const deviceId = await readFile(path.join(f.target, 'ant-did'), 'utf8')
  assert.notEqual(deviceId, 'primary-device')
  assert.notEqual(deviceId, 'test-device')
  assert.equal(await readFile(path.join(f.target, 'Cache', 'blob'), 'utf8'), 'test-cache')
  assert.deepEqual(JSON.parse(await readFile(path.join(f.target, 'instance.json'), 'utf8')), { name: 'test', color: 'blue' })
  assert.equal((await f.adapter.storageItems('backup')).length, 1, 'the target session was backed up first')
  await assert.rejects(f.adapter.cloneSession('instance-CIM-Profile-test', 'default'), /isolated instance/)
})

test('cache cleaning needs a stopped instance and accepts cache folders only', async t => {
  const f = await fixture(t)
  await profileWithSession(f, f.target, 'test')
  const sizes = await f.adapter.profileSizes('instance-CIM-Profile-test')
  assert.equal(sizes.entries.find(entry => entry.name === 'Cache').category, 'cache')
  await assert.rejects(f.adapter.cleanCaches('instance-CIM-Profile-test', ['Network']), /not a cache folder/)
  f.processes = [f.isolated(3, f.target)]
  await assert.rejects(f.adapter.cleanCaches('instance-CIM-Profile-test', ['Cache']), /Close this instance/)
  f.processes = []
  await f.adapter.cleanCaches('instance-CIM-Profile-test', ['Cache', 'logs'])
  assert.equal(await exists(path.join(f.target, 'Cache')), false)
  assert.equal(await exists(path.join(f.target, 'Network')), true)
})

test('deep links go to the last opened running instance or need a pick', async t => {
  const f = await fixture(t)
  await f.put(f.roaming)
  await f.put(f.target, 'instance.json', JSON.stringify({ name: 'Test', color: 'blue' }))
  f.processes = []
  const none = await f.adapter.routeDeepLink('claude://code/session/1')
  assert.equal(none.delivered, false)
  assert.equal(none.candidates.length, 2)
  f.processes = [f.isolated(2, f.target)]
  assert.deepEqual(await f.adapter.routeDeepLink('claude://code/session/1'), { delivered: true })
  const delivery = f.spawned.at(-1)
  assert.deepEqual(delivery.args.slice(-1), ['claude://code/session/1'])
  assert.ok(delivery.args[0].startsWith(`--user-data-dir=${f.target}`))
  f.processes = [f.isolated(2, f.target), f.official(3)]
  assert.deepEqual(await f.adapter.routeDeepLink('claude://code/session/2'), { delivered: true }, 'the last target is preferred')
  await f.adapter.startProfile('default')
  f.processes = [f.isolated(2, f.target), f.official(3)]
  const ambiguous = await f.adapter.routeDeepLink('claude://code/session/3')
  assert.equal(ambiguous.delivered, true, 'the primary was opened last')
  await assert.rejects(f.adapter.deliverDeepLink('https://example.com', 'default'), /claude:\/\//)
})

test('copying settings from the primary keeps the target login and device id and honours the selection', async t => {
  const f = await fixture(t)
  await f.put(f.roaming)
  await profileWithSession(f, f.roaming, 'primary')
  await f.put(path.join(f.roaming, 'claude-code-sessions', 's', 'a'), 'local_1.json', JSON.stringify({ cwd: 'D:\\Keep', title: 'keep' }))
  await f.put(path.join(f.roaming, 'claude-code-sessions', 's', 'a'), 'local_2.json', JSON.stringify({ cwd: 'D:\\Drop', title: 'drop' }))
  await profileWithSession(f, f.target, 'test')
  const contents = await f.adapter.profileContents('default')
  assert.deepEqual(contents.projects.map(project => project.cwd), ['D:\\Drop', 'D:\\Keep'])
  await f.adapter.cloneSession('default', 'instance-CIM-Profile-test', false, 'settings', { projects: ['D:\\Keep'], cowork: true })
  assert.equal(await readFile(path.join(f.target, 'Network', 'Cookies'), 'utf8'), 'test-cookies')
  assert.equal(await readFile(path.join(f.target, 'ant-did'), 'utf8'), 'test-device')
  const config = JSON.parse(await readFile(path.join(f.target, 'config.json'), 'utf8'))
  assert.equal(config.locale, 'primary')
  assert.equal(config['oauth:tokenCache'], 'test-token')
  const sessions = await readdir(path.join(f.target, 'claude-code-sessions', 's', 'a'))
  assert.deepEqual(sessions, ['local_1.json'])
  await assert.rejects(f.adapter.cloneSession('default', 'instance-CIM-Profile-test', false, 'full'), /Unsupported copy tier/)
})

test('pins and shortcuts of a manager at another location are claimed by the installed one', async t => {
  const f = await fixture(t)
  await f.put(f.target, 'instance.json', JSON.stringify({ name: 'Test', color: 'blue' }))
  const pinRoot = path.join(f.appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned')
  const implicit = path.join(pinRoot, 'ImplicitAppShortcuts', 'abc123')
  await mkdir(path.join(pinRoot, 'TaskBar'), { recursive: true })
  await mkdir(implicit, { recursive: true })
  await writeFile(path.join(implicit, 'Test.lnk'), '')
  await writeFile(path.join(pinRoot, 'TaskBar', 'Other.lnk'), '')
  const foreign = path.join(f.root, 'win-unpacked', path.basename(process.execPath))
  const written = []
  f.electron.shell.readShortcutLink = file => file.endsWith('Test.lnk')
    ? { target: foreign, args: '--launch-profile=instance-CIM-Profile-test' }
    : { target: 'C:\\other\\tool.exe', args: '' }
  f.electron.shell.writeShortcutLink = (file, operation, details) => { written.push({ file: path.basename(file), operation, details }); return true }
  f.electron.app.isPackaged = true
  await f.adapter.getState()
  assert.deepEqual(written.map(item => [item.file, item.operation, item.details.target]), [['Test.lnk', 'update', process.execPath]])
})

test('an unpacked development build never claims pins of the installed manager', async t => {
  const f = await fixture(t)
  await f.put(f.target, 'instance.json', JSON.stringify({ name: 'Test', color: 'blue' }))
  const desktop = f.electron.app.getPath()
  await mkdir(desktop, { recursive: true })
  await writeFile(path.join(desktop, 'Test.lnk'), '')
  const written = []
  f.electron.shell.readShortcutLink = () => ({ target: path.join('C:\\Program Files\\Claude Instance Manager', path.basename(process.execPath)), args: '--launch-profile=instance-CIM-Profile-test' })
  f.electron.shell.writeShortcutLink = (file, operation, details) => { written.push({ file, operation, details }); return true }
  f.electron.app.isPackaged = false
  await f.adapter.getState()
  assert.equal(written.length, 0)
})

test('renaming or recolouring an instance refreshes the icon and description of its taskbar pins', async t => {
  const f = await fixture(t)
  await f.put(f.target, 'instance.json', JSON.stringify({ name: 'Test', color: 'blue' }))
  const pin = path.join(f.appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar')
  await mkdir(pin, { recursive: true })
  await writeFile(path.join(pin, 'Test.lnk'), '')
  const written = []
  f.electron.shell.readShortcutLink = () => ({ target: process.execPath, args: '--launch-profile=instance-CIM-Profile-test' })
  f.electron.shell.writeShortcutLink = (file, operation, details) => { written.push({ file: path.basename(file), operation, details }); return true }
  await f.adapter.setProfileColor('instance-CIM-Profile-test', 'amber')
  await f.adapter.renameProfile('instance-CIM-Profile-test', 'Renamed')
  const pins = written.filter(item => item.file === 'Test.lnk')
  assert.equal(pins.length, 2)
  assert.ok(pins[0].details.icon.endsWith('claude-profile-amber.ico'))
  assert.equal(pins[1].details.description, 'Claude profile: Renamed')
  assert.ok(pins.every(item => item.operation === 'update' && item.details.target === process.execPath), 'the pin file and target stay as they were')
})
