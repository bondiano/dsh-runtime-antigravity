import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { Config, type AntigravityConfig } from '../src/domain/config.js'
import { AcpFailure } from '../lib/acp-rpc.js'
import { createAntigravityRuntime } from '../lib/adapter.js'
import { fakeAgent, type FakeAgent } from './fake-agent.js'

/** The resolved defaults; a case overrides whole values, which is what the harness passes too. */
const DEFAULTS = Config({} as AntigravityConfig)

const MODELS = [
  { id: 'model', category: 'model', type: 'select', currentValue: 'a', options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }] },
  { id: 'thought_level', category: 'thought_level', type: 'select', currentValue: 'low', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
]

/** Resolve pending promise continuations without a wall-clock wait. */
async function drain(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve()
}

function runtime(agent: FakeAgent, overrides: Record<string, unknown> = {}, deps: Record<string, unknown> = {}) {
  const spawned: { command: string; args: string[]; env?: NodeJS.ProcessEnv }[] = []
  const adapter = createAntigravityRuntime({
    config: { ...DEFAULTS, ...overrides } as AntigravityConfig,
    env: { GEMINI_API_KEY: 'from-env' },
    createRpc: options => {
      spawned.push(options)
      return agent
    },
    ...deps,
  })
  return { adapter, spawned }
}

test('create applies model and thinking level and keeps the agent cwd', async () => {
  const agent = fakeAgent({ configOptions: MODELS })
  const { adapter, spawned } = runtime(agent, { sandbox: true, addDirs: ['/abs/extra'] })
  assert.deepEqual(await adapter.create({ cwd: '/tmp/work', model: 'b', reasoningEffort: 'HIGH' }), { id: 's1', cwd: '/tmp/work' })
  assert.deepEqual(spawned[0]?.args, ['acp', '--add-dir', '/abs/extra', '--sandbox', '--process-per-session'])
  assert.deepEqual(agent.requests[0]?.params['clientCapabilities'], { fs: { readTextFile: true, writeTextFile: false } })
  const applied = agent.requests.filter(request => request.method === 'session/set_config_option').map(request => request.params)
  assert.deepEqual(applied, [
    { sessionId: 's1', configId: 'model', value: 'b' },
    { sessionId: 's1', configId: 'thought_level', value: 'high' },
  ])
  await adapter.dispose()
})

test('a setting the agent does not advertise is skipped, not faked', async () => {
  const agent = fakeAgent()
  const { adapter } = runtime(agent, { defaults: { model: 'b', thoughtLevel: 'high' } })
  await adapter.create({ cwd: '/tmp/work' })
  assert.equal(agent.requests.some(request => request.method === 'session/set_config_option'), false)
  await adapter.dispose()
})

test('session updates map to run events and the stop reason settles the turn', async () => {
  const agent = fakeAgent()
  agent.responses.set('session/prompt', () => {
    agent.update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'ignored' } })
    agent.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } })
    agent.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'because' } })
    agent.update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read a', kind: 'read', status: 'pending' })
    agent.update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' })
    agent.update({ sessionUpdate: 'usage_update', used: 10, size: 100 })
    agent.update({ sessionUpdate: 'plan', entries: [] })
    return { stopReason: 'end_turn' }
  })
  const { adapter } = runtime(agent)
  await adapter.create({ cwd: '/tmp/work' })
  const events: { type: string; status?: string; text?: string }[] = []
  for await (const event of adapter.send('s1', 'hi', { runId: 'r1' })) events.push(event)
  assert.deepEqual(events.map(event => event.type), ['text', 'reasoning', 'tool-call', 'tool-result', 'usage', 'provider', 'completed'])
  assert.equal(events[0]?.text, 'hello')
  assert.equal(events.at(-1)?.status, 'finished')
  assert.deepEqual(await adapter.getUsage('s1'), { sessionUpdate: 'usage_update', used: 10, size: 100 })
  await adapter.dispose()
})

