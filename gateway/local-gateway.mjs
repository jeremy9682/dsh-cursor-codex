#!/usr/bin/env node
/**
 * Thin local socket over existing CLIs. Not a router.
 *
 * Surfaces:
 *   dsh          `dsh --profile headless`
 *   agent-run    ADV `routing-policy.yaml` via `agent-run run auto`
 *   cursor-acp   official `cursor-agent acp` (stdio JSON-RPC)
 *
 * Cloud is not a surface: no local HTTP/ACP socket. `--via cloud` exits 2.
 *
 * Stdout: result text or doctor JSON. Diagnostics on stderr.
 * Never prints credentials, account emails, or raw env values.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

export const NAME = "local-gateway";
export const VERSION = "0.1.0";
export const CLOUD_ERROR = "CLOUD_NO_LOCAL_HTTP";
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const GRACE_AFTER_SIGTERM_MS = 30 * 1000;
const VIAS = new Set(["dsh", "agent-run", "cursor-acp"]);

export function cloudMessage() {
  return [
    `${CLOUD_ERROR}: Cursor Cloud is not a local gateway.`,
    "ACP is stdio on this machine (`cursor-agent acp`).",
    "The Cloud Agents REST API launches a remote sandbox and cannot reach",
    "127.0.0.1 agent-run, dsh web, or MCP stdio.",
    "Use --via dsh | agent-run | cursor-acp.",
  ].join(" ");
}

export function usage() {
  return `Usage:
  node gateway/local-gateway.mjs doctor
  node gateway/local-gateway.mjs run --via dsh|agent-run|cursor-acp [--cwd DIR] [--timeout-ms N] [--task-shape SHAPE] [--write] TASK

doctor  Probe local binaries. Never talks to Cursor Cloud.
run     Spawn an existing CLI. Does not classify tasks; pass --task-shape through to agent-run.

Canon: agent-skill-advisor-layer/routing-policy.yaml via agent-run.
`;
}

export function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    command: args[0] ?? "help",
    via: null,
    cwd: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    taskShape: null,
    write: false,
    task: "",
  };
  const rest = [];
  for (let i = 1; i < args.length; i += 1) {
    const token = args[i];
    if (token === "--via") {
      out.via = args[++i] ?? null;
    } else if (token === "--cwd") {
      out.cwd = args[++i] ?? null;
    } else if (token === "--timeout-ms") {
      out.timeoutMs = Number(args[++i]);
    } else if (token === "--task-shape") {
      out.taskShape = args[++i] ?? null;
    } else if (token === "--write") {
      out.write = true;
    } else if (token === "--help" || token === "-h") {
      out.command = "help";
    } else if (token.startsWith("-")) {
      throw new Error(`unknown flag: ${token}`);
    } else {
      rest.push(token);
    }
  }
  out.task = rest.join(" ").trim();
  if (Number.isNaN(out.timeoutMs) || out.timeoutMs <= 0) {
    out.timeoutMs = DEFAULT_TIMEOUT_MS;
  }
  return out;
}

function firstLine(text) {
  return String(text ?? "")
    .trim()
    .split("\n")[0]
    .slice(0, 240);
}

function probeCommand(args, extraEnv = {}) {
  const result = spawnSync(args[0], args.slice(1), {
    encoding: "utf8",
    timeout: 15000,
    env: { ...process.env, ...extraEnv },
  });
  const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return {
    ok: result.status === 0,
    version: result.status === 0 ? firstLine(combined) || "unknown" : null,
    error: result.status === 0 ? null : firstLine(combined) || `exit ${result.status}`,
  };
}

function lookOnPath(name, envPath) {
  if (!name) return null;
  if (name.includes("/")) return existsSync(name) ? name : null;
  const dirs = String(envPath ?? "").split(":").filter(Boolean);
  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function resolveBinaries(env = process.env, home = homedir()) {
  const path = env.PATH;
  const dsh = env.DSH_BIN || lookOnPath("dsh", path) || null;
  const agentRun = env.AGENT_RUN_BIN || lookOnPath("agent-run", path) || null;
  const cursorAcp =
    env.CURSOR_ACP_COMMAND ||
    lookOnPath("cursor-agent", path) ||
    (existsSync(join(home, ".local/bin/cursor-agent"))
      ? join(home, ".local/bin/cursor-agent")
      : null);
  const mcp = join(dirname(fileURLToPath(import.meta.url)), "..", "server", "dsh-mcp.mjs");
  return {
    dsh,
    agentRun,
    cursorAcp,
    mcp: existsSync(mcp) ? mcp : null,
  };
}

export function doctor(env = process.env, home = homedir()) {
  const bins = resolveBinaries(env, home);
  const dsh = bins.dsh
    ? { command: bins.dsh, ...probeCommand([bins.dsh, "--version"]) }
    : { command: null, ok: false, version: null, error: "not on PATH" };
  const agentRun = bins.agentRun
    ? { command: bins.agentRun, ...probeCommand([bins.agentRun, "doctor"]) }
    : { command: null, ok: false, version: null, error: "not on PATH" };
  if (agentRun.ok) {
    const ver = agentRun.version || "";
    agentRun.version = ver.startsWith("{") || ver.startsWith("[") ? "agent-run doctor ok" : ver;
  }
  const cursorAcp = bins.cursorAcp
    ? { command: bins.cursorAcp, ...probeCommand([bins.cursorAcp, "--version"]) }
    : { command: null, ok: false, version: null, error: "cursor-agent not found" };
  const mcp = {
    command: bins.mcp,
    ok: Boolean(bins.mcp),
    version: bins.mcp ? "dsh-mcp.mjs" : null,
    error: bins.mcp ? null : "server/dsh-mcp.mjs missing",
  };
  const surfacesOk = dsh.ok || agentRun.ok || cursorAcp.ok;
  return {
    ok: surfacesOk,
    name: NAME,
    version: VERSION,
    canon: "agent-skill-advisor-layer/routing-policy.yaml via agent-run",
    cloud: {
      local_http: false,
      acp: false,
      code: CLOUD_ERROR,
      reason:
        "Cursor Cloud has no local ACP/HTTP socket; api.cursor.com remote agents cannot reach 127.0.0.1",
    },
    surfaces: {
      dsh,
      "agent-run": agentRun,
      "cursor-acp": cursorAcp,
      "dsh-mcp": mcp,
    },
  };
}

function log(message) {
  process.stderr.write(`[${NAME}] ${message}\n`);
}

function spawnCaptured(command, args, { cwd, timeoutMs, env }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: cwd || undefined,
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let killTimer = null;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      log(`timed out after ${timeoutMs} ms; SIGTERM pid ${child.pid}`);
      try {
        child.kill("SIGTERM");
      } catch (error) {
        log(`SIGTERM failed: ${error.message}`);
      }
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch (error) {
          log(`SIGKILL failed: ${error.message}`);
        }
      }, GRACE_AFTER_SIGTERM_MS);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      settle({ ok: false, code: null, timedOut: false, text: `failed to start: ${error.message}` });
    });
    child.on("close", (code) => {
      if (timedOut) {
        settle({
          ok: false,
          code,
          timedOut: true,
          text: `timed out after ${timeoutMs} ms.\n${stdout.slice(-4000)}`,
        });
        return;
      }
      const answer = stdout.trim();
      if (code === 0 && answer.length > 0) {
        settle({ ok: true, code, timedOut: false, text: answer });
        return;
      }
      settle({
        ok: false,
        code,
        timedOut: false,
        text: `exited ${code}. stderr tail:\n${stderr.slice(-4000)}\nstdout tail:\n${stdout.slice(-2000)}`,
      });
    });
  });
}

async function runDsh(task, cwd, timeoutMs) {
  const bins = resolveBinaries();
  if (!bins.dsh) {
    return { ok: false, text: "dsh is not installed. npm install -g @deepseek-ai/dsh" };
  }
  return spawnCaptured(bins.dsh, ["--profile", "headless", task], { cwd, timeoutMs });
}

async function runAgentRun(task, cwd, timeoutMs, taskShape, write) {
  const bins = resolveBinaries();
  if (!bins.agentRun) {
    return { ok: false, text: "agent-run is not on PATH. See agent-skill-advisor-layer/docs/provider-orchestration.md" };
  }
  const args = ["run", "auto"];
  if (taskShape) args.push("--task-shape", taskShape);
  if (cwd) args.push("--cwd", cwd);
  if (write) args.push("--mode", "execute", "--allow-write", "--trust-workspace");
  args.push(task);
  return spawnCaptured(bins.agentRun, args, { cwd, timeoutMs });
}

function sendAcp(stdin, id, method, params) {
  stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
}

function respondAcp(stdin, id, result) {
  stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

async function runCursorAcp(task, cwd, timeoutMs) {
  const bins = resolveBinaries();
  if (!bins.cursorAcp) {
    return { ok: false, text: "cursor-agent not found. Install Cursor Agent CLI and sign in." };
  }
  return new Promise((resolve) => {
    const child = spawn(bins.cursorAcp, ["acp"], {
      cwd: cwd || undefined,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let nextId = 1;
    const pending = new Map();
    let assistant = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdin.end();
      } catch {
        // already closed
      }
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
      resolve(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      settle({
        ok: false,
        timedOut: true,
        text: `cursor-acp timed out after ${timeoutMs} ms.\n${assistant.slice(-4000)}`,
      });
    }, timeoutMs);

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      settle({ ok: false, text: `failed to start cursor-agent acp: ${error.message}` });
    });
    child.on("close", (code) => {
      if (settled) return;
      if (timedOut) return;
      const text = assistant.trim();
      if (code === 0 && text) {
        settle({ ok: true, text });
        return;
      }
      settle({
        ok: false,
        text: `cursor-acp exited ${code}. stderr tail:\n${stderr.slice(-4000)}\nassistant tail:\n${text.slice(-2000)}`,
      });
    });

    const request = (method, params) => {
      const id = nextId;
      nextId += 1;
      sendAcp(child.stdin, id, method, params);
      return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
    };

    const rl = createInterface({ input: child.stdout, terminal: false });
    rl.on("line", (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.id != null && (Object.hasOwn(msg, "result") || Object.hasOwn(msg, "error"))) {
        const waiter = pending.get(msg.id);
        if (!waiter) return;
        pending.delete(msg.id);
        if (msg.error) waiter.reject(msg.error);
        else waiter.resolve(msg.result);
        return;
      }
      if (msg.method === "session/update") {
        const update = msg.params?.update;
        const chunk =
          update?.content?.text ||
          update?.agentMessageChunk?.content?.text ||
          (update?.sessionUpdate === "agent_message_chunk" ? update.content?.text : null);
        if (typeof chunk === "string") assistant += chunk;
        return;
      }
      if (msg.method === "session/request_permission") {
        respondAcp(child.stdin, msg.id, { outcome: { outcome: "selected", optionId: "allow-once" } });
        return;
      }
      if (msg.method === "cursor/ask_question") {
        respondAcp(child.stdin, msg.id, { outcome: { outcome: "skipped", reason: "local-gateway one-shot" } });
        return;
      }
      if (msg.method === "cursor/create_plan") {
        respondAcp(child.stdin, msg.id, { outcome: { outcome: "accepted" } });
      }
    });

    (async () => {
      try {
        await request("initialize", {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: NAME, version: VERSION },
        });
        try {
          await request("authenticate", { methodId: "cursor_login" });
        } catch {
          // already signed in is fine; session/new will fail closed otherwise
        }
        const session = await request("session/new", { cwd: cwd || process.cwd(), mcpServers: [] });
        const result = await request("session/prompt", {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: task }],
        });
        const text = assistant.trim();
        settle({
          ok: Boolean(text),
          text: text || `cursor-acp stopReason=${result?.stopReason ?? "unknown"} (empty assistant text)`,
        });
      } catch (error) {
        const detail = error?.message || error?.data || JSON.stringify(error);
        settle({
          ok: false,
          text: `cursor-acp protocol error: ${detail}\nstderr tail:\n${stderr.slice(-2000)}`,
        });
      }
    })();
  });
}

export async function run(options) {
  const via = options.via;
  if (via === "cloud" || via === "cursor-cloud") {
    return { ok: false, code: CLOUD_ERROR, text: cloudMessage() };
  }
  if (!VIAS.has(via)) {
    return { ok: false, text: `unknown --via ${via}. Use dsh | agent-run | cursor-acp.` };
  }
  if (!options.task) {
    return { ok: false, text: "TASK is required" };
  }
  if (via === "dsh") return runDsh(options.task, options.cwd, options.timeoutMs);
  if (via === "agent-run") {
    return runAgentRun(options.task, options.cwd, options.timeoutMs, options.taskShape, options.write);
  }
  return runCursorAcp(options.task, options.cwd, options.timeoutMs);
}

export async function main(argv = process.argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n${usage()}`);
    return 2;
  }
  if (options.command === "help" || options.command === "--help" || options.command === "-h") {
    process.stdout.write(usage());
    return 0;
  }
  if (options.command === "doctor") {
    const report = doctor();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.ok ? 0 : 1;
  }
  if (options.command !== "run") {
    process.stderr.write(usage());
    return 2;
  }
  const result = await run(options);
  process.stdout.write(`${result.text}\n`);
  if (result.code === CLOUD_ERROR) return 2;
  return result.ok ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  main().then((code) => {
    process.exit(code);
  });
}
