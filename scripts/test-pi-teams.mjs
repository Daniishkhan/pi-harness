#!/usr/bin/env node
// Runs each vendored pi-teams phase suite. The suites are plain scripts that
// exit non-zero on failure, so run them sequentially and stop on first failure.

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = join(root, "packages", "pi-teams");
const testDir = join(packageDir, "test");

const phases = readdirSync(testDir)
  .filter((name) => /^phase\d+\.test\.ts$/.test(name))
  .sort();

if (phases.length === 0) {
  console.error("pi-teams: no phase suites found");
  process.exit(1);
}

for (const phase of phases) {
  const result = spawnSync(process.execPath, [join("test", phase)], {
    cwd: packageDir,
    stdio: "inherit",
  });
  if (result.error || result.status !== 0) {
    console.error(`pi-teams: ${phase} failed`);
    process.exit(result.status ?? 1);
  }
}

console.log(`pi-teams: all ${phases.length} phase suites passed`);
