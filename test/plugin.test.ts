import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, name } from '../index.js'
import { Config, GATE_MESSAGE, type AntigravityConfig } from '../src/domain/config.js'

const DEFAULTS = Config({} as AntigravityConfig)

/** The cordis surface `apply` touches; `registered` collects the adapter ids it registers. */
function fakeCtx(options: { credentials?: unknown; registered: string[]; logs: string[] }) {
  const runtime = { register: (adapter: { id: string }) => options.registered.push(adapter.id) }
  const scoped = {
    get: (service: string) => (service === 'agentRuntime' ? runtime : service === 'credentials' ? options.credentials : undefined),
    effect(run: () => unknown) {
      run()
    },
    on() {},
  }
  return {
    logger: () => ({ warn: (message: string) => options.logs.push(message) }),
    get: (service: string) => (service === 'credentials' ? options.credentials : undefined),
    inject(_names: string[], run: (scoped: unknown) => void) {
      run(scoped)
    },
  }
}

function run(overrides: Record<string, unknown>, credentials?: unknown) {
  const state = { credentials, registered: [] as string[], logs: [] as string[] }
  apply(fakeCtx(state), { ...DEFAULTS, ...overrides } as AntigravityConfig)
  return state
}

test('the plugin names the runtime it provides', () => {
  assert.equal(name, 'runtime-antigravity')
})

test('consumer oauth is not even a valid auth mode', () => {
  // Deliberately outside the type: the assertion is that the schema refuses it at load.
  assert.throws(
    () => Config({ auth: { mode: 'oauth-personal' } } as unknown as AntigravityConfig),
    /expected "gemini-api-key" \| "agent-platform"/,
  )
})

test('key auth without any key registers nothing and says why', () => {
  delete process.env['ANTIGRAVITY_TEST_MISSING_KEY']
  const state = run({ auth: { mode: 'gemini-api-key', apiKeyEnv: 'ANTIGRAVITY_TEST_MISSING_KEY' } })
  assert.deepEqual(state.registered, [])
  assert.deepEqual(state.logs, [GATE_MESSAGE])
})

test('a credential service or agent-platform registers the antigravity runtime', () => {
  const withCredentials = run({ auth: { mode: 'gemini-api-key', apiKeyEnv: 'ANTIGRAVITY_TEST_MISSING_KEY' } }, { readRecord: async () => undefined })
  assert.deepEqual(withCredentials.registered, ['antigravity'])
  const adc = run({ auth: { mode: 'agent-platform' } })
  assert.deepEqual(adc.registered, ['antigravity'])
  assert.deepEqual(adc.logs, [])
})
