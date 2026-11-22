import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { apply } from '../server.mjs'

const fixture = fileURLToPath(new URL('./fixtures/cline-acp.mjs', import.meta.url))
const lifecycle = { add() {} }
const owner = { userId: 1, profile: 'default', agentId: 'plugin:cline/cline' }
const input = { input: [{ type: 'text', text: 'inspect this' }], history: [], instructions: [], options: {} }

function agent(root, captureRpc = () => {}) {
  let definition
  apply({ identity: owner, paths: { dataDir: root }, extensions: {
    agents: { register(value) { definition = value; return { dispose() {} } } },
    rpc: { register(name, handler) { captureRpc(name, handler); return () => {} } },
  } })
  return definition
}

async function useFixture(t, behavior, useEngine = fixture) {
  const root = await mkdtemp(join(tmpdir(), 'studio-cline-test-'))
  const keys = { EKKO_CLINE_EXECUTABLE: useEngine, EKKO_CLINE_CONFIG_DIR: join(root, 'config'), CLINE_MODEL: behavior }
  const original = Object.fromEntries(Object.keys(keys).map(name => [name, process.env[name]]))
  const set = (key, setting) => { if (setting === undefined) delete process.env[key]; else process.env[key] = setting }
  for (const [key, setting] of Object.entries(keys)) set(key, setting)
  t.after(async () => {
    for (const [key, setting] of Object.entries(original)) set(key, setting)
    await rm(root, { recursive: true, force: true })
  })
  return root
}

async function chat(definition, root, name, { model, decision, assets = {} } = {}) {
  const paths = { runtimeDir: join(root, 'runtime-' + name), workspaceDir: join(root, name) }
  await mkdir(paths.workspaceDir)
  const controller = new AbortController()
  const identity = { ...owner, sessionId: name, runId: 'run-' + name }
  const calls = [], events = []
  const ctx = { identity, paths, mode: 'global', model: model ? { model } : {}, lifecycle, signal: controller.signal,
    deadlineAt: Date.now() + 12_000, mcpServers: {},
    interactions: { async approve(call) { calls.push(call); return { outcome: decision ?? 'denied' } } },
    output: { async emit(event) { events.push(event) } },
    attachments: {
      async resolve(id) { return { ...assets[id], size: assets[id].bytes.length } },
      async read(id) { return assets[id].bytes },
    },
  }
  return { ctx, calls, events, controller, session: definition.runtime.createSession(ctx) }
}

test('reports the external status, native catalog and owner scope', async t => {
  const root = await useFixture(t)
  const definition = agent(root)
  const ctx = { identity: owner, signal: new AbortController().signal, lifecycle }
  assert.deepEqual(await definition.getStatus(ctx), { installed: true, source: 'external', version: '3.0.75' })
  const models = await definition.modes.global.listModels(ctx)
  assert.equal(models.status, 'ready')
  assert.deepEqual(models.models, [
    { id: 'model-a', name: 'MODEL-A', provider: 'fixture-provider', isDefault: true },
    { id: 'model-b', name: 'MODEL-B', provider: 'fixture-provider' },
  ])
  assert.equal((await definition.modes.global.listModels({ ...ctx, identity: { ...owner, profile: 'other' } })).status, 'auth_required')
  assert.throws(() => definition.runtime.createSession({ ...ctx, mode: 'global', identity: { ...owner, userId: 2 } }), /native credentials/)
})

test('offers the managed install action and exposes the login command only to the owner', async t => {
  const root = await useFixture(t)
  const engineDirectory = join(root, 'engine')
  await mkdir(engineDirectory)
  await writeFile(join(engineDirectory, 'current.json'), 'null')
  const rpc = new Map()
  const definition = agent(root, (name, handler) => rpc.set(name, handler))
  const ctx = { identity: owner, signal: new AbortController().signal }
  assert.deepEqual(definition.management.settings(ctx), { viewId: 'native-login' })
  assert.match((await rpc.get('native-login')(null, ctx)).command, /--config.*auth/)
  await assert.rejects(rpc.get('native-login')(null, { ...ctx, identity: { ...owner, userId: 2 } }), /native credentials/)

  delete process.env.EKKO_CLINE_EXECUTABLE
  const platform = process.platform === 'win32' ? 'windows' : process.platform
  const platformPackage = '@cline/cli-' + platform + '-' + process.arch
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url, 'https://registry.npmjs.org/cline/latest')
    return Response.json({ name: 'cline', version: '3.0.75', optionalDependencies: { [platformPackage]: '3.0.75' } })
  })
  assert.deepEqual(await definition.getStatus(ctx), { installed: false, version: '', source: 'managed' })
  assert.deepEqual(await definition.management.checkUpdate(ctx), { currentVersion: '', latestVersion: '3.0.75', updateAvailable: true })
  assert.equal(typeof definition.management.upgrade, 'function')
  assert.equal(typeof definition.management.remove, 'function')
  assert.equal(definition.management.installGuideUrl, undefined)
  assert.deepEqual(await rpc.get('native-login')(null, ctx), { command: '' })
})

