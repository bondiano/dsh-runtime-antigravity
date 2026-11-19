/**
 * Scripted ACP agent: records the frames the adapter sends and answers from a per-method table.
 * It implements the transport surface, so no test spawns a process.
 */
import type { AcpHandlers, AcpTransport } from '../lib/acp-rpc.js'

export type Responder = (params: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>

export interface FakeAgent extends AcpTransport {
  requests: { method: string; params: Record<string, unknown>; timeoutMs?: number }[]
  notifications: { method: string; params: Record<string, unknown> }[]
  responses: Map<string, Responder>
  disposals: () => number
  handlers: () => AcpHandlers | undefined
  /** a client request from the agent, i.e. a permission prompt or a file read */
  fromAgent(method: string, params: Record<string, unknown>): Promise<unknown>
  whenRequested(method: string): Promise<void>
  /** a `session/update` notification for the connected session */
  update(body: Record<string, unknown>): void
}

export function fakeAgent(
  options: { capabilities?: Record<string, unknown>; configOptions?: Record<string, unknown>[] } = {},
): FakeAgent {
  const requests: FakeAgent['requests'] = []
  const notifications: FakeAgent['notifications'] = []
  const waiting = new Map<string, (() => void)[]>()
  let handlers: AcpHandlers | undefined
  let disposals = 0
  const responses: Map<string, Responder> = new Map()
  responses.set('initialize', () => ({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: options.capabilities ?? { resume: {}, close: {} } } }))
  responses.set('session/new', () => ({ sessionId: 's1', configOptions: options.configOptions ?? [] }))
  responses.set('session/resume', () => ({ configOptions: options.configOptions ?? [] }))
  responses.set('session/set_config_option', params => ({
    configOptions: (options.configOptions ?? []).map(option =>
      option['id'] === params['configId'] ? { ...option, currentValue: params['value'] } : option,
    ),
  }))
  responses.set('session/prompt', () => ({ stopReason: 'end_turn' }))
  return {
    requests,
    notifications,
    responses,
    disposals: () => disposals,
    handlers: () => handlers,
    setHandlers(next) {
      handlers = next
    },
    async request(method, params, timeoutMs) {
      requests.push({ method, params, timeoutMs })
      const resume = waiting.get(method)
      if (resume !== undefined) {
        waiting.delete(method)
        for (const resumeOne of resume) resumeOne()
      }
      const responder = responses.get(method)
      return responder === undefined ? {} : responder(params)
    },
    notify(method, params) {
      notifications.push({ method, params })
    },
    async dispose() {
      disposals += 1
    },
    async fromAgent(method, params) {
      if (handlers?.request === undefined) throw new Error('the adapter installed no request handler')
      return handlers.request(method, params)
    },
    whenRequested(method) {
      if (requests.some(request => request.method === method)) return Promise.resolve()
      const { promise, resolve } = Promise.withResolvers<void>()
      waiting.set(method, [...(waiting.get(method) ?? []), resolve])
      return promise
    },
    update(body) {
      handlers?.notification?.('session/update', { sessionId: 's1', update: body })
    },
  }
}
