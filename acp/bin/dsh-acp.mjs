#!/usr/bin/env node
/**
 * `dsh-acp` — standalone entry for the DeepSeek Harness ACP server.
 *
 * Strategy: run the harness's own ACP surface through a dedicated dsh profile
 * so the server shares $DSH_HOME credentials, presets, and session logs with
 * `dsh web`. If the profile does not exist yet, provision it with this very
 * bundle first (self-healing one-time setup), then boot it.
 *
 * Stdout is reserved for ACP JSON-RPC frames; all diagnostics go to stderr.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PKG = "@jeremy9682/dsh-acp";
const PROFILE = process.env.DSH_ACP_PROFILE ?? "acp";
const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const profileManifest = join(dshHome, "profiles", PROFILE, "package.json");

/** Locate the dsh launcher: PATH first, then npx. */
function findDsh() {
  const probe = spawnSync("dsh", ["--version"], { encoding: "utf8" });
  if (probe.status === 0) return { args: ["dsh"], why: null };
  const probeNpx = spawnSync("npx", ["-y", "@deepseek-ai/dsh", "--version"], { encoding: "utf8" });
  if (probeNpx.status === 0) return { args: ["npx", "-y", "@deepseek-ai/dsh"], why: null };
  return {
    args: null,
    why:
      "dsh not found. Install DeepSeek Harness first:\n" +
      "  npm install -g @deepseek-ai/dsh   (Node.js >= 22.15 required)",
  };
}

function provisionProfile(dshArgs) {
  const run = () =>
    spawnSync(...dshArgs, ["plugin", "--profile", PROFILE, "add", PKG], { stdio: "inherit" });
  let result = run();
  if (result.status !== 0) {
    // The first install commonly stops on pnpm's ignored-build gate for the
    // koffi native dependency. The profile template ships an allowBuilds
    // placeholder in pnpm-workspace.yaml; approve it and retry once.
    const workspaceFile = join(dshHome, "profiles", PROFILE, "pnpm-workspace.yaml");
    try {
      const text = readFileSync(workspaceFile, "utf8");
      const approved = text.replace(/^(\s{2}koffi:\s*).*$/m, "$1true");
      if (approved !== text) {
        writeFileSync(workspaceFile, approved);
        process.stderr.write("dsh-acp: approved koffi build in pnpm-workspace.yaml — retrying install\n");
        result = run();
      }
    } catch {
      // workspace file missing or unreadable; fall through to the error path
    }
  }
  if (result.status !== 0) {
    process.stderr.write(
      `dsh-acp: could not provision the '${PROFILE}' profile. ` +
        "Manual equivalent (needs pnpm):\n" +
        `  dsh plugin --profile ${PROFILE} add ${PKG}\n` +
        `  # if pnpm blocks native builds: set allowBuilds.koffi: true in\n` +
        `  # ${join(dshHome, "profiles", PROFILE, "pnpm-workspace.yaml")} and re-run\n`,
    );
    process.exit(result.status ?? 1);
  }
}

const located = findDsh();
if (located.args === null) {
  process.stderr.write(`dsh-acp: ${located.why}\n`);
  process.exit(127);
}

if (!existsSync(profileManifest)) {
  process.stderr.write(
    `dsh-acp: profile '${PROFILE}' not found — provisioning with ${PKG} ...\n`,
  );
  provisionProfile(located.args);
}

process.stderr.write(`dsh-acp: booting dsh --profile ${PROFILE} (DSH_HOME=${dshHome})\n`);
const child = spawn(...located.args, ["--profile", PROFILE], {
  stdio: ["inherit", "inherit", "inherit"],
});
child.on("error", (error) => {
  process.stderr.write(`dsh-acp: failed to start dsh: ${error.message}\n`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
