import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import { AcpError, AcpFailure, AcpRpc, type AcpTransport } from './acp-rpc.js'
import { initialRunState, nextRunState, settleRunState } from './run.machine.js'
import {
  PROTOCOL_VERSION,
  STOP_STATUS,
  asRecord,
  configOption,
  selectValues,
  selected,
  thoughtLevelValue,
  type ConfigOption,
  type PermissionOption,
  type Update,
} from './acp-options.js'
import { agentArguments, apiKeyOf, type AntigravityConfig, type PermissionPolicy } from '../src/domain/config.js'

const EVENT_LIMIT = 4096

/** Session options the runtime service passes for one agent run. */
export interface AntigravityOptions {
  cwd?: string
  model?: string
  reasoningEffort?: string
  addDirs?: string[]
  onlyTools?: string[]
}

/** One row the adapter streams to the runtime service. */
interface AdapterEvent {
  type: string
  text?: string
  message?: string
  raw?: unknown
  requestId?: string
  options?: PermissionOption[]
  status?: string
  kind?: string
}

/** The live run of one session: its queue, its policy and how it settles. */
interface Run {
  queue: AdapterEvent[]
  done: boolean
  failure?: Error
  wake?: () => void
  policy: PermissionPolicy
}

interface Session {
  rpc: AcpTransport
  options: AntigravityOptions
  id: string
  roots: string[]
  configOptions: ConfigOption[]
  requires: Map<string, PermissionOption[]>
  answers: Map<string, (outcome: unknown) => void>
  usage: unknown
  active: string | symbol | null
  state: unknown
  stop?: () => void
  run?: Run
  sequence: number
}

interface SendOptions {
  runId?: string
  signal?: AbortSignal
  policy?: PermissionPolicy
}

/** Runtime dependencies: the credential seam, the environment and the transport factory. */
export interface RuntimeDeps {
  config: AntigravityConfig
  env?: NodeJS.ProcessEnv
  /** Reads the harness credential record; the environment variable is the documented fallback. */
  getApiKey?: () => Promise<string | undefined>
  createRpc?: (options: { command: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv; eofGraceMs?: number; disposeGraceMs?: number }) => AcpTransport
}

