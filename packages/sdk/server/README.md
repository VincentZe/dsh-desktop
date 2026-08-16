# @deepseek-ai/dsh-sdk-jsonrpc-server

English | [中文](README.zh.md)

The `jsonrpc` plugin serves newline-delimited JSON-RPC over stdio so out-of-process SDK clients can drive harness agents. [`HarnessSdkJsonRpcServer`](src/server.ts) owns the protocol methods and notifications; the transport and the named wire types live in [`dsh-sdk-protocol`](../protocol/README.md), shared with the client SDKs; [`jsonrpc-demo`](../../examples/jsonrpc-demo/README.md) supplies the surrounding `cordis.yml` application.

## Wiring

`inject: ['agents']`. The server gets or creates one agent per `sessionId`. When `userQuestions` is present, it registers a provider that sends `interaction/request` to the SDK caller and waits for the structured answer; the server never renders the question. It forwards subagent completions only when the service-snapshotted lifecycle `local` flag is true; provider names, child ids, and durable lineage never establish locality. A registered adapter wins, an unowned `deepseek-official` route mounts `dsh-llm-deepseek`, and other providers may become available during the configured settings startup window. Any provider still unowned after that window fails initialization. Other capabilities come from the surrounding `cordis.yml`.

## Config

`maxTokensAsSuccess` defaults to `false` and affects only the deployment-mapped status on `subagent.finished`; root-session prompts have no prompt-level status. `adapterReadyTimeoutMs` defaults to `1000` and bounds the wait for a settings-backed route to publish `llm/adapters-updated` during `initialize`; set it to `0` for a deployment that has no dynamic adapter startup. `JsonRpcConfig.input`, `output`, and `exit` are runtime-only transport hooks; production uses process stdio and `process.exit`.

## stdout is the protocol

Stdout carries only JSON-RPC frames. The deployment must not compose a stdout logger; diagnostics belong on stderr.

## Shutdown and exit semantics

The plugin answers `shutdown`, flushes the response, disposes the root context so SDK-owned agents, subscriptions, and persistence reach quiescence, then exits with code 0. EOF and signal exits belong to the app bin, which also disposes the root context. Unloading only this plugin stops serving without exiting the process.

## Wire notes

`initialize.serverInfo.name` is the wire-stable `deepseek-harness-sdk-runtime`. `initialize.model` accepts the provider-owned model id or a unique advertised model name; an exact id wins when both match, and subsequent requests use the resolved id. An optional positive `initialize.maxTokens` becomes the request output cap of each SDK-created agent and its in-process descendants; invalid values reject initialization, while omission sends no SDK cap and allows the selected adapter or provider route default to apply. `session/prompt` queues one identified user message and immediately returns `{ messageId }`. The server streams every durable fact as `session.event` and every whole-agent lifecycle transition as `session.status`; it does not assign an assistant message or `turn/end` to that prompt. Independent requests may enqueue more work on the same session. Persistence roots and persona come from `cordis.yml`.

When the surrounding config loads `dsh-user-questions`, a model-facing `ask_user_question` call becomes a server-to-caller `interaction/request`. Its params carry a request id, optional session id, question text, options, and multi-select flags. The caller returns `{ requestId, answers }`; both the request and answer are validated against the question ids and offered option labels before the tool resumes.

## Model Experience

### SDK user message

#### What the model sees

For each accepted `session/prompt`, the conversation model receives the caller-supplied `contentBlocks` verbatim as one user message in that SDK session. This package adds no system-prompt prose or tool schema; those come from the plugins in the surrounding `cordis.yml`.

#### Token effect

Data-dependent user-message tokens enter retained session history and are resent on later turns until another package compacts them. The JSON-RPC frames, session notifications, and server bookkeeping add zero model-context tokens.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **The wire has no per-session close or prompt-cancel method** — SDK-created agents remain live until process shutdown.
- **There is no per-prompt result** — `MessageId` identifies inbox admission only; clients that own an automation interval must define and observe that interval themselves.
- **stdout purity is deployment-enforced** — a surrounding config can still load a stdout logger and corrupt the JSON-RPC channel; this plugin does not inspect or veto sibling loggers.
- **Automatic adapter mounting is DeepSeek-specific** — `initialize` can reuse any pre-registered model adapter, but its only fallback mounts `dsh-llm-deepseek`.
