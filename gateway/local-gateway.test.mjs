import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CLOUD_ERROR,
  parseArgs,
  doctor,
  run,
  cloudMessage,
  usage,
} from "./local-gateway.mjs";

test("parseArgs reads via, cwd, task-shape, write, and task", () => {
  const parsed = parseArgs([
    "node",
    "local-gateway.mjs",
    "run",
    "--via",
    "agent-run",
    "--cwd",
    "/tmp/repo",
    "--task-shape",
    "ordinary_bug_fix",
    "--write",
    "fix the flaky test",
  ]);
  assert.equal(parsed.command, "run");
  assert.equal(parsed.via, "agent-run");
  assert.equal(parsed.cwd, "/tmp/repo");
  assert.equal(parsed.taskShape, "ordinary_bug_fix");
  assert.equal(parsed.write, true);
  assert.equal(parsed.task, "fix the flaky test");
});

test("unknown flag fails closed", () => {
  assert.throws(() => parseArgs(["node", "gw", "run", "--router", "ccr"]), /unknown flag/);
});

test("cloud via is rejected with CLOUD_NO_LOCAL_HTTP", async () => {
  const result = await run({ via: "cloud", task: "hello", timeoutMs: 1000 });
  assert.equal(result.ok, false);
  assert.equal(result.code, CLOUD_ERROR);
  assert.match(result.text, /CLOUD_NO_LOCAL_HTTP/);
  assert.match(result.text, /not a local gateway/i);
  assert.match(cloudMessage(), /127\.0\.0\.1/);
});

test("doctor reports Cloud as unreachable and does not invent a router", () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "gw-doc-"));
  const report = doctor({ PATH: "/nonexistent", HOME: fakeHome }, fakeHome);
  assert.equal(report.cloud.local_http, false);
  assert.equal(report.cloud.acp, false);
  assert.equal(report.cloud.code, CLOUD_ERROR);
  assert.equal(report.canon.includes("routing-policy.yaml"), true);
  assert.equal(report.ok, false);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes("ANTHROPIC_API_KEY"), false);
  assert.equal(serialized.includes("CURSOR_API_KEY"), false);
  assert.equal(usage().includes("CCR"), false);
});

test("doctor sees a stub dsh on PATH without leaking env secrets", () => {
  const binDir = mkdtempSync(join(tmpdir(), "gw-bin-"));
  const stub = join(binDir, "dsh");
  writeFileSync(stub, "#!/bin/sh\necho dsh-stub-0.0.0\n");
  chmodSync(stub, 0o755);
  const fakeHome = mkdtempSync(join(tmpdir(), "gw-home-"));
  const report = doctor(
    {
      PATH: binDir,
      HOME: fakeHome,
      DSH_BIN: stub,
      ANTHROPIC_API_KEY: "sk-secret-must-not-leak",
    },
    fakeHome,
  );
  assert.equal(report.surfaces.dsh.ok, true);
  assert.match(report.surfaces.dsh.version, /dsh-stub/);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes("sk-secret-must-not-leak"), false);
});
