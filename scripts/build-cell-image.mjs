#!/usr/bin/env node

import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadCatalog } from "../lib/manifests.mjs";
import { computeHarnessPayloadHash } from "../lib/payload.mjs";
import { resolveHarnessPaths } from "../lib/paths.mjs";

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(command, args, { ...options, shell: false });
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited ${signal ?? code ?? "unknown"}`));
    });
  });
}

export async function buildCellImage(options = {}) {
  const env = options.env ?? process.env;
  const paths = options.paths ?? resolveHarnessPaths(env, options.pathOverrides);
  const catalog = options.catalog ?? (await loadCatalog(paths));
  const payloadHash = await computeHarnessPayloadHash(paths.repoRoot);
  await run(
    paths.podmanBin,
    [
      "build",
      "--pull=always",
      `--build-arg=PI_VERSION=${catalog.pi.version}`,
      `--build-arg=HARNESS_SHA256=${payloadHash}`,
      `--tag=${paths.cellImage}`,
      "--file",
      "container/Containerfile",
      ".",
    ],
    { cwd: paths.repoRoot, env },
  );
  await run(paths.podmanBin, ["run", "--rm", "--pull=never", "--entrypoint=pi", paths.cellImage, "--version"], {
    env,
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
if (isMain) {
  try {
    await buildCellImage();
  } catch (error) {
    process.stderr.write(`build-cell-image: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
