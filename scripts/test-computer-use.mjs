#!/usr/bin/env node

import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(root, "packages", "pi-computer-use");
const output = await mkdtemp(join(root, ".test-computer-use-"));

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

try {
  run(process.execPath, [
    join(root, "node_modules", "typescript", "bin", "tsc"),
    "-p",
    join(packageRoot, "tsconfig.json"),
    "--outDir",
    output,
    "--rootDir",
    packageRoot,
  ]);
  run(process.execPath, ["--test", join(output, "tests", "computer-use.test.js")]);
} finally {
  await rm(output, { recursive: true, force: true });
}
