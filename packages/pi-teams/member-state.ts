/**
 * pi-teams — per-member runtime state on disk (no polling loops):
 *   inboxes/.activity/<name>.json   idle heartbeat (written by the teammate)
 *   inboxes/.failed/<name>.json     undelivered-mail flag (written by broker)
 * Roster rendering reads these; no process talks to another directly.
 */

import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface MemberState {
  idleAt?: number;
  failures: number;
  lastError?: string;
  at?: number;
}

export function activityPath(teamDir: string, name: string): string {
  return join(teamDir, "inboxes", ".activity", `${name}.json`);
}

export function failedPath(teamDir: string, name: string): string {
  return join(teamDir, "inboxes", ".failed", `${name}.json`);
}

export async function readMemberState(teamDir: string, name: string): Promise<MemberState> {
  const state: MemberState = { failures: 0 };
  try {
    const raw = await readFile(activityPath(teamDir, name), "utf8");
    const parsed = JSON.parse(raw) as { idleAt?: unknown };
    if (typeof parsed.idleAt === "number") state.idleAt = parsed.idleAt;
  } catch {
    // no heartbeat yet
  }
  try {
    const raw = await readFile(failedPath(teamDir, name), "utf8");
    const parsed = JSON.parse(raw) as { failures?: unknown; lastError?: unknown; at?: unknown };
    if (typeof parsed.failures === "number") state.failures = parsed.failures;
    if (typeof parsed.lastError === "string") state.lastError = parsed.lastError;
    if (typeof parsed.at === "number") state.at = parsed.at;
  } catch {
    // no failure flag
  }
  return state;
}

export async function recordFailure(teamDir: string, name: string, error: string): Promise<void> {
  const prev = await readMemberState(teamDir, name);
  const { mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const path = failedPath(teamDir, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({ failures: prev.failures + 1, lastError: error, at: Date.now() }),
    "utf8",
  );
}

export async function clearFailure(teamDir: string, name: string): Promise<void> {
  await unlink(failedPath(teamDir, name)).catch(() => {});
}
