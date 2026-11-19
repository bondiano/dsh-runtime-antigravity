/**
 * Antigravity as an autonomous harness runtime (`agentRuntime` provider `antigravity`).
 *
 * Compliance gate: the consumer Antigravity login is for a human prompting through a chat surface.
 * Driving Antigravity as a model backend requires `gemini-api-key` or `agent-platform` credentials,
 * so this plugin registers nothing without one and says so in one fixed line.
 */
import { createAntigravityRuntime } from './lib/adapter.js';
import { GATE_MESSAGE, apiKeyOf } from './src/domain/config.js';
export { Config } from './src/domain/config.js';
export const name = 'runtime-antigravity';
/** The harness credential record this runtime reads; Antigravity's own OAuth stores are never opened. */
const CREDENTIAL_RECORD = 'dsh-antigravity/default';
export function apply(ctx, config) {
    const logger = typeof ctx.logger === 'function' ? ctx.logger('antigravity') : undefined;
    const credentials = ctx.get('credentials');
    if (config.auth.mode === 'gemini-api-key' && apiKeyOf(config, process.env) === undefined && credentials === undefined) {
        logger?.warn?.(GATE_MESSAGE);
        return;
    }
    ctx.inject(['agentRuntime'], scoped => {
        const adapter = createAntigravityRuntime({
            config,
            getApiKey: async () => {
                const record = await scoped.get('credentials')?.readRecord(CREDENTIAL_RECORD);
                const payload = record?.payload;
                if (record?.kind === 'grant' && payload?.v === 1 && typeof payload.apiKey === 'string') {
                    if (payload.expiresAt === undefined || payload.expiresAt > Date.now())
                        return payload.apiKey;
                }
                return undefined;
            },
        });
        scoped.effect(() => scoped.get('agentRuntime').register(adapter));
        scoped.on('dispose', () => adapter.dispose());
    });
}
