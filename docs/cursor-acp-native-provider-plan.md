# Cursor ACP native model provider plan

## Goal

Add an installable `cursor-acp` LLM provider package to this repository so DeepSeek Harness 0.1.0-rc.6 lists the current Cursor account's models on the native Models page and can use them in the normal Agent Loop. Cursor remains a model transport; DeepSeek Harness keeps context assembly, tool approval, execution, recording, and step progression.

## Repository and compatibility constraints

- Keep the existing uncommitted timeout change in `server/dsh-mcp.mjs` untouched and exclude it from this work's changed-file accounting.
- Put the provider in a new package boundary. Do not modify adjacent repositories or the running DSH Web process on port 3080.
- Target Node.js `^22.19 || >=24` and DSH peer packages `^0.1.0-rc.6`.
- Publish the package under MIT. Reused `dsh-llm-agent-virtualization`, `agent-virtualization`, and `dsh-cursor-acp` source is MIT; the official `@agentclientprotocol/sdk` dependency is Apache-2.0 and must remain attributed through its own package.
- Do not read or return Cursor credential or account fields. Login health uses only the official `cursor-agent status --format json` boolean state.

## DSH adapter contract decisions

- Inject `attributionHeaders()` through Cursor CLI's supported global `--header` option on every ACP process. The runtime must unit-test argv construction and the real probe must prove Cursor accepts the option before provider registration.
- Advertise MCP tools only when `isAgentLoopRequest(options)` is true. Compaction, session-title, and generic one-shot calls run text-only and treat any Cursor built-in/MCP tool attempt as a policy failure.
- Capture `resolveRetryPolicy({ mode: 'normal', maxRetries: 0 })` for the provider. A failed/aborted process is fully torn down; DSH must not replay a partially advanced Cursor session automatically.
- Normal DSH tool steps resume the same live ACP prompt. If the host/plugin/process disappears after a logged tool result, the next request reconstructs a new ACP turn from complete DSH message history and marks it as recovered; an orphaned in-flight call without a durable DSH result fails terminally instead of guessing.
- Keep stable-id tombstones for every catalog row seen during the plugin lifetime and persist the secret-free id→wire-id cache. `listModels()` shows only the current advisory catalog; `resolveModel()` may resolve a tombstoned selection after a refresh, while `stream()` performs an exact availability check before launching Cursor.
- Cordis disposal owns adapter/process/bridge cleanup. Session disposal closes the matching runtime, terminal completion retires it, and missing `sessionId` calls use one-shot runtimes that cannot collide.
- Emit complete indexed DSH blocks and exactly one terminal finish. Tool calls use `block-start`, `tool-call-delta`, `block-end`, then `finish: tool-calls`; cancellation supplies a concrete `LlmFailure`.

## Verified protocol facts

The local `cursor-agent` is `2026.08.11-e8db854`. A real ACP probe established:

- `initialize` negotiates ACP protocol version 1 and advertises HTTP/SSE MCP.
- `session/new` returns `agent`, `plan`, and `ask` modes plus the account's dynamic model catalog and a `model` config option.
- `ask` mode can invoke an HTTP MCP tool.
- Cursor emits an ACP permission request before an MCP call; allowing that request does not execute the tool. The actual `tools/call` HTTP request is the execution boundary.
- Cursor's ordinary ACP `tool_call` notifications are presentation events, not client-executed callbacks.
- `ask` mode still exposes Cursor's built-in Read tool. A real canary outside the session cwd was readable without an ACP permission request. Cancelling immediately on the initial non-MCP `tool_call` notification prevented that read in the observed build, but this timing alone is not a sufficient security boundary.

## Architecture

```text
DSH Agent Loop
  -> CursorAcpAdapter.stream(GenerateOptions)
      -> agent-virtualization model-provider bridge (persistent across DSH steps)
          -> generic-jsonl Cursor runtime owned by this package
              -> isolated Cursor ACP process
              -> authenticated 127.0.0.1 MCP HTTP bridge
                   tools/list <- exact GenerateOptions.tools projected as capabilities
                   tools/call -> generic tool.call -> model-provider tool.call
      <- StreamChunk text/reasoning/tool-call/finish
  -> DSH Tool Scheduler approves, executes, and records
  -> next DSH model step contains tool-result
      -> model-provider tool.result -> generic tool.result -> pending MCP HTTP response
      -> same Cursor ACP prompt resumes
```

The package depends on `agent-virtualization` and uses its versioned `agent-virtualization/model-provider/v1` suspension protocol. It does not invent a second DSH-to-runtime suspension protocol. Cursor-specific code is a generic-JSONL runtime executable that translates ACP updates and loopback HTTP MCP calls at the inner boundary.

### Package boundary

Create `cursor-provider/` as an independent npm package with:

