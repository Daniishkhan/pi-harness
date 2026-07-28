#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const PROFILE_IDS = new Set(["eng", "design", "research", "learn"]);
function requiredNumericId(value, label) {
  if (!/^[1-9][0-9]{0,9}$/.test(value ?? "")) throw new Error(`Invalid ${label} for cell privilege drop.`);
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id > 2_147_483_647) throw new Error(`Invalid ${label} for cell privilege drop.`);
  return id;
}

function assertUnprivilegedStatus(status) {
  const fields = new Map(
    status
      .split("\n")
      .map((line) => line.match(/^(CapInh|CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs):\s*(\S+)/))
      .filter(Boolean)
      .map((match) => [match[1], match[2]]),
  );
  for (const field of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]) {
    if (!/^0+$/.test(fields.get(field) ?? "")) throw new Error(`Cell privilege drop left ${field} enabled.`);
  }
  if (fields.get("NoNewPrivs") !== "1") throw new Error("Cell privilege drop did not retain no-new-privileges.");
}

export function assertCellSandbox(options = {}) {
  const env = options.env ?? process.env;
  const runtime = options.runtime ?? process;
  const readStatus = options.readStatus ?? (() => readFileSync("/proc/self/status", "utf8"));
  const uid = requiredNumericId(env.PI_HARNESS_CELL_UID, "target UID");
  const gid = requiredNumericId(env.PI_HARNESS_CELL_GID, "target GID");
  if (runtime.getuid() !== uid || runtime.getgid() !== gid) throw new Error("Cell entrypoint did not reach its target identity.");
  assertUnprivilegedStatus(readStatus());
}

export async function consumeLaunchRequest(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Cell launch request is not a regular file: ${path}`);
  if ((info.mode & 0o077) !== 0) throw new Error(`Cell launch request permissions are too broad: ${path}`);
  let request;
  try {
    request = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Invalid cell launch request at ${path}: ${error.message}`);
  }
  const keys = Object.keys(request ?? {}).sort();
  if (
    request?.schemaVersion !== 2 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(request.launchId ?? "") ||
    !PROFILE_IDS.has(request.profileId) ||
    !Array.isArray(request.args) ||
    request.args.some((arg) => typeof arg !== "string") ||
    JSON.stringify(keys) !== JSON.stringify(["args", "launchId", "profileId", "schemaVersion"])
  ) {
    throw new Error(`Cell launch request has an invalid schema: ${path}`);
  }
  // Consume before Pi starts. A manual or accidental container restart can
  // never replay an autonomous implementation prompt.
  await unlink(path);
  return request;
}

export async function publishCellReady(path, launchId) {
  const temporary = `${path}.tmp-${launchId}`;
  await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, launchId })}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export function runCellPi(request, options = {}) {
  const spawnImpl = options.spawnImpl ?? spawn;
  const command = options.command ?? "/opt/pi-harness/bin/pi-run.mjs";
  const child = spawnImpl(command, [request.profileId, ...request.args], {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    stdio: "inherit",
    shell: false,
  });
  const forward = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  const onTerm = () => forward("SIGTERM");
  const onInt = () => forward("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  const cleanup = () => {
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInt);
  };
  return new Promise((resolvePromise, reject) => {
    let readyError;
    let readyPromise = Promise.resolve();
    child.once("spawn", () => {
      readyPromise = Promise.resolve(options.onSpawn?.()).catch((error) => {
        readyError = error;
        forward("SIGTERM");
      });
    });
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", async (code, signal) => {
      cleanup();
      await readyPromise;
      if (readyError) {
        reject(readyError);
        return;
      }
      resolvePromise(signal ? 128 + (signal === "SIGINT" ? 2 : 15) : (code ?? 1));
    });
  });
}

async function main() {
  const [requestPath] = process.argv.slice(2);
  if (!requestPath) throw new Error("Cell entrypoint requires a launch request path.");
  if (process.env.PI_HARNESS_IN_CELL !== "1") throw new Error("Cell entrypoint refuses to run outside a managed cell.");
  // The immutable PID-1 bootstrap installs network guards and drops every
  // capability before this process is started. Verify that boundary before
  // reading the one-shot request or any workspace-controlled input.
  assertCellSandbox();
  const request = await consumeLaunchRequest(requestPath);
  return runCellPi(request, {
    onSpawn: () => publishCellReady(join(dirname(requestPath), "ready.json"), request.launchId),
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`pi-cell-entrypoint: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