test('a refusal is reported as refused, not as a failure', async () => {
  const agent = fakeAgent()
  agent.responses.set('session/prompt', () => ({ stopReason: 'refusal' }))
  const { adapter } = runtime(agent)
  await adapter.create({ cwd: '/tmp/work' })
  const events: { type: string; status?: string }[] = []
  for await (const event of adapter.send('s1', 'hi')) events.push(event)
  assert.deepEqual(events, [{ type: 'completed', status: 'refused' }])
  await adapter.dispose()
})

test('permission policy answers allow and reject without a human', async () => {
  const options = [
    { optionId: 'a1', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'r1', name: 'Reject', kind: 'reject_once' },
  ]
  async function ask(policy: 'allow' | 'reject') {
    const agent = fakeAgent()
    let outcome: unknown
    agent.responses.set('session/prompt', async () => {
      outcome = await agent.fromAgent('session/request_permission', { sessionId: 's1', toolCall: { title: 'Edit a' }, options })
      return { stopReason: 'end_turn' }
    })
    const { adapter } = runtime(agent, { permission: policy })
    await adapter.create({ cwd: '/tmp/work' })
    const events: { type: string }[] = []
    for await (const event of adapter.send('s1', 'hi')) events.push(event)
    await adapter.dispose()
    assert.deepEqual(events.map(event => event.type), ['completed'])
    return outcome
  }
  assert.deepEqual(await ask('allow'), { outcome: { outcome: 'selected', optionId: 'a1' } })
  assert.deepEqual(await ask('reject'), { outcome: { outcome: 'selected', optionId: 'r1' } })
})

test('an asking policy surfaces the request and answers it through respond', async () => {
  const options = [
    { optionId: 'a1', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'r1', name: 'Reject', kind: 'reject_once' },
  ]
  const agent = fakeAgent()
  let outcome: unknown
  agent.responses.set('session/prompt', async () => {
    outcome = await agent.fromAgent('session/request_permission', { sessionId: 's1', toolCall: { title: 'Edit a' }, options })
    return { stopReason: 'end_turn' }
  })
  const { adapter } = runtime(agent)
  await adapter.create({ cwd: '/tmp/work' })
  const events: { type: string; requestId?: string; options?: unknown }[] = []
  for await (const event of adapter.send('s1', 'hi', { runId: 'r1', policy: 'ask' })) {
    events.push(event)
    if (event.type === 'permission' && event.requestId !== undefined) {
      await assert.rejects(adapter.respond('s1', event.requestId, 'not-offered'), /was not offered/)
      await adapter.respond('s1', event.requestId, 'a1')
    }
  }
  assert.deepEqual(events.map(event => event.type), ['permission', 'completed'])
  assert.deepEqual(events[0]?.options, options)
  assert.deepEqual(outcome, { outcome: { outcome: 'selected', optionId: 'a1' } })
  await adapter.dispose()
})

test('an abort cancels the session and answers a pending permission as cancelled', async () => {
  const agent = fakeAgent()
  let outcome: unknown
  agent.responses.set('session/prompt', async () => {
    outcome = await agent.fromAgent('session/request_permission', {
      sessionId: 's1',
      options: [{ optionId: 'a1', name: 'Allow once', kind: 'allow_once' }],
    })
    return { stopReason: 'cancelled' }
  })
  const { adapter } = runtime(agent)
  await adapter.create({ cwd: '/tmp/work' })
  const controller = new AbortController()
  const events: { type: string }[] = []
  for await (const event of adapter.send('s1', 'hi', { runId: 'r1', signal: controller.signal, policy: 'ask' })) {
    events.push(event)
    if (event.type === 'permission') controller.abort()
  }
  await drain()
  assert.deepEqual(events.map(event => event.type), ['permission', 'cancelled'])
  assert.deepEqual(agent.notifications, [{ method: 'session/cancel', params: { sessionId: 's1' } }])
  assert.deepEqual(outcome, { outcome: { outcome: 'cancelled' } })
  await adapter.dispose()
})

