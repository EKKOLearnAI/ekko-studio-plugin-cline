import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { nativeConfiguration, nativeFiles } from '../native-config.mjs'

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'cline-config-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, files: nativeFiles(root), config: nativeConfiguration(root) }
}

test('edits Cline Skill frontmatter and toggles SKILL.md without affecting companion files', async t => {
  const { config, files } = await setup(t)
  const name = 'release-notes'
  const folder = join(files.skillDir, name)
  const skill = join(folder, 'SKILL.md')
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'example.md'), 'companion')
  await writeFile(skill, '---\nname: release-notes\ndescription: Draft notes\nlicense: MIT\n---\n\nBody\n')
  const original = await config.getSkill({ name })
  await config.editSkill({ name, description: 'Prepare notes', content: 'Updated body', enabled: false, revision: original.revision })
  assert.match(await readFile(skill + '.studio-disabled', 'utf8'), /license: MIT/)
  assert.deepEqual((await config.listSkills()).items, [{ name, description: 'Prepare notes', enabled: false, readOnly: false }])
  await assert.rejects(config.removeSkill({ name, revision: original.revision }), /configuration changed/)
  await config.removeSkill({ name, revision: (await config.getSkill({ name })).revision })
  assert.equal(await readFile(join(folder, 'example.md'), 'utf8'), 'companion')
})

test('preserves native Cline MCP transport, OAuth and provider credentials through edits', async t => {
  const { config, files } = await setup(t)
  await mkdir(dirname(files.mcpFile), { recursive: true })
  await writeFile(files.mcpFile, JSON.stringify({ mcpServers: { remote: {
    transport: { type: 'streamableHttp', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer private' } },
    oauth: { accessToken: 'private-oauth' },
  } }, other: 1 }))
  const entry = (await config.listMcp()).items[0]
  assert.doesNotMatch(JSON.stringify(entry), /private/)
  await config.saveMcp({ ...entry, enabled: false })
  const saved = JSON.parse(await readFile(files.mcpFile, 'utf8'))
  assert.equal(saved.mcpServers.remote.disabled, true)
  assert.equal(saved.mcpServers.remote.transport.headers.Authorization, 'Bearer private')
  assert.equal(saved.mcpServers.remote.oauth.accessToken, 'private-oauth')
  assert.equal(saved.other, 1)
  await assert.rejects(config.removeMcp(entry), /configuration changed/)

  const providers = { version: 1, providers: { example: { settings: { provider: 'example', apiKey: 'private-model' } } } }
  await writeFile(files.providersFile, JSON.stringify(providers))
  const editor = await config.getSettingsEditor()
  assert.doesNotMatch(JSON.stringify(editor), /private-model/)
  await config.saveSettingsEditor({ revision: editor.revision, models: editor.models, config: { sample: true } })
  assert.equal(JSON.parse(await readFile(files.providersFile, 'utf8')).providers.example.settings.apiKey, 'private-model')
  assert.deepEqual(JSON.parse(await readFile(files.stateFile, 'utf8')), { sample: true })
  await assert.rejects(config.saveSettingsEditor({ revision: editor.revision, models: editor.models, config: {} }), /configuration changed/)
})
