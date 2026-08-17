# Cursor ACP provider dispatch prompts

## Architecture review

```text
Read /Users/zihan/Projects/dsh-cursor-codex/docs/cursor-acp-native-provider-plan.md and the existing repository. Read-only task: review the proposed native Cursor ACP LLM provider architecture against the installed DeepSeek Harness 0.1.0-rc.6 type contracts under /Users/zihan/.nvm/versions/node/v22.22.0/lib/node_modules/@deepseek-ai/dsh. Focus on LlmAdapter stream semantics, configurable-provider settings, suspend/resume across DSH tool steps, process lifecycle, and pack/install compatibility. Identify concrete errors or missing edge cases with exact file/API evidence. Do not edit files. Return a prioritized concise report.
```

## Security feasibility review

```text
Read /Users/zihan/Projects/dsh-cursor-codex/docs/cursor-acp-native-provider-plan.md and /Users/zihan/Projects/dsh-cursor-codex/notes/cursor-acp-provider-impl-notes.md. Read-only task: adversarially assess whether the local Cursor CLI ACP build can be made fail-closed so only DSH-backed MCP tools execute. Use the checked-out upstream references in /tmp/agent-virtualization, /tmp/dsh-llm-agent-virtualization, and /tmp/dsh-cursor-acp, plus installed Cursor CLI help/source if useful. Focus on built-in Read/Write/Shell/WebFetch, ACP notification and cancellation ordering, macOS Seatbelt/private-HOME/keychain constraints, and loopback HTTP MCP. Do not read credential contents, do not modify files, and do not run destructive commands. Return enforceable controls, tests, and any fundamental blocker with evidence.
```
