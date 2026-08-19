# ZCode / Cloud thin gateway

ZCode talks to DeepSeek Harness, `agent-run`, and Cursor ACP over **existing**
MCP / stdio / CLI sockets. This kit does not add a router.

Canon for seats and models remains
[`routing-policy.yaml`](https://github.com/jeremy9682/agent-skill-advisor-layer/blob/main/routing-policy.yaml)
in agent-skill-advisor-layer. The matching wiring essay is
[`docs/zcode-cloud-gateway.md`](https://github.com/jeremy9682/agent-skill-advisor-layer/blob/main/docs/zcode-cloud-gateway.md)
in that repo.

Chinese edition: [`zcode-cloud-gateway.zh.md`](zcode-cloud-gateway.zh.md).

## Install (ZCode on this machine)

1. Merge [`templates/zcode/config.snippet.json`](../templates/zcode/config.snippet.json)
   into `~/.zcode/cli/config.json` (user) or `<repo>/.zcode/config.json`
   (workspace). Replace `/path/to/dsh-cursor-codex` with the real checkout.
2. Copy [`skills/zcode-delegate-to-dsh`](../skills/zcode-delegate-to-dsh)
   into the ZCode skills directory, or invoke it with `$`.
3. Smoke-check the socket (no Cloud, no credentials in output):

```sh
node gateway/local-gateway.mjs doctor
node --test gateway/local-gateway.test.mjs
```

ZCode can also **Import** the existing Cursor MCP server from
`~/.cursor/mcp.json` if `dsh` is already configured there.

## Call

```sh
# DSH worker
node gateway/local-gateway.mjs run --via dsh --cwd /path/to/repo "<task>"

# Governed seat (pass the shape; do not invent one)
node gateway/local-gateway.mjs run --via agent-run \
  --task-shape ordinary_bug_fix --cwd /path/to/repo "<task>"

# Official Cursor ACP (stdio). Requires a signed-in cursor-agent.
node gateway/local-gateway.mjs run --via cursor-acp --cwd /path/to/repo "<task>"
```

Optional loopback HTTP around an existing CLI, using the already-cloned
`coder/agentapi` (not vendored here):

```sh
agentapi server --type=cursor --allowed-hosts localhost -- cursor-agent
```

Do not bind that server to a public host.

## Cloud boundary

`--via cloud` exits `2` with `CLOUD_NO_LOCAL_HTTP`. Cursor Cloud Agents REST
can start a **remote** agent; it cannot open this machine's MCP stdio,
`agent-run`, or `dsh web`. There is no Cloud ACP URL.

## Not in this kit

No new routing YAML. No CCR / RouteLLM / Bifrost. No LiteLLM edits.
`langgenius/mosoo-agent-driver` is a protocol reference only — this wrapper
spawns `dsh` / `agent-run` / `cursor-agent acp` instead of importing that
runtime.
