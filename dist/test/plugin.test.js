import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, name } from '../index.js';
import { Config, GATE_MESSAGE } from '../src/domain/config.js';
const DEFAULTS = Config({});
/** The cordis surface `apply` touches; `registered` collects the adapter ids it registers. */
function fakeCtx(options) {
    const runtime = { register: (adapter) => options.registered.push(adapter.id) };
    const scoped = {
        get: (service) => (service === 'agentRuntime' ? runtime : service === 'credentials' ? options.credentials : undefined),
        effect(run) {
            run();
        },
        on() { },
    };
    return {
        logger: () => ({ warn: (message) => options.logs.push(message) }),
        get: (service) => (service === 'credentials' ? options.credentials : undefined),
        inject(_names, run) {
            run(scoped);
        },
    };
}
function run(overrides, credentials) {
    const state = { credentials, registered: [], logs: [] };
    apply(fakeCtx(state), { ...DEFAULTS, ...overrides });
    return state;
}
test('the plugin names the runtime it provides', () => {
    assert.equal(name, 'runtime-antigravity');
});
test('consumer oauth is not even a valid auth mode', () => {
    // Deliberately outside the type: the assertion is that the schema refuses it at load.
    assert.throws(() => Config({ auth: { mode: 'oauth-personal' } }), /expected "gemini-api-key" \| "agent-platform"/);
});
test('key auth without any key registers nothing and says why', () => {
    delete process.env['ANTIGRAVITY_TEST_MISSING_KEY'];
    const state = run({ auth: { mode: 'gemini-api-key', apiKeyEnv: 'ANTIGRAVITY_TEST_MISSING_KEY' } });
    assert.deepEqual(state.registered, []);
    assert.deepEqual(state.logs, [GATE_MESSAGE]);
});
test('a credential service or agent-platform registers the antigravity runtime', () => {
    const withCredentials = run({ auth: { mode: 'gemini-api-key', apiKeyEnv: 'ANTIGRAVITY_TEST_MISSING_KEY' } }, { readRecord: async () => undefined });
    assert.deepEqual(withCredentials.registered, ['antigravity']);
    const adc = run({ auth: { mode: 'agent-platform' } });
    assert.deepEqual(adc.registered, ['antigravity']);
    assert.deepEqual(adc.logs, []);
});
