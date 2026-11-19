/** Session/run lifecycle of the Antigravity ACP adapter (lib/adapter.ts). */
import { createMachine, initialTransition, transition } from 'xstate'

export const antigravityRuntimeMachine = createMachine({
  id: 'antigravityRuntimeSession',
  initial: 'idle',
  states: {
    idle: { on: { START: 'running', CLOSE: 'closing' } },
    running: { on: { WAITING: 'awaitingInput', COMPLETE: 'completed', CANCEL: 'cancelled', FAIL: 'failed', CLOSE: 'closing' } },
    awaitingInput: { on: { WAITING: 'awaitingInput', ANSWER: 'running', CANCEL: 'cancelled', FAIL: 'failed', CLOSE: 'closing' } },
    completed: { on: { START: 'running', CLOSE: 'closing' } },
    cancelled: { on: { START: 'running', CLOSE: 'closing' } },
    failed: { on: { START: 'running', CLOSE: 'closing' } },
    closing: { on: { CLOSED: 'closed' } },
    closed: { type: 'final' },
  },
})

export const initialRunState = () => initialTransition(antigravityRuntimeMachine)[0].value

export function nextRunState(state, event) {
  const eventObject = typeof event === 'string' ? { type: event } : event
  const snapshot = antigravityRuntimeMachine.resolveState({ value: state })
  if (!snapshot.can(eventObject)) throw new Error(`illegal antigravity runtime transition: ${state} --${eventObject.type}-->`)
  return transition(antigravityRuntimeMachine, snapshot, eventObject)[0].value
}

export function settleRunState(state, event) {
  return state === 'running' || state === 'awaitingInput' ? nextRunState(state, event) : state
}
