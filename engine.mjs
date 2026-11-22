import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, readFile, realpath, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const allowed = /^(PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT|WINDIR|SYSTEMDRIVE|COMSPEC|PATHEXT|TEMP|TMP|TMPDIR|LANG|LC_[A-Z_]+|USER|LOGNAME|USERNAME|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|CLINE_PROVIDER|CLINE_API_KEY|CLINE_MODEL|DO_NOT_TRACK)$/i
const scriptEntry = /\.(?:cjs|mjs|js)$/i

function pathValue(source) {
  return Object.entries(source).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? ''
}

export function childEnvironment(source = process.env, { nativeProvider = true } = {}) {
  const env = Object.fromEntries(Object.entries(source).filter(([name]) =>
    allowed.test(name) && name.toUpperCase() !== 'PATH' && (nativeProvider || !/^CLINE_/i.test(name))))
  env.PATH = pathValue(source).split(delimiter).filter(isAbsolute).join(delimiter)
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
  return env
}

export function configArgs(source = process.env) {
  const dir = source.EKKO_CLINE_CONFIG_DIR?.trim()
  if (!dir) return []
  if (!isAbsolute(dir)) throw new Error('Set EKKO_CLINE_CONFIG_DIR to an absolute Cline configuration directory.')
  return ['--config', dir]
}

export function nativeConfigDir() {
  return configArgs()[1] ?? join(homedir(), '.cline')
}

export function loginCommand(engine) {
  if (!engine) return ''
  const args = [engine.command, ...engine.prefix, ...configArgs(), 'auth']
  if (process.platform === 'win32') return '& ' + args.map(arg => "'" + arg.replaceAll("'", "''") + "'").join(' ')
  return args.map(arg => "'" + arg.replaceAll("'", "'\"'\"'") + "'").join(' ')
}

async function accessible(file) {
  try {
    await access(file, process.platform === 'win32' || scriptEntry.test(file) ? constants.R_OK : constants.X_OK)
    if ((await stat(file)).isFile()) return await realpath(file)
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw error
  }
}

async function resolveNative(entry) {
  // Bypass the npm wrapper so cancellation and exit target the actual ACP process.
  const landed = await accessible(entry)
  if (!landed || basename(landed) !== 'cline' || basename(dirname(landed)) !== 'bin') return landed
  const metadata = await readFile(join(dirname(landed), '..', 'package.json'), 'utf8').then(JSON.parse, () => null)
  if (metadata?.name !== 'cline') return landed
  const cached = await accessible(join(dirname(landed), '.cline'))
  if (cached) return cached
  const packageName = '@cline/cli-' + process.platform + '-' + process.arch
  try {
    const require = createRequire(landed)
    return await accessible(require.resolve(packageName + '/bin/cline'))
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND' && error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error
  }
}

export async function findEngine(source = process.env) {
  const override = source.EKKO_CLINE_EXECUTABLE?.trim()
  const windows = process.platform === 'win32'
  if (override) {
    if (!isAbsolute(override) || windows && !override.toLowerCase().endsWith('.exe') && !scriptEntry.test(override)) {
      throw new Error('Set EKKO_CLINE_EXECUTABLE to an absolute Cline binary or JavaScript entry path.')
    }
    const entry = await resolveNative(override)
    if (!entry) return
    return scriptEntry.test(override) ? { command: process.execPath, prefix: [entry] } : { command: entry, prefix: [] }
  }

  const directories = pathValue(source).split(delimiter).filter(isAbsolute)
  directories.push(join(homedir(), '.local', 'bin'))
  if (windows && isAbsolute(source.APPDATA ?? '')) directories.push(join(source.APPDATA, 'npm'))
  const nativeName = windows ? 'cline.exe' : 'cline'
  for (const directory of new Set(directories)) {
    const entries = [join(directory, nativeName)]
    if (windows) {
      const packageName = 'cli-windows-' + process.arch
      entries.push(
        join(directory, 'node_modules', '@cline', packageName, 'bin', nativeName),
        join(directory, 'node_modules', 'cline', 'node_modules', '@cline', packageName, 'bin', nativeName),
      )
    }
    for (const entry of entries) {
      const executable = await resolveNative(entry)
      if (executable) return { command: executable, prefix: [] }
    }
  }
}

export async function engineVersion(engine, env, signal) {
  const { stdout } = await exec(engine.command, [...engine.prefix, '--version'], {
    windowsHide: true, env, signal, timeout: 5_000, maxBuffer: 4096,
  })
  return stdout.trim().match(/^v?(\d+\.\d+\.\d+(?:-[\w.-]+)?)$/)?.[1] ?? ''
}
