# Cursor ACP provider implementation notes

## Baseline

- Branch: `main` tracking `origin/main`.
- Pre-existing user change: `server/dsh-mcp.mjs` changes timeout teardown from immediate SIGKILL to SIGTERM plus a 30-second SIGKILL fallback. Preserve it; do not edit, revert, stage, or count it as provider work.
- The repository has no local `AGENTS.md`; workspace-global instructions apply.
- The target package boundary will be new; adjacent repositories are read-only references.

## Upstream evidence

- `VitaTsui/dsh-llm-agent-virtualization` at `96abf993f9b411726a307b4f170ac5ee27601650`, MIT.
- `VitaTsui/agent-virtualization` at `3b600ba93a44ccff5a9342a14c8133e0ae93e7ca`, MIT.
- `loeanxi/dsh-cursor-acp` at `cefd6c5dbda2967225dac9f4145da2da8e23fb29`, MIT.
- Official ACP SDK `0.25.1`, Apache-2.0.
- Installed DSH and peer packages: `0.1.0-rc.6`.

## Decisions

- Use the DSH LLM seam, not the subagent seam.
- Reuse the actual `agent-virtualization/model-provider/v1` bridge. The DSH adapter speaks that protocol; the package-owned generic-JSONL runtime translates Cursor ACP and HTTP MCP inside Agent Virtualization rather than inventing another suspension protocol.
- Use Cursor ACP `ask` mode because it permits MCP while reducing mutation-capable built-ins.
- ACP permission for the package-owned MCP server is only a preflight; actual execution remains the MCP `tools/call` request and the DSH scheduler.
- Ordinary ACP `tool_call` updates are never converted to DSH calls.

## Security boundary

- Cursor `ask` mode can attempt built-ins, so ACP cancellation is not the only enforcement layer. The package-owned macOS Seatbelt denies file-data reads and writes by default, admitting system/runtime reads, isolated run state, Cursor's required lock state, and the Keychain path needed for normal login. Arbitrary process execution is denied except the verified Cursor installation, `/usr/bin/security`, and `/usr/bin/git`.
- The child receives an environment allowlist. The official launcher is parsed but never executed; its bundled Node and `index.js` entry are launched directly with the launcher's attribution, system-CA, cache, and `CURSOR_INVOKED_AS` behavior reproduced.
- Admission pins SHA-256 for the launcher, bundled Node, and `index.js`, not only the reported version. The current admitted tuple is build `2026.08.11-e8db854`.
- Cursor requires provider network access and does not expose a supported built-ins-off switch. Local Read/Write/Shell containment is enforced by Seatbelt; WebFetch prevention is an artifact-pinned empirical property backed by a zero-request observer canary. A hypothetical server-side WebFetch multiplexed through Cursor's own model service cannot be independently filtered.

## Implemented

- Native configurable provider `cursor-acp`, dynamic catalog, stable persisted wire-to-ID mappings, tombstones, strict live availability checks, and preferred default ordering.
- Actual `agent-virtualization/model-provider/v1` suspension with a package-owned generic JSONL runtime translating Cursor ACP and private loopback HTTP MCP.
- Exact Host/path/method/content-type/bearer checks, bounded bodies and protocol queues, one pending MCP call, stale/duplicate result rejection, and same-process tool-result resume.
- ACP initialize/session/mode/model/prompt, protocol-version validation, strict bounded framing, explicit model.cancel → run.cancel → session/cancel propagation, bounded post-cancel drain, optional session/close, awaited TERM→KILL fallback, abnormal-exit recovery, and stable DSH errors.
- Agent Loop-only MCP exposure; ordinary ACP `tool_call` updates remain telemetry. Permission preflight is exact-title/kind/location checked but is never treated as execution.
- A browser client extension adds **Settings → Cursor ACP** for path, authentication health, refresh, and preferred default. Live models remain available in the native Models selectors. The UI and CLI expose no credential or account identity.
- Turn-end, session disposal, settings HMR, and plugin Fiber disposal cancel orphaned suspended calls and active prompts. The Fiber also aborts live catalog probes; process exit is awaited before private state deletion.

## Verified

- Secret-free packed `doctor --json` reports the exact compatible artifacts, `authStatus: verified`, Seatbelt, default availability, and 35 live models headed by `cursor-grok-4.6-high`.
- Native text streaming and a complete DSH Scheduler MCP round trip pass under the strict profile. Cursor requested `cursor_scheduler_echo`; DSH persisted `tool/call` and `tool/result`; the same live prompt resumed with `scheduled-by-dsh:roundtrip-ok`.
- Four real security canaries pass: Read produces no protected sentinel and the physical Cursor Node read is denied; host-home Write is physically denied; `/bin/sh` execution is denied; WebFetch produces zero observer requests while a positive control is recorded.
- The unit/protocol/composition suite has 44 passing tests, including strict ACP framing without raw-line logging, queue exhaustion, host spoofing, concurrent MCP calls, stable-ID collision persistence, auth tri-state, catalog-probe abort, prompt/MCP disposal and HMR, cancellation, timeout, malformed protocol, abnormal exit, quota/auth mapping, switching, unknown models, and incompatible artifacts.
- Packed installation into disposable Web and headless profiles succeeds. The archive contains executable CLI/runtime bins and the browser `client.js`; an installed headless profile can select `cursor-acp` as its main model and produce native output.

## Final verification boundary

- Final `pnpm install`, workspace typecheck, 44-test unit/protocol suite, build, native streaming E2E, Scheduler round trip, four security canaries, fresh headless/Web installs, packed doctor, Web composition dump, and packed main-model response all pass after the lifecycle hardening.
- The current port-3080 Web process was not restarted or replaced. Visual mounting of the new settings section therefore remains for the user's eventual normal Web restart; package metadata, browser bundle contents, and disposable Web composition were verified without launching another server.
