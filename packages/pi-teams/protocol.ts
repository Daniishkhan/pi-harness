/**
 * pi-teams — plan review protocol (Phase 3).
 * Durable protocol state + blackboard conventions:
 *   blackboard/plan.md          current plan (revision n)
 *   blackboard/plan.v<n>.md     archived revisions
 *   blackboard/critiques/<critic>.r<round>.md   per-critic critique rounds
 *   protocol.json               phase / round / planRev / history log
 *
 * Phases: drafting → critique → revision → awaiting-approval → approved | rejected
 * Message kinds carry the protocol over mail:
 *   objection (critic → planner/lead), plan-approval-request (planner → lead),
 *   plan-approval-response (lead → planner).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withFileLock } from "./lock.ts";

export type PlanPhase =
  | "drafting"
  | "critique"
  | "revision"
  | "awaiting-approval"
  | "approved"
  | "rejected";

export interface PlanProtocol {
  title: string;
  phase: PlanPhase;
  /** 1-based critique round index. */
  round: number;
  /** Current plan.md revision number. */
  planRev: number;
  /** Member seat that owns the plan text: "lead" or a planner member name. */
  planner: string;
  critics: string[];
  /** Max critique rounds before forcing awaiting-approval. */
  rounds: number;
  startedAt: number;
  updatedAt: number;
  history: string[];
}

export function protocolPath(teamDir: string): string {
  return join(teamDir, "protocol.json");
}

export function planPath(teamDir: string): string {
  return join(teamDir, "blackboard", "plan.md");
}

export function planRevPath(teamDir: string, rev: number): string {
  return join(teamDir, "blackboard", `plan.v${rev}.md`);
}

export function critiquePath(teamDir: string, critic: string, round: number): string {
  return join(teamDir, "blackboard", "critiques", `${critic}.r${round}.md`);
}

export async function loadProtocol(dir: string): Promise<PlanProtocol | undefined> {
  try {
    const raw = await readFile(protocolPath(dir), "utf8");
    const parsed = JSON.parse(raw) as PlanProtocol;
    if (typeof parsed.title !== "string" || typeof parsed.phase !== "string") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export async function saveProtocol(dir: string, protocol: PlanProtocol): Promise<void> {
  await withFileLock(`${protocolPath(dir)}.lock`, async () => {
    await writeFile(protocolPath(dir), JSON.stringify(protocol, null, 2), "utf8");
  });
}

export async function updateProtocol(
  dir: string,
  mutator: (p: PlanProtocol) => void | Promise<void>,
): Promise<PlanProtocol> {
  return withFileLock(`${protocolPath(dir)}.lock`, async () => {
    const existing = await loadProtocol(dir);
    if (!existing) throw new Error(`No plan protocol active in ${dir} — run team_plan_start first`);
    await mutator(existing);
    existing.updatedAt = Date.now();
    await writeFile(protocolPath(dir), JSON.stringify(existing, null, 2), "utf8");
    return existing;
  });
}

export function newProtocol(input: {
  title: string;
  planner: string;
  critics: string[];
  rounds: number;
}): PlanProtocol {
  const now = Date.now();
  return {
    title: input.title,
    phase: "drafting",
    round: 1,
    planRev: 0,
    planner: input.planner,
    critics: input.critics,
    rounds: input.rounds,
    startedAt: now,
    updatedAt: now,
    history: [`${new Date(now).toISOString()} started plan review "${input.title}" (planner=${input.planner}, critics=${input.critics.join(",")}, rounds=${input.rounds})`],
  };
}

/** Write the next plan revision: archives vN and updates plan.md. */
export async function writePlanRevision(dir: string, text: string): Promise<number> {
  const current = await loadProtocol(dir);
  if (!current) throw new Error("No active plan protocol");
  const rev = current.planRev + 1;
  await mkdir(dirname(planPath(dir)), { recursive: true });
  // Archive the current plan.md under its revision number if one exists.
  try {
    const prev = await readFile(planPath(dir), "utf8");
    await writeFile(planRevPath(dir, current.planRev || 1), prev, "utf8");
  } catch {
    // No previous revision — first draft.
  }
  await writeFile(planPath(dir), text, "utf8");
  return rev;
}

export async function readPlan(dir: string): Promise<string | undefined> {
  try {
    return await readFile(planPath(dir), "utf8");
  } catch {
    return undefined;
  }
}