export function createAntigravityRuntime({ config, env = process.env, getApiKey, createRpc }: RuntimeDeps) {
  const sessions = new Map<string, Session>()
  let resumeSupported = true
  const get = (id: string): Session => {
    const session = sessions.get(id)
    if (session === undefined) throw new AcpFailure('prompt', 'the session is unknown')
    return session
  }

  function transport(cwd: string | undefined, addDirs: readonly string[], childEnv: NodeJS.ProcessEnv): AcpTransport {
    const factory = createRpc ?? (options => new AcpRpc(options))
    return factory({
      command: config.command,
      args: agentArguments(config, addDirs),
      cwd,
      env: childEnv,
      eofGraceMs: config.timeouts.eofGraceMs,
      disposeGraceMs: config.timeouts.disposeGraceMs,
    })
  }

  async function childEnvironment(): Promise<NodeJS.ProcessEnv> {
    if (config.auth.mode !== 'gemini-api-key') return env
    const key = (await getApiKey?.()) ?? apiKeyOf(config, env)
    if (key === undefined) throw new AcpFailure('initialize', `auth.mode is gemini-api-key but neither the dsh-antigravity/default credential record nor $${config.auth.apiKeyEnv} is set`)
    return { ...env, GEMINI_API_KEY: key }
  }

  /** Pick the configured method on a fresh child; the isolated profile holds no consumer login. */
  async function selectMethod(rpc: AcpTransport, init: Record<string, unknown>): Promise<void> {
    const offered = Array.isArray(init['authMethods']) ? (init['authMethods'] as { id?: string }[]) : []
    if (!offered.some(method => method.id === config.auth.mode)) {
      throw new AcpFailure('initialize', `the agent does not offer the ${config.auth.mode} authentication method`)
    }
    try {
      await rpc.request('authenticate', { methodId: config.auth.mode }, config.timeouts.initMs)
    } catch (error) {
      if (error instanceof AcpError && error.code === -32000) throw error
      // Client-owned text: the agent's sign-in guidance never becomes a harness error.
      throw new AcpFailure('initialize', `the agent refused the ${config.auth.mode} credentials`)
    }
  }

  /** A permission prompt is answered by policy, or surfaced to the harness and awaited. */
  async function permission(session: Session, params: Record<string, unknown>): Promise<unknown> {
    const options = Array.isArray(params['options']) ? (params['options'] as PermissionOption[]) : []
    const first = (kinds: string[]) => options.find(option => typeof option.optionId === 'string' && kinds.includes(option.kind ?? ''))?.optionId
    const policy = session.run?.policy ?? config.permission
    if (policy === 'allow') return selected(first(['allow_once', 'allow_always']))
    if (policy === 'reject') return selected(first(['reject_once', 'reject_always']))
    const requestId = `permission-${++session.sequence}`
    session.requires.set(requestId, options)
    session.state = nextRunState(session.state, 'WAITING')
    const answer = Promise.withResolvers<unknown>()
    session.answers.set(requestId, answer.resolve)
    session.run?.queue.push({ type: 'permission', requestId, options, raw: params })
    session.run?.wake?.()
    return answer.promise
  }

  /** Read-only file access inside the session roots only. */
  async function readTextFile(session: Session, params: Record<string, unknown>): Promise<unknown> {
    const path = params['path']
    if (typeof path !== 'string' || !isAbsolute(path)) throw new AcpFailure('prompt', 'a file read needs an absolute path')
    const inside = session.roots.some(root => path === root || path.startsWith(`${root}${sep}`))
    if (!inside) throw new AcpFailure('prompt', 'a file read outside the session workspace was refused')
    return { content: await readFile(resolve(path), 'utf8') }
  }

  function handlers(session: Session) {
    return {
      notification(method: string, params: Record<string, unknown>) {
        if (method !== 'session/update' || params['sessionId'] !== session.id) return
        const update = asRecord(params['update']) as Update | undefined
        const run = session.run
        if (update === undefined || run === undefined) return
        const push = (event: AdapterEvent) => {
          if (run.queue.length >= EVENT_LIMIT) {
            run.failure = new AcpFailure('prompt', 'the event buffer limit was exceeded')
            run.done = true
          } else run.queue.push(event)
          run.wake?.()
          run.wake = undefined
        }
        switch (update.sessionUpdate) {
          case 'agent_message_chunk':
            push({ type: 'text', text: update.content?.type === 'text' ? update.content.text : undefined, raw: update })
            return
          case 'agent_thought_chunk':
            push({ type: 'reasoning', text: update.content?.type === 'text' ? update.content.text : undefined, raw: update })
            return
          case 'tool_call':
            push({ type: 'tool-call', text: update.title, kind: update.kind, raw: update })
            return
          case 'tool_call_update':
            push({ type: 'tool-result', text: update.title, kind: update.kind, raw: update })
            return
          case 'usage_update':
            session.usage = update
            push({ type: 'usage', raw: update })
            return
          case 'user_message_chunk':
            return
          default:
            // plan/config/session-info/compaction and future variants carry no run event here.
            push({ type: 'provider', raw: update })
        }
      },
      async request(method: string, params: Record<string, unknown>): Promise<unknown> {
        if (method === 'session/request_permission') return permission(session, params)
        if (method === 'fs/read_text_file' && config.fsRead) return readTextFile(session, params)
        throw new AcpFailure('prompt', 'the request is not served by this client')
      },
    }
  }

  async function applyOptions(session: Session, wanted: { model?: string; thoughtLevel?: string }): Promise<void> {
    if (wanted.model !== undefined) {
      const option = configOption(session.configOptions, 'model')
      // An agent that advertises no such option keeps its own default.
      if (option !== undefined) await setConfig(session, option.id, wanted.model)
    }
    if (wanted.thoughtLevel !== undefined) {
      const option = configOption(session.configOptions, 'thought_level')
      const value = option === undefined ? undefined : thoughtLevelValue(option, wanted.thoughtLevel)
      if (option !== undefined && value !== undefined) await setConfig(session, option.id, value)
    }
  }

  async function setConfig(session: Session, configId: string, value: string): Promise<void> {
    const applied = await session.rpc.request('session/set_config_option', { sessionId: session.id, configId, value }, config.timeouts.initMs)
    if (Array.isArray(applied['configOptions'])) session.configOptions = applied['configOptions'] as ConfigOption[]
  }

  async function open(options: AntigravityOptions, existingId?: string) {
    if (options.onlyTools !== undefined) throw new AcpFailure('new-session', 'ACP exposes no session tool allowlist')
    if (existingId !== undefined && !resumeSupported) throw new AcpFailure('new-session', 'the agent does not advertise session resume')
    const live = existingId === undefined ? undefined : sessions.get(existingId)
    if (live !== undefined) {
      if (live.rpc.error === undefined) return { id: live.id, cwd: live.options.cwd ?? process.cwd() }
      // A dead child cannot be resumed in place: drop it and reopen the session on a new one.
      await live.rpc.dispose()
      sessions.delete(live.id)
    }
    const cwd = options.cwd ?? process.cwd()
    const addDirs = options.addDirs ?? []
    const rpc = transport(cwd, addDirs, await childEnvironment())
    const draft: Session = {
      rpc,
      options,
      id: existingId ?? '',
      roots: [resolve(cwd), ...config.addDirs, ...addDirs].map(directory => resolve(directory)),
      configOptions: [],
      requires: new Map(),
      answers: new Map(),
      usage: null,
      active: null,
      state: initialRunState(),
      sequence: 0,
    }
    rpc.setHandlers(handlers(draft))
    try {
      const init = await rpc.request(
        'initialize',
        {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: config.fsRead ? { fs: { readTextFile: true, writeTextFile: false } } : {},
          clientInfo: { name: 'dsh-antigravity', version: '1.0.0' },
        },
        config.timeouts.initMs,
      )
      if (init['protocolVersion'] !== PROTOCOL_VERSION) {
        throw new AcpFailure('initialize', `the agent answered protocol version ${String(init['protocolVersion'])}`)
      }
      await selectMethod(rpc, init)
      const capabilities = asRecord(asRecord(init['agentCapabilities'])?.['sessionCapabilities']) ?? {}
      resumeSupported = capabilities['resume'] !== undefined
      const opened = await rpc.request(
        existingId === undefined ? 'session/new' : 'session/resume',
        existingId === undefined ? { cwd, mcpServers: [] } : { sessionId: existingId, cwd, mcpServers: [] },
        config.timeouts.initMs,
      )
      const sessionId = existingId ?? (typeof opened['sessionId'] === 'string' ? opened['sessionId'] : '')
      if (sessionId.length === 0) throw new AcpFailure('new-session', 'the agent did not return a session ID')
      if (sessions.has(sessionId)) throw new AcpFailure('new-session', 'the session is already connected')
      draft.id = sessionId
      draft.configOptions = Array.isArray(opened['configOptions']) ? (opened['configOptions'] as ConfigOption[]) : []
      sessions.set(sessionId, draft)
      await applyOptions(draft, {
        model: options.model ?? config.defaults.model,
        thoughtLevel: options.reasoningEffort ?? config.defaults.thoughtLevel,
      })
      return { id: sessionId, cwd }
    } catch (error) {
      sessions.delete(draft.id)
      await rpc.dispose()
      throw error
    }
  }

  return {
    id: 'antigravity',
    capabilities: async () => ({ resume: resumeSupported, streaming: true, usage: true, cancel: true, permissions: true, fork: false, missions: false, settings: true }),
    create: (options: AntigravityOptions) => open(options),
    resume: (id: string, options: AntigravityOptions = {}) => open(options, id),
    async *send(id: string, message: string | { text: string }, { runId, signal, policy }: SendOptions = {}) {
      const session = get(id)
      if (session.active) throw new AcpFailure('prompt', 'the session is busy')
      if (signal?.aborted) throw new AcpFailure('prompt', 'the run was aborted before it started')
      session.state = nextRunState(session.state, 'START')
      session.active = runId ?? Symbol('run')
      const run: Run = { queue: [], done: false, policy: policy ?? config.permission }
      session.run = run
      const text = typeof message === 'string' ? message : message.text
      const settle = (event: string) => {
        session.state = settleRunState(session.state, event)
      }
      const abort = () => {
        session.rpc.notify('session/cancel', { sessionId: session.id })
        for (const [requestId, resolveAnswer] of session.answers) {
          resolveAnswer({ outcome: { outcome: 'cancelled' } })
          session.answers.delete(requestId)
        }
        run.done = true
        settle('CANCEL')
        run.queue.push({ type: 'cancelled' })
        run.wake?.()
      }
      session.stop = () => {
        run.done = true
        settle('CANCEL')
        run.queue.push({ type: 'cancelled' })
        run.wake?.()
      }
      signal?.addEventListener('abort', abort, { once: true })
      void session.rpc
        .request('session/prompt', { sessionId: session.id, prompt: [{ type: 'text', text }] })
        .then(
          response => {
            run.queue.push({ type: 'completed', status: STOP_STATUS[String(response['stopReason'])] ?? String(response['stopReason'] ?? 'unknown') })
            run.done = true
            settle('COMPLETE')
            run.wake?.()
          },
          error => {
            run.failure = error instanceof Error ? error : new AcpFailure('prompt', 'the prompt failed')
            run.queue.push({ type: 'error', message: run.failure.message })
            run.done = true
            settle('FAIL')
            run.wake?.()
          },
        )
      try {
        while (!run.done || run.queue.length > 0) {
          const event = run.queue.shift()
          if (event === undefined) await new Promise<void>(resolve => { run.wake = resolve })
          else yield event
        }
        if (run.failure !== undefined) throw run.failure
      } finally {
        if (!run.done) abort()
        signal?.removeEventListener('abort', abort)
        session.requires.clear()
        session.answers.clear()
        session.active = null
        session.run = undefined
        session.stop = undefined
      }
    },
    async respond(id: string, requestId: string, optionId: string) {
      const session = get(id)
      const options = session.requires.get(requestId)
      if (options === undefined) throw new AcpFailure('prompt', 'the permission request is no longer pending')
      if (!options.some(option => option.optionId === optionId)) throw new AcpFailure('prompt', 'the permission option was not offered')
      session.state = nextRunState(session.state, 'ANSWER')
      session.requires.delete(requestId)
      session.answers.get(requestId)?.({ outcome: { outcome: 'selected', optionId } })
      session.answers.delete(requestId)
    },
    async cancel(id: string, runId?: string) {
      const session = get(id)
      if (session.active === null || session.active !== runId) return
      session.rpc.notify('session/cancel', { sessionId: session.id })
      session.stop?.()
    },
    async close(id: string) {
      const session = get(id)
      session.stop?.()
      if (resumeSupported) await session.rpc.request('session/close', { sessionId: session.id }, config.timeouts.initMs).catch(() => {})
      await session.rpc.dispose()
      sessions.delete(id)
    },
    async getUsage(id: string) {
      return get(id).usage
    },
    async updateSettings(id: string, options: AntigravityOptions) {
      const session = get(id)
      if (session.active !== null) throw new AcpFailure('prompt', 'cannot update a busy session')
      if (options.onlyTools !== undefined) throw new AcpFailure('prompt', 'ACP exposes no session tool allowlist')
      await applyOptions(session, { model: options.model, thoughtLevel: options.reasoningEffort })
      session.options = { ...session.options, ...options }
    },
    async catalog({ cwd }: { cwd?: string } = {}) {
      const directory = cwd ?? process.cwd()
      const rpc = transport(directory, [], await childEnvironment())
      try {
        const init = await rpc.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: 'dsh-antigravity', version: '1.0.0' } }, config.timeouts.initMs)
        await selectMethod(rpc, init)
        const opened = await rpc.request('session/new', { cwd: directory, mcpServers: [] }, config.timeouts.initMs)
        const option = configOption(Array.isArray(opened['configOptions']) ? (opened['configOptions'] as ConfigOption[]) : [], 'model')
        if (option === undefined) throw new AcpFailure('new-session', 'the agent advertises no model option')
        const models = selectValues(option).map(entry => ({ id: entry.value, name: entry.name }))
        if (models.length === 0) throw new AcpFailure('new-session', 'the model option lists no models')
        return { models }
      } finally {
        await rpc.dispose()
      }
    },
    async dispose() {
      for (const session of sessions.values()) {
        session.stop?.()
        await session.rpc.dispose()
      }
      sessions.clear()
    },
  }
}
