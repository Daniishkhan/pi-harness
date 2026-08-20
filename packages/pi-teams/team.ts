/**
 * pi-teams — team config management (project-scoped under .pi/teams/).
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "./lock.ts";
import type { TeamConfig } from "./types.ts";

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Prevent path traversal and keep names safe as file components. */
export function isValidName(name: string): boolean {
  return NAME_RE.test(name);
}

export function teamsRoot(cwd: string): string {
  return join(cwd, ".pi", "teams");
}

export function teamDir(cwd: string, team: string): string {
  return join(teamsRoot(cwd), team);
}

export function configPath(dir: string): string {
  return join(dir, "config.json");
}

function isValidConfig(x: unknown): x is TeamConfig {
  return (
    !!x &&
    typeof x === "object" &&
    typeof (x as TeamConfig).team === "string" &&
    Array.isArray((x as TeamConfig).members)
  );
}

export async function loadConfig(dir: string): Promise<TeamConfig | undefined> {
  try {
    const raw = await readFile(configPath(dir), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isValidConfig(parsed) ? parsed : undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** Write config atomically (tmp + rename). Caller must hold the lock. */
async function writeConfigUnlocked(dir: string, config: TeamConfig): Promise<void> {
  const tmp = `${configPath(dir)}.tmp`;
  await writeFile(tmp, JSON.stringify(config, null, 2), "utf8");
  await rename(tmp, configPath(dir));
}

export async function saveConfig(dir: string, config: TeamConfig): Promise<void> {
  await withFileLock(`${configPath(dir)}.lock`, () => writeConfigUnlocked(dir, config));
}

/** Read-modify-write under one lock; returns the updated config. */
export async function updateConfig(
  dir: string,
  mutator: (config: TeamConfig) => void | Promise<void>,
): Promise<TeamConfig> {
  return withFileLock(`${configPath(dir)}.lock`, async () => {
    const existing = await loadConfig(dir);
    if (!existing) throw new Error(`Team config missing in ${dir}`);
    await mutator(existing);
    existing.updatedAt = Date.now();
    await writeConfigUnlocked(dir, existing);
    return existing;
  });
}

export async function createTeam(dir: string, config: TeamConfig): Promise<void> {
  if (await loadConfig(dir)) {
    throw new Error(`Team "${config.team}" already exists in this project`);
  }
  await mkdir(join(dir, "inboxes"), { recursive: true });
  await saveConfig(dir, config);
}