- Cordis plugin registration and Settings schema.
- `CursorAcpAdapter` for DSH `LlmAdapter` mapping and the Agent Virtualization model-provider protocol.
- a generic-JSONL `CursorAcpRuntime` executable for ACP process/session lifecycle.
- a loopback authenticated MCP bridge inside that runtime.
- model catalog normalization and cache refresh.
- health/probe helpers and a package CLI.
- unit, protocol, composition, and opt-in real E2E tests.

The root package becomes a private workspace runner only. The existing `acp/` and `server/` products remain independent.

### Model identity

At refresh time, start a short-lived isolated ACP process, call `initialize` and `session/new`, then close it. Normalize each Cursor wire model into a deterministic DSH id:

- Prefer `cursor-<base-name>-<effort-or-reasoning>` (for example `cursor-grok-4.6-high`).
- Preserve the exact Cursor wire `modelId` only in the in-memory catalog entry used by `session/set_config_option`.
- Resolve collisions with a deterministic short hash of the wire id.
- Reject unknown DSH ids with `LlmError('UNKNOWN_MODEL')`.
- Default to `cursor-grok-4.6-high`; fail visibly if the current account does not offer it rather than silently switching models.

Catalog refresh occurs at startup, on Models-page discovery, after a configurable TTL, and on an explicit CLI refresh. A failed refresh keeps the last good catalog for current traffic while reporting health failure; a first refresh failure leaves the provider registered but with no selectable models.

### Tool governance

- Advertise no ACP client filesystem or terminal capabilities.
- Select Cursor session mode from advertised DSH tools: nonempty/tool-bearing capabilities use `agent`; zero-tool/text-only calls use `ask`. Pass only the private loopback MCP server. Built-in Cursor tools remain independently denied.
- Generate a random bearer token and randomized MCP server name per runtime. Bind only `127.0.0.1` and reject missing/wrong auth, wrong path, oversized bodies, invalid JSON-RPC, unknown methods, duplicate calls, and stale call ids.
- Auto-allow ACP permission requests only when their exact title, kind, and location-free shape identifies the runtime's randomized MCP server and one advertised DSH tool. Permission precedes HTTP `tools/call`, so it is never treated as execution or as proof that a bridge call already exists. Deny every other permission request.
- Treat ACP `tool_call` notifications only as telemetry. A non-DSH tool notification is a governance violation: cancel the prompt, discard subsequent content, tear down the process, and return `LlmError('POLICY_DENIED')`.
- Keep the MCP `tools/call` HTTP response pending. Emit exactly one standard DSH tool-call block and `finish: tool-calls`. On the next DSH step, require the matching durable tool result, resolve the same HTTP request, and continue the same Cursor prompt.
- Never convert Cursor's normal ACP tool notifications directly into DSH tool calls.

### Fail-closed process isolation

The provider is not complete until the real canary suite proves all built-in Read, Write, Shell, and WebFetch attempts are denied before side effects.

- Use a private temporary HOME/TMP/config and an empty private cwd, not the user's workspace. The user's workspace is represented only through DSH-backed tools.
- On macOS, launch the Cursor Node entry directly under a package-owned Seatbelt profile. Deny file-data reads and writes by default, allowing only system/runtime reads, isolated run state, Cursor's required temporary lock state, and the minimal macOS keychain path needed by Cursor login. Deny arbitrary process execution except the verified Cursor runtime, `/usr/bin/security`, and `/usr/bin/git`. Require Seatbelt availability. macOS rejects nested `sandbox-exec` (`forbidden-sandbox-reinit`), so Agent Virtualization declares its outer sandbox as an explicit no-op for this runtime; the inner Cursor sandbox is mandatory and starts before any ACP session.
- Cursor currently hardcodes web tools on. Maintain an exact canary-verified artifact allowlist covering the launcher, bundled Node, and `index.js` SHA-256 values. Every entry must pass adversarial Read plus a server-observed WebFetch test, physical host-home Write denial, and physical Shell/process-exec denial. Unknown or modified artifacts fail before `initialize` with `INCOMPATIBLE_CURSOR_ACP`.
- On Linux, use Bubblewrap with the equivalent read-only runtime mounts, private home/tmp, no workspace mount, and no child executables beyond the Cursor runtime. Require Bubblewrap availability.
- On unsupported platforms, refuse provider streaming with `SANDBOX_UNAVAILABLE`; do not offer an unenforced compatibility mode by default.
- If Cursor performs a server-side built-in WebFetch that cannot be constrained or cancelled before execution, record it as a hard blocker. Do not describe the provider as governed.

## Stream and lifecycle rules

