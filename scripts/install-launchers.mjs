#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureSafeSymlink } from "../lib/profile-home.mjs";
import { resolveHarnessPaths } from "../lib/paths.mjs";

export async function installLaunchers(options = {}) {
  const paths = options.paths ?? resolveHarnessPaths(options.env ?? process.env, options.pathOverrides);
  await mkdir(paths.launcherBinDir, { recursive: true, mode: 0o700 });
  const piRun = join(paths.repoRoot, "bin", "pi-run.mjs");
  const piCell = join(paths.repoRoot, "bin", "pi-cell.mjs");
  const doctor = join(paths.repoRoot, "scripts", "doctor.mjs");
  await Promise.all([chmod(piRun, 0o755), chmod(piCell, 0o755), chmod(doctor, 0o755)]);
  const launchers = {
    "pi-run": piRun,
    "pi-eng": piRun,
    "pi-design": piRun,
    "pi-research": piRun,
    "pi-learn": piRun,
    "pi-cell": piCell,
    "pi-doctor": doctor,
  };
  const installed = [];
  for (const [name, target] of Object.entries(launchers)) {
    installed.push(await ensureSafeSymlink(join(paths.launcherBinDir, name), target, { targetKind: "file" }));
  }
  return installed;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
if (isMain) {
  try {
    const installed = await installLaunchers();
    for (const entry of installed) {
      process.stdout.write(`${entry.changed ? "installed" : "verified"} ${entry.path} -> ${entry.target}\n`);
    }
  } catch (error) {
    process.stderr.write(`install-launchers: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
