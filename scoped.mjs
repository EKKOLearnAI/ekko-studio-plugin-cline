import { randomBytes } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { childEnvironment } from './engine.mjs'
import { nativeFiles } from './native-config.mjs'

export const scopedProtocols = ['chat_completions']
export const scopedProvider = 'ekko-studio'
const endpoint = '/chat/completions'

async function startProxy(model, signal) {
  const target = new URL(model.baseUrl)
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.search || target.hash
    || !model.token || !scopedProtocols.includes(model.apiMode)) {
    throw new Error('The Studio scoped model binding is invalid.')
  }
  target.pathname = target.pathname.replace(/\/+$/, '') + endpoint
  const key = randomBytes(24).toString('base64url')
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== 'Bearer ' + key) { response.writeHead(401).end(); return }
    if (request.method !== 'POST' || request.url !== '/v1' + endpoint) { response.writeHead(404).end(); return }

    const connection = new AbortController()
    const disconnect = () => connection.abort()
    response.once('close', disconnect)
    try {
      const reply = await fetch(target, {
        method: 'POST',
        body: Readable.toWeb(request),
        duplex: 'half',
        redirect: 'error',
        signal: AbortSignal.any([signal, connection.signal]),
        headers: { authorization: 'Bearer ' + model.token, 'content-type': 'application/json' },
      })
      if (!reply.ok) {
        await reply.body?.cancel()
        response.writeHead(reply.status, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: { message: 'Studio scoped model request failed.' } }))
        return
      }
      response.writeHead(reply.status, {
        'content-type': reply.headers.get('content-type') || 'application/json',
        'cache-control': 'no-store',
      })
      if (reply.body) await pipeline(Readable.fromWeb(reply.body), response)
      else response.end()
    } catch {
      if (!response.headersSent) response.writeHead(502).end('Studio scoped model request failed.')
      else response.destroy()
    } finally {
      response.off('close', disconnect)
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    key, baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1',
    dispose: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }),
  }
}

async function linkNativeResources(root, directory, settingsDir, signal) {
  const { skillDir, mcpFile } = nativeFiles(root)
  const inspect = path => lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error })
  const [skills, mcp] = await Promise.all([inspect(skillDir), inspect(mcpFile)])
  if (skills?.isDirectory()) await symlink(skillDir, join(directory, 'skills'), process.platform === 'win32' ? 'junction' : 'dir')
  if (mcp?.isFile() && mcp.size <= 1024 * 1024) {
    const bytes = await readFile(mcpFile, { signal })
    if (bytes.length <= 1024 * 1024) await writeFile(join(settingsDir, 'cline_mcp_settings.json'), bytes, { mode: 0o600, signal })
  }
}

export async function createScopedConfig(model, runtimeDir, signal, nativeRoot) {
  signal.throwIfAborted()
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(join(runtimeDir, 'cline-scoped-'))
  let proxy
  const dispose = async () => {
    try { await proxy?.dispose() }
    finally { await rm(directory, { recursive: true, force: true, maxRetries: 3 }) }
  }
  try {
    proxy = await startProxy(model, signal)
    const dataDir = join(directory, 'data')
    const settingsDir = join(dataDir, 'settings')
    await mkdir(settingsDir, { recursive: true, mode: 0o700 })
    const providerSettings = {
      provider: scopedProvider,
      model: model.model,
      protocol: 'openai-chat',
      client: 'openai-compatible',
      apiKey: proxy.key,
      baseUrl: proxy.baseUrl,
      capabilities: ['streaming', 'tools', 'vision'],
    }
    const modelInfo = {
      id: model.model,
      name: model.model,
      capabilities: ['tools', 'images'],
      ...(Number.isInteger(model.contextWindow) && model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}),
      ...(Number.isInteger(model.outputLimit) && model.outputLimit > 0 ? { maxTokens: model.outputLimit } : {}),
    }
    const state = { version: 1, lastUsedProvider: scopedProvider, providers: {
      [scopedProvider]: { settings: providerSettings, updatedAt: new Date().toISOString() },
    } }
    const registry = { version: 1, providers: {
      [scopedProvider]: {
        provider: { name: 'Ekko Studio', baseUrl: proxy.baseUrl, defaultModelId: model.model,
          protocol: providerSettings.protocol, client: providerSettings.client },
        models: { [model.model]: modelInfo },
      },
    } }
    await writeFile(join(settingsDir, 'providers.json'), JSON.stringify(state), { mode: 0o600, signal })
    await writeFile(join(settingsDir, 'models.json'), JSON.stringify(registry), { mode: 0o600, signal })
    if (nativeRoot) await linkNativeResources(nativeRoot, directory, settingsDir, signal)
    signal.throwIfAborted()
    return {
      args: ['--config', directory, '--data-dir', dataDir],
      env: {
        ...childEnvironment(process.env, { nativeProvider: false }),
        CLINE_PROVIDER: scopedProvider, CLINE_MODEL: model.model, CLINE_API_KEY: proxy.key, DO_NOT_TRACK: '1',
      },
      dispose,
    }
  } catch (error) {
    await dispose()
    throw error
  }
}
