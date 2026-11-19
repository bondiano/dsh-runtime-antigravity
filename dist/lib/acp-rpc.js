/**
 * The hand-rolled ACP v1 client for the DSH runtime: one newline-delimited JSON-RPC channel over a
 * child's stdio, plus the fixed failure taxonomy the harness reports.
 *
 * Diagnostics are client-owned text only: an agent-authored message never reaches a harness error,
 * so a hostile or confused agent cannot write into the run log.
 */
import { spawn } from 'node:child_process';
/** A fixed-text failure: the stage says what broke, never what the agent said. */
export class AcpFailure extends Error {
    stage;
    constructor(stage, detail) {
        super(`Antigravity ACP failed at ${stage}: ${detail}`);
        this.name = 'AcpFailure';
        this.stage = stage;
    }
}
/** A JSON-RPC error frame; `-32000` is the agent's authentication signal. */
export class AcpError extends Error {
    code;
    constructor(message, code) {
        super(message);
        this.name = 'AcpError';
        this.code = code;
    }
}
const asRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
/** NDJSON transport: stdout is protocol-only, stderr is drained and never parsed. */
export class AcpRpc {
    process;
    pending = new Map();
    eofGraceMs;
    disposeGraceMs;
    maxBytes;
    handlers = {};
    buffer = '';
    sequence = 0;
    exited = false;
    disposing = false;
    error;
    constructor({ command, args, cwd, env, spawnProcess = spawn, eofGraceMs = 6_000, disposeGraceMs = 3_000, maxBytes = 4_194_304 }) {
        this.eofGraceMs = eofGraceMs;
        this.disposeGraceMs = disposeGraceMs;
        this.maxBytes = maxBytes;
        // The stdio triple below guarantees all three streams exist.
        this.process = spawnProcess(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
        this.process.stdout.setEncoding('utf8');
        this.process.stdout.on('data', (chunk) => this.receive(chunk));
        this.process.stderr.resume();
        this.process.on('error', error => this.fail(new AcpFailure('process', `the process could not start (${error.code ?? 'unknown'})`)));
        this.process.on('exit', (code, signal) => {
            this.exited = true;
            this.fail(this.error ?? new AcpFailure('process', `the process exited (${code ?? signal ?? 'unknown'})`));
        });
        this.process.stdin.on('error', () => this.fail(new AcpFailure('process', 'the process stdin closed')));
    }
    setHandlers(handlers) {
        this.handlers = handlers;
    }
    receive(chunk) {
        this.buffer += chunk;
        if (Buffer.byteLength(this.buffer) > this.maxBytes)
            return this.fail(new AcpFailure('process', 'the frame buffer limit was exceeded'));
        let end;
        while ((end = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, end).trim();
            this.buffer = this.buffer.slice(end + 1);
            if (!line)
                continue;
            let frame;
            try {
                frame = asRecord(JSON.parse(line)) ?? {};
            }
            catch {
                this.fail(new AcpFailure('process', 'the process sent a frame that is not JSON'));
                return;
            }
            this.dispatch(frame);
        }
    }
    dispatch(frame) {
        const id = typeof frame['id'] === 'number' ? frame['id'] : undefined;
        const method = typeof frame['method'] === 'string' ? frame['method'] : undefined;
        const params = asRecord(frame['params']) ?? {};
        if (method === undefined) {
            const pending = id === undefined ? undefined : this.pending.get(id);
            if (pending === undefined || id === undefined)
                return;
            clearTimeout(pending.timer);
            this.pending.delete(id);
            const error = asRecord(frame['error']);
            if (error !== undefined) {
                const code = typeof error['code'] === 'number' ? error['code'] : undefined;
                pending.reject(new AcpError('the agent answered with an error frame', code));
            }
            else
                pending.resolve(asRecord(frame['result']) ?? {});
            return;
        }
        if (id === undefined) {
            this.handlers.notification?.(method, params);
            return;
        }
        void this.answer(id, method, params);
    }
    async answer(id, method, params) {
        try {
            const result = await this.handlers.request?.(method, params);
            this.write({ jsonrpc: '2.0', id, result: result ?? {} });
        }
        catch {
            // A capability the client did not advertise is refused, never emulated.
            this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unsupported client request' } });
        }
    }
    write(frame) {
        if (this.error !== undefined)
            return;
        try {
            this.process.stdin.write(`${JSON.stringify(frame)}\n`);
        }
        catch {
            this.fail(new AcpFailure('process', 'the write to the process failed'));
        }
    }
    request(method, params, timeoutMs = 30_000) {
        if (this.error !== undefined)
            return Promise.reject(this.error);
        const id = ++this.sequence;
        const { promise, resolve, reject } = Promise.withResolvers();
        const timer = setTimeout(() => {
            const failure = new AcpFailure('process', `the agent did not answer ${method} within ${timeoutMs}ms`);
            this.pending.delete(id);
            this.fail(failure);
            reject(failure);
        }, timeoutMs);
        this.pending.set(id, { resolve, reject, timer });
        this.write({ jsonrpc: '2.0', id, method, params });
        return promise;
    }
    notify(method, params) {
        this.write({ jsonrpc: '2.0', method, params });
    }
    fail(error) {
        if (this.error === undefined)
            this.error = error;
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
        this.handlers.failure?.(error);
    }
    /** EOF, then SIGTERM after `eofGraceMs`, then SIGKILL after `disposeGraceMs`. */
    async dispose() {
        if (this.disposing)
            return;
        this.disposing = true;
        const eof = Promise.withResolvers();
        const term = Promise.withResolvers();
        const eofTimer = setTimeout(() => eof.resolve(), this.eofGraceMs);
        this.process.once('exit', () => {
            clearTimeout(eofTimer);
            eof.resolve();
            term.resolve();
        });
        try {
            this.process.stdin.end();
        }
        catch {
            // A closed stdin already means the child is on its way out.
        }
        await eof.promise;
        if (this.exited)
            return;
        this.process.kill('SIGTERM');
        const killTimer = setTimeout(() => {
            this.process.kill('SIGKILL');
            term.resolve();
        }, this.disposeGraceMs);
        await term.promise;
        clearTimeout(killTimer);
    }
}
