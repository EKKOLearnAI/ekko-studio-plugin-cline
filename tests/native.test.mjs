import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../server.mjs'

const native = process.env.EKKO_CLINE_NATIVE_TEST_CLI
const owner = { userId: 1, profile: 'default', agentId: 'plugin:cline/cline' }
const lifecycle = { add() {} }
const attachmentText = 'cline-native-test-file-content'
const commandProof = 'cline-terminal-proof.txt'
const commandText = 'cline-native-terminal-proof'
const command = { commands: ['echo ' + commandText + ' > ' + commandProof] }

function respond(res, model, block, delta, stopReason) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const send = (type, value) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...value }) + '\n\n')
  send('message_start', { message: {
    id: 'msg_fixture', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 30, output_tokens: 0, cache_creation_input_tokens: 4, cache_read_input_tokens: 6 },
  } })
  send('content_block_start', { index: 0, content_block: block })
  send('content_block_delta', { index: 0, delta })
  send('content_block_stop', { index: 0 })
  send('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 12 } })
  send('message_stop', {})
  res.end()
}

test('official Cline routes concurrent model choices and honors Studio allow and deny against a loopback model', {
  skip: !native && 'Set EKKO_CLINE_NATIVE_TEST_CLI to the official Cline binary.',
  timeout: 40_000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-cline-native-'))
  const config = join(root, 'config')
  const providerFile = join(config, 'data', 'settings', 'providers.json')
  await mkdir(join(config, 'data', 'settings'), { recursive: true })
  const callCounts = new Map()
  const results = new Map()
  const errors = []
  const modelServer = createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/messages')
      const chunks = await Array.fromAsync(req)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      const model = body.model
      const count = (callCounts.get(model) ?? 0) + 1
      callCounts.set(model, count)
      if (count === 1) {
        assert.ok(body.tools.some(tool => tool.name === 'run_commands'))
        respond(res, model, { type: 'tool_use', id: 'toolu_terminal', name: 'run_commands', input: {} },
          { type: 'input_json_delta', partial_json: JSON.stringify(command) }, 'tool_use')
      } else if (count === 2) {
        assert.ok(body.tools.some(tool => tool.name === 'read_files'))
        const messages = body.messages.flatMap(message => message.content)
          .map(content => typeof content === 'string' ? content : content.text ?? '').join('\n')
        const path = JSON.parse(messages.match(/Available at ("(?:[^"\\]|\\.)*")/)?.[1])
        respond(res, model, { type: 'tool_use', id: 'toolu_fixture', name: 'read_files', input: {} },
          { type: 'input_json_delta', partial_json: JSON.stringify({ files: [{ path }] }) }, 'tool_use')
      } else {
        const found = JSON.stringify(body.messages).includes(attachmentText)
        results.set(model, found)
        respond(res, model, { type: 'text', text: '' }, { type: 'text_delta', text: 'loopback ' + model }, 'end_turn')
      }
    } catch (error) {
      errors.push(error)
      res.writeHead(400).end('{}')
    }
  })
  await once(modelServer.listen(0, '127.0.0.1'), 'listening')
  const fakeKey = 'local-cline-test-only'
  const settings = JSON.stringify({ version: 1, lastUsedProvider: 'anthropic', providers: { anthropic: { updatedAt: new Date().toISOString(),
    settings: { provider: 'anthropic', apiKey: fakeKey, baseUrl: 'http://127.0.0.1:' + modelServer.address().port + '/v1' },
  } } })
  const environment = { EKKO_CLINE_CONFIG_DIR: config, EKKO_CLINE_EXECUTABLE: native, CLINE_PROVIDER: 'anthropic',
    CLINE_API_KEY: fakeKey, CLINE_MODEL: '', DO_NOT_TRACK: '1' }
  const initial = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]))
  Object.assign(process.env, environment)
  t.after(async () => {
    for (const [key, value] of Object.entries(initial)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    modelServer.closeAllConnections()
    await new Promise(resolve => modelServer.close(resolve))
    await rm(root, { recursive: true, force: true })
  })
  await writeFile(providerFile, settings, { mode: 0o600 })

  let agent
  apply({ identity: owner, paths: { dataDir: root }, extensions: {
    agents: { register(value) { agent = value; return { dispose() {} } } },
    rpc: { register() { return () => {} } },
  } })
  const signal = AbortSignal.timeout(30_000)
  const catalog = await agent.modes.global.listModels({ identity: owner, signal, lifecycle })
  assert.equal(catalog.status, 'ready')
  const picks = catalog.models.filter(model => !model.isDefault).slice(0, 2).map(model => model.id)
  assert.equal(picks.length, 2)
  const approvals = [[], []]
  const answers = await Promise.all(picks.map(async (model, index) => {
    const workspaceDir = join(root, 'workspace-' + index)
    const runtimeDir = join(root, 'runtime-' + index)
    await mkdir(workspaceDir)
    const ctx = {
      identity: { ...owner, sessionId: 'session-' + index, runId: 'run-' + index }, lifecycle,
      model: { model }, mode: 'global', paths: { workspaceDir, runtimeDir }, signal, deadlineAt: Date.now() + 25_000,
      output: { async emit() {} },
      interactions: { async approve(tool) { approvals[index].push(tool); return { outcome: index === 0 ? 'approved' : 'denied' } } },
      attachments: {
        async resolve() { return { name: 'content.txt', mediaType: 'text/plain', size: attachmentText.length } },
        async read() { return Buffer.from(attachmentText) },
      },
    }
    const answer = await agent.runtime.createSession(ctx).run({
      input: [{ type: 'text', text: 'Read the attachment and reply.' }, { type: 'file', assetId: 'attachment' }],
      history: [], instructions: [], options: {},
    }, ctx)
    assert.equal((await readFile(join(workspaceDir, commandProof), 'utf8')).trim(), commandText)
    assert.deepEqual(await readdir(runtimeDir), [])
    assert.deepEqual(answer.usage, { inputTokens: 102, outputTokens: 36, cacheReadTokens: 18, isEstimated: false })
    return answer.content[0].text
  }))
  assert.deepEqual(errors, [])
  assert.deepEqual(answers, picks.map(model => 'loopback ' + model))
  assert.deepEqual(picks.map(model => callCounts.get(model)), [3, 3])
  assert.deepEqual(approvals.map(list => list.length), [1, 1])
  assert.deepEqual(picks.map(model => results.get(model)), [true, false])
  assert.equal(await readFile(providerFile, 'utf8'), settings)
})

