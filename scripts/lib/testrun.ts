// The one executor of every test run the gate starts (full gate, check --tests, pre-push, mutant):
// load wait, a shell writing to a log, elapsed time, exit decoding. A run with a timeout (touched,
// pre-push, mutant) gets its own process group, and the timeout kills the group and waits for it; the
// full run has no timeout and no group, as before. A log or launch failure throws: it is a CLI error.
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { constants } from "node:os";
import { dirname } from "node:path";
import type { Opts } from "./config.ts";
import { waitForLoad } from "./load.ts";
import { withoutRepoVars } from "./util.ts";

// timeoutS: Infinity = no timeout and no process group (the full gate).
export type RunSpec = { cmd: string; log: string; timeoutS: number; env?: NodeJS.ProcessEnv };
export type RunResult = { code: number; timedOut: boolean; secs: string; log: string };
export type TestRun = { done: Promise<RunResult>; kill: () => Promise<void> };

const GONE_WAIT_MS = 5000;

export function startTestRun(o: Opts, spec: RunSpec): TestRun {
  waitForLoad(o);
  mkdirSync(dirname(spec.log), { recursive: true });
  const fd = openSync(spec.log, "w");
  const t0 = Date.now();
  const grouped = Number.isFinite(spec.timeoutS);
  let child;
  try {
    child = spawn("sh", ["-c", spec.cmd], { cwd: o.repo, env: withoutRepoVars(spec.env ?? process.env), detached: grouped, stdio: ["ignore", fd, fd] });
  } finally {
    closeSync(fd);
  }
  const pid = grouped ? child.pid : undefined;
  let timedOut = false;
  const kill = async () => {
    if (pid) await killGroup(pid);
  };
  const timer = grouped ? setTimeout(() => {
    timedOut = true;
    void kill();
  }, spec.timeoutS * 1000) : null;
  const done = new Promise<RunResult>((resolve, reject) => {
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(new Error(`cannot start the test command (${spec.cmd}): ${error.message}`));
    });
    child.on("exit", (code, signal) => {
      if (timer) clearTimeout(timer);
      const finish = () => resolve({ code: code ?? 128 + (signal ? constants.signals[signal] : 0), timedOut, secs: ((Date.now() - t0) / 1000).toFixed(1), log: spec.log });
      if (timedOut && pid) void killGroup(pid).then(finish);
      else finish();
    });
  });
  return { done, kill };
}

export const runTestProcess = (o: Opts, spec: RunSpec) => startTestRun(o, spec).done;

// SIGKILL to the whole group, then wait until no member is left (bounded).
async function killGroup(pid: number) {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    return;
  }
  const until = Date.now() + GONE_WAIT_MS;
  while (Date.now() < until && groupAlive(pid)) await Bun.sleep(20);
}

function groupAlive(pid: number) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}
