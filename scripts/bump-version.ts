#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("usage: bun scripts/bump-version.ts <semver>");
const root = resolve(import.meta.dir, "..");
for (const file of ["package.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json", ".claude-plugin/marketplace.json"]) {
  const path = resolve(root, file);
  const json = JSON.parse(readFileSync(path, "utf8"));
  if (file.endsWith("marketplace.json")) json.plugins.forEach((plugin: { version: string }) => { plugin.version = version; });
  else json.version = version;
  writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
}
console.log(`code-quality ${version}`);