test('official Cline uses the selected Studio model and token for each concurrent scoped turn', {
  skip: !native && 'Set EKKO_CLINE_NATIVE_TEST_CLI to the official Cline binary.',
  timeout: 35_000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-cline-scoped-'))
  const picks = ['example/first-studio-model', 'other/second-studio-model']
  const requests = []
  const modelServer = createServer(async (req, res) => {
    const body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString())
    const first = !requests.some(request => request.model === body.model)
    requests.push({ path: req.url, model: body.model, auth: req.headers.authorization })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const delta = first ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call_terminal', type: 'function',
      function: { name: 'run_commands', arguments: JSON.stringify(command) } }] } : { role: 'assistant', content: 'scoped ' + body.model }
    for (const choice of [{ index: 0, delta, finish_reason: null }, { index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }]) {
      const chunk = { id: 'chatcmpl_scope', object: 'chat.completion.chunk', created: 0, model: body.model, choices: [choice] }
      res.write('data: ' + JSON.stringify(chunk) + '\n\n')
    }
    res.end('data: [DONE]\n\n')
  })
  await once(modelServer.listen(0, '127.0.0.1'), 'listening')
  const environment = {
    EKKO_CLINE_EXECUTABLE: native, EKKO_CLINE_CONFIG_DIR: 'invalid-global-config',
    CLINE_PROVIDER: 'other-provider', CLINE_API_KEY: 'dummy-global-key', CLINE_MODEL: 'native-default',
  }
  const initial = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]))
  Object.assign(process.env, environment)
  t.after(async () => {
    for (const [key, value] of Object.entries(initial)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    modelServer.closeAllConnections()
    await new Promise(resolve => modelServer.close(resolve))
    await rm(root, { recursive: true, force: true })
  })

  let agent
  apply({ identity: owner, paths: { dataDir: root }, extensions: {
    agents: { register(value) { agent = value; return { dispose() {} } } },
    rpc: { register() { return () => {} } },
  } })
  assert.deepEqual(agent.modes.scoped.protocols, ['chat_completions'])
  const signal = AbortSignal.timeout(25_000)
  const answers = await Promise.all(picks.map(async (model, index) => {
    const workspaceDir = join(root, 'workspace-' + index)
    const runtimeDir = join(root, 'runtime-' + index)
    await mkdir(workspaceDir)
    const events = []
    const ctx = { identity: { ...owner, userId: 2 + index, profile: 'scoped', sessionId: 'session-' + index, runId: 'run-' + index },
      lifecycle, mode: 'scoped', paths: { workspaceDir, runtimeDir }, signal, deadlineAt: Date.now() + 20_000,
      model: { model, provider: 'studio-fixture', apiMode: 'chat_completions', baseUrl: 'http://127.0.0.1:' + modelServer.address().port + '/studio/v1',
        token: 'leased-studio-token-' + index, contextWindow: 100000, outputLimit: 4096 },
      output: { async emit(event) { events.push(event) } },
      interactions: { async approve() { throw new Error('Unexpected Studio approval') } },
    }
    const answer = await agent.runtime.createSession(ctx).run({
      input: [{ type: 'text', text: 'Send a short response.' }], history: [], instructions: [], options: {},
    }, ctx)
    assert.equal((await readFile(join(workspaceDir, commandProof), 'utf8')).trim(), commandText)
    assert.equal(events.filter(event => event.type === 'text.delta').map(event => event.text).join(''), answer.content[0].text)
    assert.deepEqual(await readdir(runtimeDir), [])
    return answer.content[0].text
  }))
  assert.deepEqual(answers, picks.map(model => 'scoped ' + model))
  assert.deepEqual(requests.sort((left, right) => left.model.localeCompare(right.model)), picks.flatMap((model, index) => [0, 1].map(() => ({
    path: '/studio/v1/chat/completions', model, auth: 'Bearer leased-studio-token-' + index,
  }))))
})
