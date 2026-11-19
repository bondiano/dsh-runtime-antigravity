/**
 * The settings document of the Antigravity runtime, rendered by the harness settings UI.
 *
 * `auth.mode` deliberately has no consumer-oauth value: a schema rejection is louder than a
 * silently disabled runtime, and a harness backend may never use consumer credentials.
 */
import Schema from '@deepseek-ai/schemastery'

export type AuthMode = 'gemini-api-key' | 'agent-platform'
export type PermissionPolicy = 'ask' | 'allow' | 'reject'

/** Runtime settings; every field has a default so an empty document is a valid configuration. */
export interface AntigravityConfig {
  auth: { mode: AuthMode; apiKeyEnv: string }
  command: string
  agent?: string
  addDirs: string[]
  sandbox: boolean
  /** Serve each session from an isolated Antigravity worker process. */
  processPerSession: boolean
  disableTelemetry: boolean
  logFile?: string
  defaults: { model?: string; thoughtLevel?: string }
  /** `ask` surfaces a permission request to the harness UI; `allow`/`reject` answer it directly. */
  permission: PermissionPolicy
  /** Advertise and serve `fs/read_text_file` for the session workspace. */
  fsRead: boolean
  timeouts: { initMs: number; eofGraceMs: number; disposeGraceMs: number }
}

export const Config: Schema<AntigravityConfig> = Schema.object({
  auth: Schema.object({
    mode: Schema.union([Schema.const('gemini-api-key'), Schema.const('agent-platform')]).default('gemini-api-key'),
    apiKeyEnv: Schema.string().default('GEMINI_API_KEY'),
  }).default({}),
  command: Schema.string().default('agy'),
  agent: Schema.string(),
  addDirs: Schema.array(Schema.string()).default([]),
  sandbox: Schema.boolean().default(false),
  processPerSession: Schema.boolean().default(true),
  disableTelemetry: Schema.boolean().default(false),
  logFile: Schema.string(),
  defaults: Schema.object({ model: Schema.string(), thoughtLevel: Schema.string() }).default({}),
  permission: Schema.union([Schema.const('ask'), Schema.const('allow'), Schema.const('reject')]).default('allow'),
  fsRead: Schema.boolean().default(true),
  timeouts: Schema.object({
    initMs: Schema.number().default(45_000),
    eofGraceMs: Schema.number().default(6_000),
    disposeGraceMs: Schema.number().default(3_000),
  }).default({}),
})

/** The refusal logged when no harness-capable authentication is configured. */
export const GATE_MESSAGE =
  'Antigravity runtime disabled: harness use requires gemini-api-key or agent-platform (consumer oauth is interactive-only)'

/** Arguments of one child: the `acp` subcommand, then only fluent, allowlisted settings. */
export function agentArguments(config: AntigravityConfig, extraAddDirs: readonly string[] = []): string[] {
  const args = ['acp']
  if (config.agent !== undefined) args.push('--agent', config.agent)
  for (const directory of [...config.addDirs, ...extraAddDirs]) args.push('--add-dir', directory)
  if (config.sandbox) args.push('--sandbox')
  if (config.processPerSession) args.push('--process-per-session')
  if (config.disableTelemetry) args.push('--disable-telemetry')
  if (config.logFile !== undefined) args.push('--log-file', config.logFile)
  return args
}

/** The environment key `gemini-api-key` mode needs; `agent-platform` passes ADC env through. */
export function apiKeyOf(config: AntigravityConfig, env: NodeJS.ProcessEnv): string | undefined {
  const key = env[config.auth.apiKeyEnv]
  return typeof key === 'string' && key.length > 0 ? key : undefined
}
