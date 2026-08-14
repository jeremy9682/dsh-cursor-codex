#!/usr/bin/env node
/**
 * dsh-mcp — a zero-dependency MCP stdio server exposing DeepSeek Harness to
 * MCP clients (Cursor, Codex, Claude Desktop, ...).
 *
 * Tools:
 *   dsh_delegate  run one task through `dsh --profile headless`, return the
 *                 final assistant text (and stderr tail on failure)
 *   dsh_health    report dsh availability, version, and profile presence
 *
 * Stdout carries only MCP JSON-RPC frames; diagnostics go to stderr.
 * Run: node server/dsh-mcp.mjs   (env: DSH_HOME optional, DSH_MCP_PROFILE optional)
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const NAME = "dsh-mcp";
const VERSION = "0.1.0";
const MCP_PROTOCOL = "2024-11-05";
const PROFILE = process.env.DSH_MCP_PROFILE ?? "headless";
const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function log(message) {
  process.stderr.write(`[${NAME}] ${message}\n`);
}

function findDsh() {
  const probe = spawnSyncProbe(["dsh", "--version"]);
  if (probe.ok) return { args: ["dsh"], version: probe.version };
  const npxProbe = spawnSyncProbe(["npx", "-y", "@deepseek-ai/dsh", "--version"]);
  if (npxProbe.ok) return { args: ["npx", "-y", "@deepseek-ai/dsh"], version: npxProbe.version };
  return { args: null, version: null };
}

function spawnSyncProbe(args) {
  const result = spawnSync(args[0], args.slice(1), { encoding: "utf8", timeout: 30000 });
  if (result.status !== 0) return { ok: false, version: null };
  const version = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split("\n")[0];
  return { ok: true, version: version || "unknown" };
}

const dsh = findDsh();

/** Run one dsh headless task; resolve { ok, text, code, timedOut }. */
function runHeadless(task, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(...dsh.args, ["--profile", PROFILE, task], {
      cwd: cwd || undefined,
      env: { ...process.env, DSH_HOME: dshHome },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({
        ok: false,
        code: null,
        timedOut: true,
        text: `dsh task timed out after ${timeoutMs} ms. Partial output:\n${stdout.slice(-4000)}`,
      });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: null, timedOut: false, text: `failed to start dsh: ${error.message}` });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const answer = stdout.trim();
      if (code === 0 && answer.length > 0) resolve({ ok: true, code, timedOut: false, text: answer });
      else
        resolve({
          ok: false,
          code,
          timedOut: false,
          text: `dsh exited with code ${code}. stderr tail:\n${stderr.slice(-4000)}\nstdout tail:\n${stdout.slice(-2000)}`,
        });
    });
  });
}

const tools = [
  {
    name: "dsh_delegate",
    description:
      "Run one task through DeepSeek Harness headless (`dsh --profile headless`) and return the final assistant text. Use for delegating a self-contained coding, research, or analysis task to the DeepSeek-powered agent. One task per call; results are the committed final answer, not a live transcript.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "The complete task for the DSH agent." },
        cwd: {
          type: "string",
          description: "Optional absolute working directory for the task. Defaults to the MCP server's cwd.",
        },
        timeout_ms: {
          type: "integer",
          description: `Optional timeout in milliseconds. Default ${DEFAULT_TIMEOUT_MS}.`,
          default: DEFAULT_TIMEOUT_MS,
        },
      },
      required: ["task"],
    },
  },
  {
    name: "dsh_health",
    description: "Report DeepSeek Harness availability: launcher path, version, profile presence, and DSH_HOME.",
    inputSchema: { type: "object", properties: {} },
  },
];

function health() {
  const profileManifest = join(dshHome, "profiles", PROFILE, "package.json");
  return {
    ok: dsh.args !== null,
    version: dsh.version,
    dsh_home: dshHome,
    profile: PROFILE,
    profile_present: existsSync(profileManifest),
    acp_profile_present: existsSync(join(dshHome, "profiles", "acp", "package.json")),
  };
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return; // not JSON-RPC on stdin; ignore
  }
  void handle(request);
});

async function handle(request) {
  const { id, method, params } = request ?? {};
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: MCP_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: NAME, version: VERSION },
      },
    });
    return;
  }
  if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools } });
    return;
  }
  if (method === "tools/call") {
    const toolName = params?.name;
    const args = params?.arguments ?? {};
    let content;
    let isError = false;
    try {
      if (toolName === "dsh_delegate") {
        if (dsh.args === null) {
          content = "dsh is not installed. Run: npm install -g @deepseek-ai/dsh (Node.js >= 22.15).";
          isError = true;
        } else if (typeof args.task !== "string" || args.task.trim() === "") {
          content = "`task` must be a non-empty string.";
          isError = true;
        } else {
          const timeoutMs = Number.isInteger(args.timeout_ms) && args.timeout_ms > 0 ? args.timeout_ms : DEFAULT_TIMEOUT_MS;
          const result = await runHeadless(args.task.trim(), typeof args.cwd === "string" ? args.cwd : null, timeoutMs);
          content = result.text;
          isError = !result.ok;
        }
      } else if (toolName === "dsh_health") {
        content = JSON.stringify(health(), null, 2);
      } else {
        content = `unknown tool: ${toolName}`;
        isError = true;
      }
    } catch (error) {
      content = `tool error: ${error.message}`;
      isError = true;
    }
    send({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: content }], isError },
    });
    return;
  }
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
}

log(`ready (dsh: ${dsh.args !== null ? dsh.args.join(" ") : "NOT FOUND"}, DSH_HOME=${dshHome}, profile=${PROFILE})`);
