import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { Acp, AcpError } from './acp.mjs'
import { childEnvironment, configArgs, engineVersion, findEngine } from './engine.mjs'
import manifest from './plugin.json' with { type: 'json' }

const guide = 'https://cline.bot/cli'
const signIn = 'Run cline auth on the Studio host with the configured Cline directory, then refresh the model list.'
const unavailable = 'Install Cline CLI on the Studio host or set EKKO_CLINE_EXECUTABLE.'
const ownerOnly = 'Cline native credentials are available only to the Studio account and Profile that enabled the plugin.'
const stopReasons = { end_turn: 'stop', refusal: 'stop', max_tokens: 'length', max_turn_requests: 'tool_limit' }
const toolKinds = new Set(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other'])
const cancelled = { outcome: { outcome: 'cancelled' } }
const text = value => ({ type: 'text', text: value })
const validId = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 512
const sameOwner = (left, right) => left.userId === right.userId && left.profile === right.profile

function setupAcp(engine, cwd, onFrame) {
  const args = [...engine.prefix, '--acp', '--auto-approve', 'false', ...configArgs()]
  return new Acp(engine.command, args, { cwd, env: childEnvironment() }, onFrame)
}

async function startSession(acp, cwd, mcpServers, signal) {
  const hello = await acp.request('initialize', {
    protocolVersion: 1,
    clientInfo: { name: 'ekko-studio-cline', version: manifest.version },
    clientCapabilities: {},
  }, signal)
  if (hello?.protocolVersion !== 1 || hello.agentInfo?.name !== 'cline') throw new Error('The executable must provide Cline ACP v1.')
  const controls = await acp.request('session/new', {
    cwd, mcpServers: acpServers(mcpServers, hello.agentCapabilities?.mcpCapabilities),
  }, signal)
  if (!validId(controls?.sessionId)) throw new Error('Cline did not return a valid ACP session ID.')
  if (control(controls, 'auto_approve') !== false) throw new Error('Cline did not confirm that tool auto-approval is disabled.')
  return controls
}

function acpServers(servers, capabilities) {
  const pairs = values => Object.entries(values ?? {}).map(([name, value]) => ({ name, value: String(value) }))
  return Object.entries(servers).map(([name, server]) => {
    if (typeof server.command === 'string' && server.command) {
      return { name, command: server.command, args: server.args ?? [], env: pairs(server.env) }
    }
    const type = server.type ?? 'http'
    if (!['sse', 'http'].includes(type) || !capabilities?.[type] || typeof server.url !== 'string') {
      throw new Error('Cline did not advertise support for a required Studio MCP transport.')
    }
    return { name, type, url: server.url, headers: pairs(server.headers) }
  })
}

function control(controls, id) {
  return controls?.configOptions?.find(option => option.id === id)?.currentValue
}

function modelsFrom(controls) {
  const provider = control(controls, 'provider')
  const current = control(controls, 'model') ?? controls.models?.currentModelId
  const models = new Map()
  for (const model of controls.models?.availableModels ?? []) {
    if (!validId(model?.modelId) || models.has(model.modelId)) continue
    models.set(model.modelId, {
      id: model.modelId, name: model.name || model.modelId,
      ...(validId(provider) ? { provider } : {}),
      ...(model.modelId === current ? { isDefault: true } : {}),
    })
  }
  return models
}

async function selectModel(acp, controls, model, signal) {
  if (!modelsFrom(controls).has(model)) throw new Error('The selected Cline model is unavailable in the active native provider.')
  const updated = await acp.request('session/set_config_option', {
    sessionId: controls.sessionId, configId: 'model', value: model,
  }, signal)
  if (control(updated, 'model') !== model || control(updated, 'provider') !== control(controls, 'provider')
    || control(updated, 'auto_approve') !== false) {
    throw new Error('Cline did not confirm the selected model and approval settings.')
  }
}

function catalog(status, message, models = []) {
  return { status, source: 'cline-acp', scope: 'available', models, ...(message ? { message } : {}) }
}

async function listModels(ctx, getEngine) {
  if (ctx.signal.aborted) throw ctx.signal.reason
  const deadline = AbortSignal.timeout(12_000)
  const signal = AbortSignal.any([ctx.signal, deadline])
  let acp
  try {
    const executable = await getEngine()
    if (!executable) return catalog('not_installed', unavailable)
    const cwd = await realpath(tmpdir())
    signal.throwIfAborted()
    acp = setupAcp(executable, cwd, ({ id }) => { if (id !== undefined) acp.methodNotFound(id) })
    ctx.lifecycle.add(() => acp.close())
    const controls = await startSession(acp, cwd, {}, signal)
    const models = [...modelsFrom(controls).values()]
    return models.length ? catalog('ready', undefined, models) : catalog('empty', 'The active Cline provider did not return any models.')
  } catch (error) {
    if (ctx.signal.aborted) throw ctx.signal.reason
    if (deadline.aborted) return catalog('timeout', 'Cline model discovery timed out.')
    if (error instanceof AcpError && error.code === -32000) return catalog('auth_required', signIn)
    return catalog('error', 'Could not load models from the Cline CLI. Check the executable and native configuration.')
  } finally {
    await acp?.close()
  }
}

function scrub(value, secret) {
  let result = (typeof value === 'string' ? value : '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  if (secret) result = result.replaceAll(secret, '[redacted]')
  return result
    .replace(/\bBearer\s+[^\s"'\\,;]+/gi, 'Bearer [redacted]')
    .replace(/((?:[\w-]*(?:api[-_ ]?key|token|secret|password)|authorization)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"'\\,;]+)/gi, '$1[redacted]')
    .slice(0, 4096)
}

async function requestPermission(params, run, signal) {
  const tool = params.toolCall
  const options = Array.isArray(params.options) ? params.options.filter(option => validId(option?.optionId)) : []
  const allow = options.filter(option => option.kind === 'allow_once')
  const reject = options.find(option => option.kind === 'reject_once')
  if (!validId(tool?.toolCallId) || allow.length !== 1 || new Set(options.map(option => option.optionId)).size !== options.length || signal.aborted) return cancelled
  const secret = process.env.CLINE_API_KEY
  const title = scrub(tool.title, secret) || 'Cline tool request'
  const raw = tool.rawInput
  const details = scrub(typeof raw === 'string' ? raw : raw?.command ?? raw?.path ?? raw?.filePath, secret) || title
  try {
    const decision = await run.interactions.approve({ operationId: tool.toolCallId, title, details })
    if (signal.aborted) return cancelled
    const choice = decision.outcome === 'approved' ? allow[0] : decision.outcome === 'denied' ? reject : undefined
    if (choice) return { outcome: { outcome: 'selected', optionId: choice.optionId } }
  } catch {
    // Without a valid Studio answer the tool stays blocked.
  }
  return cancelled
}

function streamTurn(run) {
  let answer = ''
  const tools = new Set()
  return {
    get answer() { return answer },
    async update(update) {
      const { sessionUpdate, content, toolCallId, status, kind } = update ?? {}
      if (content?.type === 'text' && typeof content.text === 'string') {
        if (sessionUpdate === 'agent_message_chunk') {
          answer += content.text
          await run.output.emit({ type: 'text.delta', text: content.text })
        } else if (sessionUpdate === 'agent_thought_chunk') {
          await run.output.emit({ type: 'reasoning.summary.delta', text: content.text })
        }
      }
      if (!['tool_call', 'tool_call_update'].includes(sessionUpdate) || !validId(toolCallId)) return
      if (sessionUpdate === 'tool_call' && !tools.has(toolCallId)) {
        tools.add(toolCallId)
        await run.output.emit({ type: 'tool.started', callId: toolCallId, name: toolKinds.has(kind) ? kind : 'Cline tool', input: {} })
      }
      if (!['completed', 'failed'].includes(status) || !tools.delete(toolCallId)) return
      await run.output.emit(status === 'completed'
        ? { type: 'tool.completed', callId: toolCallId, result: null }
        : { type: 'tool.failed', callId: toolCallId, error: 'Cline tool failed or was denied.' })
    },
    async finish() {
      for (const callId of tools) {
        await run.output.emit({ type: 'tool.failed', callId, error: 'Cline ended the turn without a tool result.' })
      }
    },
  }
}

function prepareAttachments(run, signal) {
  const files = new Map()
  const limit = 32 * 1024 * 1024
  let total = 0
  let directory
  return {
    async block(part) {
      signal.throwIfAborted()
      if (part.type === 'text') return part
      if (files.has(part.assetId)) return files.get(part.assetId)
      const asset = await run.attachments.resolve(part.assetId)
      if (files.size >= 32 || asset.size > limit - total) throw new Error('Cline accepts up to 32 attachments and 32 MiB per turn.')
      const bytes = await run.attachments.read(part.assetId)
      signal.throwIfAborted()
      total += bytes.byteLength
      if (total > limit) throw new Error('Cline accepts up to 32 MiB of attachments per turn.')
      if (!directory) {
        await mkdir(run.paths.runtimeDir, { recursive: true, mode: 0o700 })
        directory = await mkdtemp(join(run.paths.runtimeDir, 'cline-input-'))
      }
      const ext = extname(asset.name).toLowerCase()
      const path = join(directory, 'asset-' + (files.size + 1) + (/^\.[a-z\d]{1,12}$/.test(ext) ? ext : ''))
      await writeFile(path, bytes, { mode: 0o600, flag: 'wx', signal })
      const block = text('Studio attachment ' + JSON.stringify(asset.name) + ' (' + JSON.stringify(asset.mediaType)
        + '). Available at ' + JSON.stringify(path) + '. Use your file-reading tool to inspect its contents when relevant.')
      files.set(part.assetId, block)
      return block
    },
    async dispose() {
      if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 3 })
    },
  }
}

async function buildPrompt(input, attachments) {
  const prompt = input.instructions.map(item => text('[' + item.kind + ']\n' + item.text))
  for (const message of input.history) {
    prompt.push(text('Previous Studio ' + message.role + ' message:'))
    for (const part of message.content) prompt.push(await attachments.block(part))
  }
  if (input.history.length) prompt.push(text('Current Studio request:'))
  for (const part of input.input) prompt.push(await attachments.block(part))
  return prompt
}

async function executeTurn(input, run, getEngine, signal) {
  const executable = await getEngine()
  if (!executable) throw new Error(unavailable)
  const cwd = await realpath(run.paths.workspaceDir)
  const attachments = prepareAttachments(run, signal)
  const turn = streamTurn(run)
  const finishing = new AbortController()
  const currentSignal = AbortSignal.any([signal, finishing.signal])
  const interrupted = Promise.withResolvers()
  let acp
  let currentSession
  let updates = Promise.resolve()
  let streamError

  function abort() {
    interrupted.resolve()
    if (currentSession) acp.notify('session/cancel', { sessionId: currentSession })
    void acp?.close({ cancel: Boolean(currentSession) })
  }
  try {
    signal.throwIfAborted()
    const prompt = await buildPrompt(input, attachments)
    signal.throwIfAborted()
    acp = setupAcp(executable, cwd, ({ id, method, params }) => {
      const current = currentSession && params?.sessionId === currentSession && !currentSignal.aborted
      if (id !== undefined) {
        if (method !== 'session/request_permission') acp.methodNotFound(id)
        else if (!current) acp.respond(id, cancelled)
        else {
          void requestPermission(params, run, currentSignal)
            .then(result => acp.respond(id, currentSignal.aborted ? cancelled : result))
            .catch(() => {})
        }
      } else if (current && method === 'session/update') {
        updates = updates.then(async () => {
          if (!currentSignal.aborted && !streamError) await turn.update(params.update)
        }).catch(error => { streamError = error })
      }
    })
    signal.addEventListener('abort', abort, { once: true })
    run.lifecycle.add(() => acp.close())
    const startup = AbortSignal.any([signal, AbortSignal.timeout(20_000)])
    const controls = await startSession(acp, cwd, run.mcpServers ?? {}, startup)
    if (run.model?.model) await selectModel(acp, controls, run.model.model, startup)
    else if (!modelsFrom(controls).has(control(controls, 'model') ?? controls.models?.currentModelId)) {
      throw new Error('Select a model from the active Cline provider before starting a turn.')
    }
    currentSession = controls.sessionId
    const result = await acp.request('session/prompt', { sessionId: currentSession, prompt }, signal)
    currentSession = undefined
    await Promise.race([updates, interrupted.promise])
    signal.throwIfAborted()
    if (streamError) throw streamError
    await Promise.race([turn.finish(), interrupted.promise])
    signal.throwIfAborted()
    if (result?.stopReason === 'cancelled') throw new Error('Cline cancelled the prompt.')
    if (!Object.hasOwn(stopReasons, result?.stopReason)) throw new Error('Cline returned an unsupported stop reason.')
    return { content: [text(turn.answer)], finishReason: stopReasons[result.stopReason] }
  } catch (error) {
    if (error instanceof AcpError && error.code === -32000) throw new Error(signIn)
    if (error instanceof AcpError) throw new Error('Cline rejected an ACP request. Check the selected provider, model and native configuration.')
    if (!signal.aborted && error?.name === 'TimeoutError') throw new Error('Cline ACP startup timed out.')
    throw error
  } finally {
    finishing.abort()
    signal.removeEventListener('abort', abort)
    try { await acp?.close() }
    finally { await attachments.dispose() }
  }
}

function createSession(owner, session, getEngine) {
  if (session.mode !== 'global' || !sameOwner(owner, session.identity)) throw new Error(ownerOnly)
  const disposed = new AbortController()
  let active
  return {
    async run(input, run) {
      if (!sameOwner(session.identity, run.identity) || session.identity.sessionId !== run.identity.sessionId
        || session.identity.agentId !== run.identity.agentId || run.mode !== session.mode) throw new Error(ownerOnly)
      if (active) throw new Error('Cline is already running in this Studio session.')
      if (run.model?.reasoningEffort) throw new Error('Use the Cline native model configuration for reasoning settings.')
      const remaining = run.deadlineAt - Date.now()
      if (remaining <= 0) throw new Error('Cline turn timed out.')
      const deadline = AbortSignal.timeout(remaining)
      const signal = AbortSignal.any([session.signal, run.signal, disposed.signal, deadline])
      signal.throwIfAborted()
      active = executeTurn(input, run, getEngine, signal)
      try {
        return await active
      } catch (error) {
        if (signal.aborted) throw new Error(deadline.aborted ? 'Cline turn timed out.' : 'Cline turn cancelled.')
        throw error
      } finally {
        active = undefined
      }
    },
    async dispose() {
      disposed.abort()
      await active?.catch(() => {})
    },
  }
}

export function apply(ctx) {
  const owner = { userId: ctx.identity.userId, profile: ctx.identity.profile }
  const getEngine = () => findEngine()
  const registration = ctx.extensions.agents.register({
    id: 'cline', name: 'Cline CLI', vendor: 'Cline', description: manifest.description,
    agentApiVersion: 1,
    async getStatus(run) {
      try {
        const executable = await getEngine()
        if (!executable) return { installed: false, version: '', source: 'not-installed' }
        const version = await engineVersion(executable, childEnvironment(), run.signal)
        if (version) return { installed: true, version, source: 'external' }
        return { installed: false, version: '', source: 'not-installed', error: 'Cline CLI returned an invalid version.' }
      } catch {
        run.signal.throwIfAborted()
        return { installed: false, version: '', source: 'not-installed', error: 'Could not start Cline CLI. Check the executable on the Studio host.' }
      }
    },
    management: { installGuideUrl: guide },
    modes: {
      global: { listModels: run => sameOwner(owner, run.identity) ? listModels(run, getEngine) : catalog('auth_required', ownerOnly) },
    },
    features: { surfaces: ['chat'], streaming: true, resume: false },
    runtime: { createSession: session => createSession(owner, session, getEngine) },
  })
  return () => registration.dispose()
}
