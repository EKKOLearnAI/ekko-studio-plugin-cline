import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { childEnvironment, engineVersion, findEngine } from './engine.mjs'

const exec = promisify(execFile)
const registry = 'https://registry.npmjs.org/'
const packageName = 'cline'
const versionPattern = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/
const releasePattern = /^release-[a-zA-Z0-9]+$/
const windows = process.platform === 'win32'
const binaryPackage = 'cli-' + (windows ? 'windows' : process.platform) + '-' + process.arch
const binaryName = windows ? 'cline.exe' : 'cline'
const nativePackage = '@cline/' + binaryPackage
const externallyManaged = 'This Cline CLI installation is managed outside Studio.'
const operations = new Map()

async function readable(path) {
  try { await access(path); return true } catch { return false }
}

async function npmRuntime(signal) {
  const env = childEnvironment(process.env, { nativeProvider: false })
  const executable = windows ? 'node.exe' : 'node'
  const paths = env.PATH.split(delimiter).filter(isAbsolute)
  const candidates = new Set([process.env.HERMES_AGENT_NODE,
    ...(!process.versions.electron ? [process.execPath] : []), ...paths.map(dir => join(dir, executable))])
  for (const candidate of candidates) {
    signal.throwIfAborted()
    if (!candidate || !isAbsolute(candidate) || !await readable(candidate)) continue
    const node = await realpath(candidate)
    const bin = dirname(node)
    const npmPaths = [
      join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ]
    const adjacentNpm = join(dirname(candidate), 'npm')
    if (!windows && await readable(adjacentNpm)) {
      const file = await realpath(adjacentNpm)
      if (file.endsWith('.js')) npmPaths.push(file)
    }
    for (const npm of npmPaths) {
      if (!await readable(npm)) continue
      try {
        await exec(node, [npm, '--version'], { signal, env, timeout: 5000, maxBuffer: 4096, windowsHide: true })
        return { node, npm }
      } catch {
        signal.throwIfAborted()
      }
    }
  }
  throw new Error('A Node.js installation with npm is required on the Studio host.')
}

async function selectedRelease(root) {
  let value
  try { value = JSON.parse(await readFile(join(root, 'current.json'), 'utf8')) }
  catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw new Error('Could not read the Studio-managed Cline engine selection.')
  }
  if (value === null || typeof value === 'string' && releasePattern.test(value)) return value
  throw new Error('The Studio-managed Cline engine selection is invalid.')
}

async function selectRelease(root, value) {
  const temporary = join(root, '.selection-' + randomUUID())
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
    await rename(temporary, join(root, 'current.json'))
  } finally {
    await rm(temporary, { force: true })
  }
}

function serialize(root, task) {
  const previous = operations.get(root) || Promise.resolve()
  const current = previous.catch(() => {}).then(task)
  operations.set(root, current)
  return current.finally(() => { if (operations.get(root) === current) operations.delete(root) })
}

function cleanup(path) {
  return rm(path, { force: true, recursive: true, maxRetries: 3 })
}

async function targetRelease(directory) {
  const path = join(directory, 'node_modules', '@cline', binaryPackage, 'bin', binaryName)
  if (await readable(path)) return { command: path, prefix: [] }
}

async function latestVersion(signal) {
  let response
  try {
    response = await fetch(registry + packageName + '/latest', {
      redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    })
  } catch {
    signal.throwIfAborted()
  }
  if (!response?.ok) throw new Error('Could not check Cline CLI versions on npm.')
  const info = await response.json()
  if (info.name !== packageName || typeof info.version !== 'string' || !versionPattern.test(info.version)) {
    throw new Error('The official npm registry did not return a valid Cline CLI version.')
  }
  if (info.optionalDependencies?.[nativePackage] !== info.version) {
    throw new Error('The latest Cline CLI version does not list a matching npm binary for this host platform.')
  }
  return info.version
}

