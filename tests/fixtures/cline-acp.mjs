import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
if (args.includes('--version')) { console.log('3.0.75'); process.exit(0) }
if (args.slice(0, 3).join(' ') !== '--acp --auto-approve false') process.exit(2)

const work = process.cwd()
const behavior = process.env.CLINE_MODEL
const nativeId = 'fixture-' + process.pid
let model = 'model-a'
let promptId
const models = ['model-a', 'model-b'].map(modelId => ({ modelId, name: modelId.toUpperCase() }))
const controls = () => ({ configOptions: [
  { id: 'provider', currentValue: 'fixture-provider' },
  { id: 'model', currentValue: model },
  { id: 'auto_approve', currentValue: behavior === 'unsafe' },
] })
const send = frame => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n')
const respond = (id, result) => send({ id, result })
const update = (sessionId, value) => send({ method: 'session/update', params: { sessionId, update: value } })
const message = (sessionId, value) => update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } })

for await (const line of createInterface({ input: process.stdin })) {
  const { method, id, params, result } = JSON.parse(line)
  if (method === 'initialize') {
    respond(id, { protocolVersion: 1, agentInfo: { name: 'cline' } })
  } else if (method === 'session/new') {
    if (behavior === 'auth') send({ id, error: { code: -32000, message: 'An upstream credential must stay private.' } })
    else respond(id, { sessionId: nativeId, models: { availableModels: models, currentModelId: model }, ...controls() })
  } else if (method === 'session/set_config_option') {
    if (params.sessionId !== nativeId || params.configId !== 'model') process.exit(3)
    if (behavior !== 'mismatch') model = params.value
    respond(id, controls())
  } else if (method === 'session/prompt') {
    if (params.sessionId !== nativeId) process.exit(4)
    promptId = id
    await writeFile(join(work, 'prompt-received'), model)
    message('another-session', 'ignore me')
    if (behavior === 'attach') {
      const prompt = params.prompt.map(block => block.text).join('\n')
      const references = [...prompt.matchAll(/Available at ("(?:[^"\\]|\\.)*")/g)]
      const received = await Promise.all(references.map(match => readFile(JSON.parse(match[1]), 'utf8')))
      message(nativeId, received.join('|'))
    } else {
      message(nativeId, model + ':')
    }
    if (behavior === 'cancel') continue
    for (const name of ['foreign', 'current']) {
      const sessionId = name === 'current' ? nativeId : 'foreign'
      const shell = ['run_commands', 'Bash'].includes(behavior)
      const toolCall = { toolCallId: name, title: shell ? behavior + ': echo check' : 'Check known output',
        kind: 'execute', rawInput: { command: 'echo check' } }
      update(sessionId, { ...toolCall, sessionUpdate: 'tool_call', status: 'pending' })
      send({ id: name, method: 'session/request_permission', params: { sessionId, toolCall, options: [
        { kind: 'allow_always', optionId: 'always' },
        { kind: 'allow_once', optionId: 'once' },
        { kind: 'reject_once', optionId: 'reject' },
      ] } })
    }
  } else if (method === 'session/cancel') {
    await writeFile(join(work, 'cancel-received'), params.sessionId)
    respond(promptId, { stopReason: 'cancelled' })
  } else if (id === 'foreign') {
    if (result.outcome.outcome !== 'cancelled') process.exit(5)
  } else if (id === 'current') {
    const approved = result.outcome.optionId === 'once'
    update(nativeId, { sessionUpdate: 'tool_call_update', toolCallId: 'current', status: approved ? 'completed' : 'failed' })
    message(nativeId, result.outcome.optionId ?? result.outcome.outcome)
    respond(promptId, { stopReason: 'end_turn' })
  }
}
