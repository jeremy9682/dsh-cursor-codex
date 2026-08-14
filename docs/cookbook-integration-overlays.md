# Cookbook: DSH integration overlays

Battle-tested overlay recipes from a real `$DSH_HOME` (`~/.dsh/experiments/`). Each overlay is a patch list you apply with `--patch` (or merge into a profile's `cordis.patch.yml`). They layer over the headless/web profile bundles without changing them.

## 1. Codex as a DSH subagent provider

File: `experiments/codex-overlay.yml`

```yaml
- insert:
    - id: subagent-codex
      name: '@deepseek-ai/dsh-subagent-codex'
- id: tool-subagent
  config:
    provider: codex
    toolName: subagent
    backgroundMode: one-shot
    maxDepth: provider-managed
```

What it does: registers the official Codex subagent provider and re-points the `subagent` tool at it. Every delegation becomes an out-of-process Codex run (the provider spawns Codex itself), while DSH keeps running on DeepSeek. This is the **reverse direction** of this kit's main flow: here DSH calls Codex.

Run it:

```sh
dsh --profile headless --patch ~/.dsh/experiments/codex-overlay.yml "<task>"
```

Notes:

- `codex` must be on PATH and logged in (`codex login`).
- An id-targeted patch replaces the whole `tool-subagent` config — restate every field you keep.
- `maxDepth: provider-managed` lets the Codex provider govern its own nesting; cap it explicitly if you want a ceiling.

## 2. Route a third-party LLM adapter to DeepSeek (pi-ai)

File: `experiments/pi-ai-overlay.yml`

```yaml
- id: llm-pi-ai
  config:
    providers:
      deepseek:
        apiKeyEnv: DEEPSEEK_API_KEY
        baseURL: https://api.deepseek.com
        models:
          - id: deepseek-v4-flash
            contextWindow: 128000
- id: agent-default-model
  config:
    provider: deepseek
    model: deepseek-v4-flash
```

What it does: takes a third-party LLM adapter (`@deepseek-ai/dsh-llm-pi-ai`) and gives it a real provider route pointing at the **DeepSeek API**, then re-points the agent's default model at it. The whole agent loop then flows through the pi-ai adapter instead of the native `llm-deepseek` one.

The pattern generalizes to any adapter that takes a `providers` map: point the adapter at any OpenAI-compatible endpoint, then flip `agent-default-model`. Use it when you want a non-native adapter's semantics (different tool-call conventions, reasoning controls) while still paying DeepSeek.

Run it:

```sh
dsh --profile headless --patch ~/.dsh/experiments/pi-ai-overlay.yml "<task>"
```

## 3. Codex provider rehearsal on a second Web port

File: `experiments/web-demo-overlay.yml`

```yaml
- insert:
    - id: subagent-codex
      name: '@deepseek-ai/dsh-subagent-codex'
```

What it does: inserts the Codex subagent provider only — the `subagent` tool stays on its default provider. Used to rehearse the provider inside the Web UI on a separate port so the live instance stays untouched:

```sh
dsh web --port 3082 --patch ~/.dsh/experiments/web-demo-overlay.yml
```

Never run the rehearsal on the live port (3080) — the overlay changes a live profile's composition.

## 4. External seats: Codex / Cursor as DSH collaborators

The overlays above are one side of a two-way arrangement this kit grew out of. In production setups:

- **DSH → Codex**: Codex acts as a delegated seat through `dsh-subagent-codex` (overlay 1) or as an LLM provider (OAuth).
- **DSH → Cursor**: same pattern with the ACP subagent provider driving `cursor-agent acp` (`@deepseek-ai/dsh-subagent-acp`), or the `cursor_delegate` tool from the [dsh-observability](https://github.com/jeremy9682/dsh-observability) kit.
- **Codex / Cursor → DSH**: the main direction of this kit — ACP profile (Zed/JetBrains), MCP server (`dsh_delegate`), or the headless CLI.

Operational rules that survived real use:

1. **One session, one seat.** Each delegation spawns a fresh process with its own session; never assume shared conversation state across the boundary.
2. **Verify, don't trust.** A delegated seat's report is input for review, not proof — check the files/diff it changed.
3. **Credentials stay home.** DSH reads its own store; pass nothing secret in task text or overlay config.
4. **Rehearse on a second port.** Any composition experiment that touches live sessions gets its own port/profile first.
