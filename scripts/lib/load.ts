// The wait before a test run: timing tests on a loaded shared machine go red for no reason in the change.
import { loadavg } from "node:os";
import type { Opts } from "./config.ts";

const POLL_S = 10;

export type LoadDeps = { load: () => number; sleep: (seconds: number) => void; log: (line: string) => void };

// QG_TEST_LOADAVG replaces the reading; it exists for the gate's own tests only.
const readLoad = () => (process.env.QG_TEST_LOADAVG ? Number(process.env.QG_TEST_LOADAVG) : loadavg()[0]);

const defaultDeps: LoadDeps = { load: readLoad, sleep: (seconds) => Bun.sleepSync(seconds * 1000), log: (line) => console.log(line) };

// While the 1-minute load is above [tests] max_load, poll every min(10, remaining) s up to
// [tests] load_wait_s, then run anyway. max_load = 0 turns the wait off; a load of 0 is an OS without
// loadavg, so no wait either. The lines print the last load read.
export function waitForLoad(o: Opts, deps: LoadDeps = defaultDeps) {
  const max = Number(o.toml.tests.max_load);
  const limit = Math.max(0, Number(o.toml.tests.load_wait_s));
  let load = deps.load();
  if (max <= 0 || load === 0 || load <= max) return;
  let waited = 0;
  while (load > max && waited < limit) {
    const step = Math.min(POLL_S, limit - waited);
    deps.sleep(step);
    waited += step;
    load = deps.load();
  }
  if (waited) deps.log(`tests: waited ${waited}s for load ${load.toFixed(1)} (max ${max})`);
  if (load > max) deps.log(`note: tests/load ran at load ${load.toFixed(1)} after ${waited}s`);
}
