export function fakeAgent(options = {}) {
    const requests = [];
    const notifications = [];
    const waiting = new Map();
    let handlers;
    let disposals = 0;
    const responses = new Map();
    responses.set('initialize', () => ({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: options.capabilities ?? { resume: {}, close: {} } } }));
    responses.set('session/new', () => ({ sessionId: 's1', configOptions: options.configOptions ?? [] }));
    responses.set('session/resume', () => ({ configOptions: options.configOptions ?? [] }));
    responses.set('session/set_config_option', params => ({
        configOptions: (options.configOptions ?? []).map(option => option['id'] === params['configId'] ? { ...option, currentValue: params['value'] } : option),
    }));
    responses.set('session/prompt', () => ({ stopReason: 'end_turn' }));
    return {
        requests,
        notifications,
        responses,
        disposals: () => disposals,
        handlers: () => handlers,
        setHandlers(next) {
            handlers = next;
        },
        async request(method, params, timeoutMs) {
            requests.push({ method, params, timeoutMs });
            const resume = waiting.get(method);
            if (resume !== undefined) {
                waiting.delete(method);
                for (const resumeOne of resume)
                    resumeOne();
            }
            const responder = responses.get(method);
            return responder === undefined ? {} : responder(params);
        },
        notify(method, params) {
            notifications.push({ method, params });
        },
        async dispose() {
            disposals += 1;
        },
        async fromAgent(method, params) {
            if (handlers?.request === undefined)
                throw new Error('the adapter installed no request handler');
            return handlers.request(method, params);
        },
        whenRequested(method) {
            if (requests.some(request => request.method === method))
                return Promise.resolve();
            const { promise, resolve } = Promise.withResolvers();
            waiting.set(method, [...(waiting.get(method) ?? []), resolve]);
            return promise;
        },
        update(body) {
            handlers?.notification?.('session/update', { sessionId: 's1', update: body });
        },
    };
}
