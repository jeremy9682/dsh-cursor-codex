# DSH Cursor plugin community scan

Date: 2026-08-17

## Findings

The DSH community already has a Cursor plugin: [`loeanxi/dsh-cursor-acp`](https://github.com/loeanxi/dsh-cursor-acp). Its README describes a standalone Cursor CLI subagent integration. It exposes a `cursor_agent` tool in chat, lets the user choose the child model/effort, and explicitly says it is **not** a Cursor row in the DSH model picker.

The package metadata confirms it is `dsh-cursor-acp@0.1.0`, with peer dependencies on `@deepseek-ai/dsh-subagent-acp` and `@deepseek-ai/dsh-tool-subagent`: [`package.json`](https://github.com/loeanxi/dsh-cursor-acp/blob/master/package.json).

The community plugin's implementation is centered on `src/prompt.ts`, `src/client/CursorAcpSection.tsx`, and subagent/tool peers: [`source tree`](https://github.com/loeanxi/dsh-cursor-acp/tree/master/src).

Community plugin directories list both that plugin and this repository: [`awesome-deepseek-harness-plugins`](https://github.com/imsai-sh/awesome-deepseek-harness-plugins), [`dsh-plugin-market`](https://github.com/losebird/dsh-plugin-market).

The official DSH repository contains the generic ACP, subagent-ACP, and tool-subagent packages, but its code search has no Cursor-specific adapter: [`official Cursor search`](https://github.com/search?q=repo%3Adeepseek-ai%2Fdeepseek-harness+Cursor&type=code), [`official cursor-acp search`](https://github.com/search?q=repo%3Adeepseek-ai%2Fdeepseek-harness+cursor-acp&type=code). The official ACP package README is [`here`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md).

The community package is available as [`dsh-cursor-acp@0.1.0` on npm](https://www.npmjs.com/package/dsh-cursor-acp), but it is not a drop-in replacement: its package name, install target, peer dependencies, and exported subagent/tool API differ from `@jeremy9682/dsh-llm-cursor-acp`. The local package is intentionally a private GitHub package in the current setup and is not published to npm.

## Comparison with this repository

- `loeanxi/dsh-cursor-acp`: Cursor as a standalone subagent/tool invoked by the current DSH model.
- `jeremy9682/dsh-cursor-codex`: Cursor ACP as a native `cursor-acp` LLM provider, with 35 live Cursor subscription models in the native Models picker, same-prompt DSH Scheduler MCP suspension/resume, Seatbelt containment, artifact admission, and lifecycle/cancellation handling.

Therefore the community does have adjacent and partially equivalent implementations, so the claim should be precise rather than saying there are no similar plugins:

- [`dsh-cursor-acp`](https://github.com/loeanxi/dsh-cursor-acp) is the official-CLI/ACP subagent seam, not a native LLM adapter.
- [`cursor-harness-bridge`](https://github.com/lagran/cursor-harness-bridge) uses `@cursor/sdk` and a custom AgentFactory. Its catalog exposes Cursor models, but its `CursorModelAdapter.stream()` explicitly returns `UNSUPPORTED`, so it is not a normal DSH LLM provider.
- [`dsh-llm-cursor`](https://github.com/NOirBRight/dsh-llm-cursor) is a true Cursor provider over private HTTP/2 Connect+protobuf endpoints. Its own README warns that this may violate Cursor's Terms of Service and may lead to account restriction or banning; it is not an official Cursor CLI/ACP integration.
- [`dsh-cpa-plus`](https://github.com/search?q=dsh-cpa-plus&type=repositories) and [`cursor-harness-bridge`](https://github.com/lagran/cursor-harness-bridge) are additional names surfaced by the scan; `dsh-cpa-plus` was not resolvable as a public repository through the GitHub API.

Our project remains distinct in the specific combination of native DSH LLM adapter, official Cursor CLI over ACP, Cursor subscription model catalog, DSH-owned Tool Scheduler resume, and artifact-pinned macOS containment. It should be presented as one safe/official-surface-oriented implementation among several community approaches, not as the only Cursor integration.

## Local implementation verification

- `main` contains commits `56e4657` (Cursor provider timeout suspension) and `18eaefe` (MCP graceful timeout).
- Source and built `dist` both contain `armPromptTimeout`.
- Installed Web profile contains `@jeremy9682/dsh-llm-cursor-acp@0.1.0` with the same fix.
- Cursor doctor reports `signedIn: true`, `authStatus: verified`, and `defaultModelAvailable: true`.
- 35 cached model configs exist and none contain the removed Agent Virtualization `timeoutMs` field.
- Cursor provider unit suite: 44 passed.

## Caveat

The public web search endpoint was unavailable due to insufficient balance during this scan. The community comparison above uses GitHub's official API and the repositories' own README/package/source files.