test('onlyTools is refused because ACP has no session tool allowlist', async () => {
  const agent = fakeAgent()
  const { adapter, spawned } = runtime(agent)
  await assert.rejects(adapter.create({ cwd: '/tmp/work', onlyTools: ['Read'] }), /no session tool allowlist/)
  assert.equal(spawned.length, 0)
  await adapter.dispose()
})

test('resume reuses a live child, reconnects a dead one and refuses when unadvertised', async () => {
  const first = fakeAgent({ configOptions: MODELS })
  const second = fakeAgent({ configOptions: MODELS })
  const agents = [first, second]
  let spawns = 0
  const adapter = createAntigravityRuntime({
    config: { ...DEFAULTS } as AntigravityConfig,
    env: { GEMINI_API_KEY: 'from-env' },
    createRpc: () => agents[spawns++] as FakeAgent,
  })
  await adapter.create({ cwd: '/tmp/work' })
  assert.deepEqual(first.requests.map(request => request.method), ['initialize', 'session/new'])
  assert.deepEqual(await adapter.resume('s1', { cwd: '/tmp/work' }), { id: 's1', cwd: '/tmp/work' })
  assert.equal(spawns, 1)
  // A dead child is replaced, and the session is reconnected through session/resume.
  Object.assign(first, { error: new Error('the process exited') })
  await adapter.resume('s1', { cwd: '/tmp/work' })
  assert.equal(spawns, 2)
  assert.deepEqual(second.requests.map(request => request.method), ['initialize', 'session/resume'])
  await adapter.dispose()

  const plain = fakeAgent({ capabilities: {} })
  const { adapter: strict } = runtime(plain)
  await strict.create({ cwd: '/tmp/work' })
  assert.deepEqual(await strict.capabilities(), {
    resume: false,
    streaming: true,
    usage: true,
    cancel: true,
    permissions: true,
    fork: false,
    missions: false,
    settings: true,
  })
  await assert.rejects(strict.resume('s1', {}), /does not advertise session resume/)
  await strict.dispose()
})

test('the credential record wins over the environment and a missing key disposes the child', async () => {
  const agent = fakeAgent()
  const { adapter, spawned } = runtime(agent, {}, { getApiKey: async () => 'from-record' })
  await adapter.create({ cwd: '/tmp/work' })
  assert.equal(spawned[0]?.env?.['GEMINI_API_KEY'], 'from-record')
  await adapter.dispose()

  const bare = fakeAgent()
  const { adapter: keyless, spawned: spawnedBare } = runtime(bare, {}, { env: {}, getApiKey: async () => undefined })
  await assert.rejects(keyless.create({ cwd: '/tmp/work' }), /dsh-antigravity\/default/)
  assert.equal(spawnedBare.length, 0)
  await keyless.dispose()
})

test('a file read inside the workspace is served and outside it is refused', async () => {
  const directory = await mkdtemp('/tmp/agy-roots-')
  await writeFile(`${directory}/note.txt`, 'inside')
  const agent = fakeAgent()
  const { adapter } = runtime(agent)
  await adapter.create({ cwd: directory })
  assert.deepEqual(await agent.fromAgent('fs/read_text_file', { sessionId: 's1', path: `${directory}/note.txt` }), { content: 'inside' })
  await assert.rejects(agent.fromAgent('fs/read_text_file', { sessionId: 's1', path: '/etc/passwd' }), /outside the session workspace/)
  await assert.rejects(agent.fromAgent('terminal/create', { sessionId: 's1' }), AcpFailure)
  await adapter.dispose()
})

test('catalog reads the advertised model option from a throwaway session', async () => {
  const agent = fakeAgent({ configOptions: MODELS })
  const { adapter } = runtime(agent)
  assert.deepEqual(await adapter.catalog({ cwd: '/tmp/work' }), {
    models: [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ],
  })
  assert.equal(agent.disposals(), 1)

  const bare = fakeAgent()
  const { adapter: withoutModels } = runtime(bare)
  await assert.rejects(withoutModels.catalog({ cwd: '/tmp/work' }), /advertises no model option/)
  assert.equal(bare.disposals(), 1)
})
