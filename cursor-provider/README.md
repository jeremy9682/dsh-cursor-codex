# DSH Cursor ACP provider

Native DeepSeek Harness model provider for the models available through a signed-in Cursor subscription.

The package registers provider ID `cursor-acp`. Models are discovered dynamically from Cursor ACP and appear in the normal DSH Models UI with stable IDs such as `cursor-grok-4.6-high`.

## Requirements

- DeepSeek Harness `0.1.0-rc.6`.
- macOS with `/usr/bin/sandbox-exec`.
- Official Cursor Agent CLI installed and signed in.
- Exact Cursor Agent artifacts for build `2026.08.11-e8db854`. The launcher, bundled Node, and `index.js` hashes must all match the canary-qualified allowlist; any drift fails closed.

The provider never reads or displays an account email or credential value. Cursor receives an isolated HOME with only the macOS Keychains directory linked for its normal authentication mechanism.

## Install

Build and pack this checkout:

```bash
pnpm install
pnpm --filter @jeremy9682/dsh-llm-cursor-acp pack
```

Install the resulting archive into the Web profile:

```bash
dsh plugin --profile web add /absolute/path/to/jeremy9682-dsh-llm-cursor-acp-0.1.0.tgz
```

Restart the existing `dsh web` process using the same command or service definition that originally launched it. Do not start a second server on the same port.

Open **Settings → Cursor ACP** to inspect path/login health, refresh the catalog, or change the provider's preferred default. Then open the native **Models** page and select `cursor-grok-4.6-high` or another live Cursor model as the active main model.

## Health and model refresh

Run the package CLI inside the installed Web profile:

```bash
dsh plugin --profile web exec dsh-cursor-provider doctor
dsh plugin --profile web exec dsh-cursor-provider models --refresh
dsh plugin --profile web exec dsh-cursor-provider doctor --json
```

Health output contains only the CLI path/version, verified/required/unknown authentication state, sandbox/artifact compatibility, default availability, stable model IDs, and model names. It excludes credentials and account identity. Cached models remain advisory when health is unknown; starting a prompt always requires a successful live probe.

If `cursor-agent` is not on PATH, configure its absolute official launcher path in the provider settings or pass `--command PATH` to the health CLI.

## Tool governance

- Direct, title, and compaction calls are text-only.
- Text-only calls use Cursor Ask mode. DSH Agent Loop calls that expose
  scheduler tools use Cursor Agent mode so the model can keep selecting the
  package-owned MCP bridge across tool steps.
- DSH tools are exposed to Cursor only during a DSH Agent Loop request.
- Cursor MCP `tools/call` becomes a standard DSH `tool-call`; DSH owns approval, execution, persistence, and logging.
- The matching DSH `tool-result` resumes the same live Cursor ACP prompt.
- Cancellation propagates as `model.cancel` → generic `run.cancel` → ACP `session/cancel`; the runtime drains the original prompt through its cancelled response before bounded process termination.
- Ordinary ACP `tool_call` notifications are telemetry and never execute a callback. 不要把普通 ACP tool_call notification误当 client-executed callback。
- Unexpected Cursor built-in tool notifications cancel the ACP session with `POLICY_DENIED`.
- The inner macOS sandbox denies file-data reads and writes by default. It admits only system/runtime reads, the isolated run state, Cursor's required temporary lock state, and Keychain access; process execution is limited to the verified Cursor installation, `/usr/bin/security`, and `/usr/bin/git`.
- The Cursor child receives an environment allowlist rather than the host process environment.
- ACP stdio uses strict bounded UTF-8/JSON framing and never logs malformed raw protocol lines. Cordis Fiber disposal owns catalog probes, active prompts, suspended MCP calls, process exit, and private-state removal.
- An adversarial WebFetch canary uses an external request observer and must show no request before exact Cursor artifacts are allowlisted.

Agent Virtualization's outer sandbox is explicitly a no-op for this runtime because macOS forbids nested `sandbox-exec`. The package-owned inner sandbox is mandatory and starts before Cursor ACP.

Cursor requires direct network access to its own service, and the installed ACP build exposes no supported switch that disables every built-in tool. The package therefore contains local Read/Write/Shell side effects with Seatbelt and rejects observed built-in notifications; WebFetch prevention is an empirical, artifact-pinned admission property. It cannot independently distinguish a hypothetical server-side WebFetch multiplexed through Cursor's model service, so new or changed artifacts remain blocked until the external zero-request canary passes.

## Tests

```bash
pnpm typecheck
pnpm test
pnpm build
DSH_CURSOR_E2E=1 pnpm --filter @jeremy9682/dsh-llm-cursor-acp test:e2e
```

The opt-in real suite uses the current Cursor subscription without separate API keys. It verifies native text streaming, a complete DSH Scheduler MCP round trip, Read/WebFetch cancellation, host-home Write denial, and Shell process-exec denial.

The provider pauses its own prompt deadline while a Cursor MCP call is suspended for DSH tool execution, and Agent Virtualization does not add a competing wall-clock deadline. Cursor's HTTP MCP client still has its own implementation limit (observed as `MCP error -32001: Request timed out`, roughly one minute in the admitted build); individual DSH tools must complete within that limit or Cursor receives the MCP timeout as a tool error.

## Upgrade and rollback

Before accepting a new Cursor Agent build, run the complete real E2E suite and add its launcher, bundled Node, and `index.js` SHA-256 values to `VERIFIED_CURSOR_ARTIFACTS` only after all bypass canaries pass.

Rollback to a previous package archive:

```bash
dsh plugin --profile web add /absolute/path/to/previous-package.tgz
```

Or remove the provider:

```bash
dsh plugin --profile web remove @jeremy9682/dsh-llm-cursor-acp
```

Restart the existing Web process after either operation. Existing DSH sessions and logs remain DSH-owned; package catalog cache and temporary runtime directories contain no account credentials.

## License

MIT. Third-party notices are in `THIRD_PARTY_NOTICES.md`.
