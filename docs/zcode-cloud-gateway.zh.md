# ZCode / Cloud 薄网关

ZCode 用**现成** MCP / stdio / CLI 接到 DeepSeek Harness、`agent-run`、Cursor ACP。
本工具包不增加路由器。

席位与模型的 canon 仍是 agent-skill-advisor-layer 的
[`routing-policy.yaml`](https://github.com/jeremy9682/agent-skill-advisor-layer/blob/main/routing-policy.yaml)。
接线长文在那边的
[`docs/zcode-cloud-gateway.md`](https://github.com/jeremy9682/agent-skill-advisor-layer/blob/main/docs/zcode-cloud-gateway.md)。

英文版：[`zcode-cloud-gateway.md`](zcode-cloud-gateway.md)。

## 安装（本机 ZCode）

1. 把 [`templates/zcode/config.snippet.json`](../templates/zcode/config.snippet.json)
   合并进 `~/.zcode/cli/config.json`（用户级）或 `<repo>/.zcode/config.json`
   （工作区）。把 `/path/to/dsh-cursor-codex` 换成真实路径。
2. 把 [`skills/zcode-delegate-to-dsh`](../skills/zcode-delegate-to-dsh)
   拷进 ZCode skills 目录，或用 `$` 点名。
3. 自检插座（不打 Cloud、输出不含凭据）：

```sh
node gateway/local-gateway.mjs doctor
node --test gateway/local-gateway.test.mjs
```

若 Cursor 已经配了 `dsh` MCP，ZCode 也可以从 `~/.cursor/mcp.json` **导入**。

## 调用

```sh
# DSH worker
node gateway/local-gateway.mjs run --via dsh --cwd /path/to/repo "<任务>"

# 过席位 canon（形状由调用方传入，网关不猜）
node gateway/local-gateway.mjs run --via agent-run \
  --task-shape ordinary_bug_fix --cwd /path/to/repo "<任务>"

# 官方 Cursor ACP（stdio）。需要已登录的 cursor-agent。
node gateway/local-gateway.mjs run --via cursor-acp --cwd /path/to/repo "<任务>"
```

可选：用已收藏的 `coder/agentapi` 把现有 CLI 包成本机 HTTP（不要对公网暴露）：

```sh
agentapi server --type=cursor --allowed-hosts localhost -- cursor-agent
```

## Cloud 边界

`--via cloud` 以退出码 `2` 失败，错误码 `CLOUD_NO_LOCAL_HTTP`。
Cursor Cloud Agents REST 只能拉起**远端** agent，打不到本机 MCP stdio、
`agent-run` 或 `dsh web`。没有 Cloud ACP URL。

## 本工具包不做

不新写 routing YAML。不引入 CCR / RouteLLM / Bifrost。不改 LiteLLM。
`langgenius/mosoo-agent-driver` 只作协议对照——这里只 spawn `dsh` /
`agent-run` / `cursor-agent acp`，不搬它的 runtime。