export function managedEngine(dataDir) {
  const root = join(dataDir, 'engine')

  async function resolve() {
    if (process.env.EKKO_CLINE_EXECUTABLE?.trim()) return { engine: await findEngine(), source: 'external' }
    const release = await selectedRelease(root)
    if (release === null) return { source: 'managed' }
    if (release) return { engine: await targetRelease(join(root, release)), source: 'managed' }
    const external = await findEngine()
    return external ? { engine: external, source: 'external' } : { source: 'managed' }
  }

  async function status(signal) {
    try {
      signal.throwIfAborted()
      const { engine, source } = await resolve()
      if (!engine) return { installed: false, version: '', source: source === 'external' ? 'not-installed' : source }
      const version = await engineVersion(engine, childEnvironment(), signal)
      if (version) return { installed: true, version, source }
      return { installed: false, version: '', source, error: 'Could not confirm the Cline CLI version.' }
    } catch {
      signal.throwIfAborted()
      return { installed: false, version: '', source: 'error', error: 'Could not read or start Cline CLI.' }
    }
  }

  async function checkUpdate(run) {
    const current = await status(run.signal)
    if (current.source === 'external' || current.source === 'not-installed') {
      return { currentVersion: current.version, latestVersion: current.version, updateAvailable: false, message: externallyManaged }
    }
    const latest = await latestVersion(run.signal)
    return { currentVersion: current.version, latestVersion: latest, updateAvailable: latest !== current.version }
  }

  function upgrade(input, run) {
    return serialize(root, async () => {
      if (!versionPattern.test(input.version)) throw new Error('Choose a published Cline CLI version.')
      if ((await resolve()).source === 'external') throw new Error(externallyManaged)
      const current = await status(run.signal)
      if (current.version !== input.expectedVersion) throw new Error('Cline CLI version changed. Check updates again.')
      const previous = await selectedRelease(root)
      const { node, npm } = await npmRuntime(run.signal)
      await mkdir(root, { recursive: true, mode: 0o700 })
      const stage = await mkdtemp(join(root, 'release-'))
      let selected = false
      try {
        const env = childEnvironment(process.env, { nativeProvider: false })
        const npmrc = join(stage, '.studio-npmrc')
        const cache = join(stage, '.npm-cache')
        await writeFile(npmrc, '', { mode: 0o600 })
        run.progress({ message: 'Installing Cline CLI from npm', percent: 15 })
        try {
          await exec(node, [npm, 'install', '--prefix', stage, '--registry', registry,
            '--userconfig', npmrc, '--globalconfig', join(stage, '.studio-global-npmrc'), '--cache', cache,
            '--ignore-scripts', '--no-audit', '--no-fund', nativePackage + '@' + input.version],
          { cwd: stage, env, signal: run.signal, timeout: 105_000, windowsHide: true, maxBuffer: 512 * 1024 })
        } catch {
          run.signal.throwIfAborted()
          throw new Error('npm could not install the official Cline CLI package.')
        }
        run.progress({ message: 'Verifying the Cline native binary', percent: 85 })
        const engine = await targetRelease(stage)
        if (!engine) throw new Error('npm did not install a Cline binary for this host platform.')
        const version = await engineVersion(engine, env, run.signal)
        if (version !== input.version) throw new Error('The installed Cline version did not match the requested version.')
        await cleanup(cache)
        run.signal.throwIfAborted()
        await selectRelease(root, stage.slice(root.length + 1))
        selected = true
        if (previous) await cleanup(join(root, previous)).catch(() => {})
        return { installedVersion: version }
      } finally {
        if (!selected) await cleanup(stage).catch(() => {})
      }
    })
  }

  function remove(run) {
    return serialize(root, async () => {
      if ((await resolve()).source === 'external') throw new Error(externallyManaged)
      const release = await selectedRelease(root)
      if (!release) return
      run.signal.throwIfAborted()
      await selectRelease(root, null)
      await cleanup(join(root, release))
    })
  }

  return { resolve, status, checkUpdate, upgrade, remove }
}
