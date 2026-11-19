# Antigravity runtime

Cordis `agentRuntime` provider `antigravity`: one `agy acp` child per session, driven over the
[Agent Client Protocol](https://agentclientprotocol.com/protocol/v1/overview) v1 (newline-delimited
JSON-RPC over stdio). No SDK is imported; the client is `lib/acp-rpc.ts` and the wire types it reads
are declared locally.

Protocol surface checked against local `agy` 1.5.12 (`agy acp --help`,
`initialize`/`session/new` handshake):

- [Antigravity CLI ACP](https://antigravity.google/docs/cli/acp)
- [Antigravity IDE ACP extension](https://antigravity.google/docs/ide/extensions/acp)

## Compliance

Driving Antigravity as a model backend from a third-party harness is only allowed with
`gemini-api-key` or `agent-platform` (ADC) credentials. The consumer Google login is for a human
prompting through a chat surface; it is not an automation backend. This is the position stated by
Google staff on
[discuss.ai.google.dev/t/200200/2](https://discuss.ai.google.dev/t/200200/2), and the reason the
schema below has no consumer-oauth value at all.

Consequences enforced here, not documented as advice:

- `auth.mode` accepts `gemini-api-key` and `agent-platform` only; `oauth-personal` fails the schema.
- Without a key the plugin registers nothing and logs one fixed line:
  `Antigravity runtime disabled: harness use requires gemini-api-key or agent-platform (consumer oauth is interactive-only)`.
- Antigravity's own OAuth credential files and tokens are never read, copied or forwarded. The only
  credential seam is the harness record `dsh-antigravity/default`, then `$GEMINI_API_KEY`.
- The interactive human surface lives in the omp extension (`extensions/omp/antigravity`), not here.

## Settings

| Key | Default | Meaning |
|---|---|---|
| `auth.mode` | `gemini-api-key` | `gemini-api-key` or `agent-platform` (ADC, host env passed through) |
| `auth.apiKeyEnv` | `GEMINI_API_KEY` | Variable read when no credential record exists |
| `command` | `agy` | Executable; set it when `agy` is not on `PATH` |
| `agent` | — | `--agent <value>` |
| `addDirs` | `[]` | Absolute directories exposed as workspace (repeated `--add-dir`) |
| `sandbox` | `false` | `--sandbox` (terminal restrictions) |
| `processPerSession` | `true` | `--process-per-session` (isolated worker per session) |
| `disableTelemetry` | `false` | `--disable-telemetry` |
| `logFile` | — | `--log-file <path>` |
| `defaults.model` | — | Applied through the session `model` config option when advertised |
| `defaults.thoughtLevel` | — | Applied through `thought_level` (`low`/`medium`/`high`) |
| `permission` | `allow` | `ask` surfaces a `permission` event for the harness UI; `allow`/`reject` answer it directly |
| `fsRead` | `true` | Advertise and serve `fs/read_text_file`, root-checked inside the session workspace |
| `timeouts.initMs` | `45000` | `initialize` + `session/new`/`session/resume` deadline |
| `timeouts.eofGraceMs` | `6000` | EOF window before `SIGTERM` on dispose |
| `timeouts.disposeGraceMs` | `3000` | Window between `SIGTERM` and `SIGKILL` |

`--dangerously-skip-permissions` is not reachable: the `permission` setting owns that decision.

## Authentication setup

1. `gemini-api-key`: store the key in the harness credential record `dsh-antigravity/default` as
   `{ v: 1, apiKey, expiresAt? }`, or export the variable named by `auth.apiKeyEnv`.
2. `agent-platform`: set up Application Default Credentials and export `GOOGLE_CLOUD_PROJECT` and
   `GOOGLE_CLOUD_LOCATION`; the host environment is passed to the child untouched.

`agy acp --login` is the interactive terminal login of Antigravity itself. This plugin never runs it.

## Runtime contract

- `id: antigravity`; `capabilities()` reports `resume` only when `initialize` advertised
  `sessionCapabilities.resume`, plus `streaming`, `usage`, `cancel`, `permissions`, `settings`.
- `create`/`resume` open a child, `initialize`, then `session/new` or `session/resume`; `cwd` and
  `addDirs` are passed both to the child and to the ACP session workspace.
- `send` streams `text`, `reasoning`, `tool-call`, `tool-result`, `usage`, `permission`, and other
  `session/update` variants as `provider`; the prompt response settles the turn as `completed` with
  `end_turn` → `finished`, `cancelled` → `cancelled`, `refusal` → `refused`.
- `session/request_permission` is answered by policy, or surfaced and answered through
  `respond(sessionId, requestId, optionId)`; only an offered option id is accepted.
- `fs/write_text_file`, `terminal/*`, `elicitation/*` and `mcp/*` are never advertised; a request for
  one is answered `-32601`.
- `catalog({cwd})` opens a throwaway session and reads the advertised `model` option; no inference.
- Failures carry a stage (`initialize`, `new-session`, `prompt`, `process`) and client-owned text
  only: an agent-authored message never becomes a harness error.

## Limitations

- No `fork`, no `missions`, and no session-level tool allowlist: `onlyTools` is refused rather than
  approximated.
- No interactive chat tab. The omp extension covers human prompting.
- A child per session, not per turn; `processPerSession` isolates concurrent sessions.

Run `npm run check` for the hermetic fixtures (scripted agent, no process, no network). A live
authenticated run is a separate smoke check.