- Preserve ACP update order through a bounded single-consumer mailbox. ACP stdio uses a package-owned strict bounded NDJSON codec; malformed UTF-8/JSON and oversized frames fail closed without logging raw protocol lines.
- Map text and thought chunks to indexed DSH text/reasoning blocks, closing each block before a kind change, tool call, usage, or finish.
- Map ACP stop reasons: `end_turn -> stop`, `max_tokens -> max-tokens`, `cancelled -> aborted`, and refusal/max-turn failures to typed provider errors.
- Accept `usage_update` only in-order before finish. ACP context `used/size` is cumulative and cannot be mapped to DSH's disjoint per-call token fields. Emit DSH usage only when Cursor explicitly labels metadata as disjoint/model-call scoped; otherwise omit it rather than fabricate counts.
- Reject output after terminal finish, malformed updates, unknown session ids, duplicate terminal events, mismatched tool results, and empty successful turns.
- Caller abort is latched and sent as Agent Virtualization `model.cancel`. The generic runtime answers any later permission request as Cancelled, rejects pending MCP HTTP responses, sends ACP `session/cancel`, and drains updates until the original prompt returns cancelled or the grace deadline expires. Only then may process-tree termination run; exit is awaited before private state is removed.
- Unexpected child exit, stdout protocol corruption, bridge timeout, auth/quota/login failures, and model incompatibility become stable `LlmError` codes without credential-bearing stderr.
- The Cordis plugin Fiber owns catalog-probe cancellation and every adapter bridge. Unload/HMR aborts probes, gracefully cancels prompts and suspended MCP waits, then awaits process exit and state deletion. The inner standalone runtime cannot consume Host `ctx.subprocess`; it still uses bounded TERM→KILL plus awaited exit. If ACP advertises `sessionCapabilities.close`, normal teardown calls `session/close`; stdio/process closure remains the fallback.

## Configuration and native Models page

Register configurable provider `cursor-acp` with settings namespace `llm-cursor-acp`. A package client extension contributes **Settings → Cursor ACP** because rc.6's built-in Models editor disables Apply for unknown third-party namespace layouts; live Cursor models still appear in the native Models selectors. Fields:

- `command` (default resolved `cursor-agent` path)
- `defaultModel` (default `cursor-grok-4.6-high`)
- `catalogTtlMs`, `promptTimeoutMs`, `graceMs`
- `maxProtocolLineBytes`, `maxMcpBodyBytes`, `stderrMaxBytes`
- optional explicit proxy environment names, never values in status output

The package CLI provides `doctor`, `models --refresh`, and `probe`. Output contains path/version, verified/required/unknown authentication state, sandbox availability, model ids/names, and stable error kinds only. It never prints email, credentials, raw status output, headers, or tokens.

## Test plan

### Unit and protocol

- model-id normalization, collision stability, default selection, unknown model, and refresh replacement/last-good behavior
- ACP framing, malformed JSON, wrong request ids, out-of-order/duplicate updates, empty output, unknown update, and version incompatibility
- text/thought block ordering, stop reasons, optional usage metadata, auth/quota/transport error classification
- MCP initialize/list/call, bearer auth, body bounds, duplicate/stale calls, tool success/error/denial, and pending-response resume
- cancellation, prompt timeout, process exit, process-tree teardown, and temporary-state cleanup
- login health redaction and command resolution

### DSH composition

Boot a real `cordis.yml` through the Loader, assert `cursor-acp` appears in configurable providers and models, then run a mock Cursor ACP process through the actual DSH Agent Loop. Assert `tool/call` precedes `tool/result`, the scheduler executes the tool, and the resumed Cursor session produces the final assistant response.

### Real keyless E2E

Opt-in test against the installed logged-in `cursor-agent`:

1. refresh the live model catalog and select `cursor-grok-4.6-high`;
2. stream a text-only turn through `ctx.llm`;
3. run one MCP echo call through the full DSH Agent Loop and assert the DSH session log records call/result before the final text;
4. run Agent-mode external canaries (one harmless nonempty DSH capability) for built-in Read, Write, Shell, WebFetch, and Find if Cursor emits a distinct Find request; assert `POLICY_DENIED`, no local side effect, and a zero-request WebFetch observer.

## Verification gates

From the repository root:

```sh
pnpm install
pnpm run typecheck
pnpm run test
pnpm run build
pnpm --filter @jeremy9682/dsh-llm-cursor-acp pack --pack-destination /tmp/dsh-cursor-pack
# install the tarball into a disposable DSH_HOME/profile and run doctor/catalog smoke
DSH_CURSOR_E2E=1 pnpm --filter @jeremy9682/dsh-llm-cursor-acp test:e2e
```

Do not restart the active port-3080 process. Verify installation with a disposable profile/process on another temporary DSH_HOME; stop that process after the smoke test.

## Completion evidence

Completion requires all gates above, exact changed-file accounting that excludes the pre-existing `server/dsh-mcp.mjs` diff, a real provider text stream, a real DSH-scheduled MCP tool round trip, successful denial canaries, and documented install/restart/rollback commands. Any uncontained built-in path is a blocker rather than a residual limitation.