test('isolates concurrent model choices, filters foreign events and asks for each tool', async t => {
  const root = await useFixture(t)
  const definition = agent(root)
  const first = await chat(definition, root, 'first', { model: 'model-b', decision: 'approved' })
  const second = await chat(definition, root, 'second', { model: 'model-a', decision: 'denied' })
  const results = await Promise.all([first, second].map(run => run.session.run(input, run.ctx)))
  assert.deepEqual(results.map(result => result.content[0].text), ['model-b:once', 'model-a:reject'])
  for (const run of [first, second]) {
    assert.deepEqual(run.calls.map(call => call.operationId), ['current'])
    assert.equal(run.calls[0].details, 'echo check')
    assert.deepEqual(run.events.filter(event => event.type === 'tool.started').map(event => event.callId), ['current'])
  }
  const third = await chat(definition, root, 'third', { decision: 'timeout' })
  const reply = await third.session.run(input, third.ctx)
  assert.equal(reply.content[0].text, 'model-a:cancelled')
})

test('passes attachment bytes to the engine and removes the private staging directory', async t => {
  const root = await useFixture(t, 'attach')
  const run = await chat(agent(root), root, 'attachments', { assets: {
    text: { name: 'file with spaces.txt', mediaType: 'text/plain', bytes: Buffer.from('file bytes') },
    image: { name: 'photo.png', mediaType: 'image/png', bytes: Buffer.from('image bytes') },
  } })
  const result = await run.session.run({ ...input, input: [
    ...input.input,
    { type: 'file', assetId: 'text' },
    { type: 'image', assetId: 'image' },
  ] }, run.ctx)
  assert.equal(result.content[0].text, 'file bytes|image bytesreject')
  assert.deepEqual(await readdir(run.ctx.paths.runtimeDir), [])
})

test('stops before prompting when the engine cannot confirm model or approval settings', async t => {
  const root = await useFixture(t, 'unsafe')
  const definition = agent(root)
  const unsafe = await chat(definition, root, 'unsafe')
  await assert.rejects(unsafe.session.run(input, unsafe.ctx), /auto-approval is disabled/)
  await assert.rejects(stat(join(unsafe.ctx.paths.workspaceDir, 'prompt-received')), { code: 'ENOENT' })
  process.env.CLINE_MODEL = 'mismatch'
  const mismatch = await chat(definition, root, 'mismatch', { model: 'model-b' })
  await assert.rejects(mismatch.session.run(input, mismatch.ctx), /did not confirm/)
  await assert.rejects(stat(join(mismatch.ctx.paths.workspaceDir, 'prompt-received')), { code: 'ENOENT' })
  process.env.CLINE_MODEL = 'auth'
  const catalog = await definition.modes.global.listModels(unsafe.ctx)
  assert.equal(catalog.status, 'auth_required')
  assert.match(catalog.message, /native login command/)
})

test('cancels the native prompt for the active Studio turn', async t => {
  const root = await useFixture(t, 'cancel')
  const run = await chat(agent(root), root, 'cancel')
  const pending = assert.rejects(run.session.run(input, run.ctx), /turn cancelled/)
  const promptFile = join(run.ctx.paths.workspaceDir, 'prompt-received')
  for (let retry = 0; retry < 200; retry++) {
    try { await stat(promptFile); break } catch (error) { if (error.code !== 'ENOENT') throw error }
    await delay(10)
  }
  await stat(promptFile)
  run.controller.abort()
  await pending
  assert.match(await readFile(join(run.ctx.paths.workspaceDir, 'cancel-received'), 'utf8'), /^fixture-/)
})
