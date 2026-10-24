const { readFileSync } = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const { transformSync } = require('esbuild')

// Load a main-process TypeScript module without Electron. Electron and process
// calls are replaced so tests cannot launch or close Claude or touch a user.
function electronStub() {
  return {
    app: { isPackaged: false, getAppPath: () => path.resolve(__dirname, '..'), getPath: () => path.join(process.env.USERPROFILE ?? '', 'Desktop') },
    shell: { readShortcutLink: () => null, writeShortcutLink: () => true, openPath: async () => '' }
  }
}

function loadSource(file, overrides = {}, cache = new Map()) {
  const resolved = path.resolve(file)
  if (cache.has(resolved)) {
    return cache.get(resolved).exports
  }
  const module = { exports: {} }
  cache.set(resolved, module)
  const localRequire = createRequire(resolved)
  const requireSource = name => {
    if (name in overrides) {
      return overrides[name]
    }
    if (name === 'electron') {
      return electronStub()
    }
    if (name.startsWith('.')) {
      return loadSource(path.resolve(path.dirname(resolved), `${name}.ts`), overrides, cache)
    }
    return localRequire(name)
  }
  const { code } = transformSync(readFileSync(resolved, 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' })
  new Function('require', 'module', 'exports', code)(requireSource, module, module.exports)
  return module.exports
}

module.exports = { loadSource, electronStub }
