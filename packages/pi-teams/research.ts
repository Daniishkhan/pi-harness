/**
 * pi-teams — deep research protocol (Phase 4).
 * Durable state (research.json) + blackboard conventions:
 *   blackboard/findings/<scout>.r<round>.md      sourced findings per scout
 *   blackboard/challenges/<scout>-on-<target>.md adversarial cross-checks
 *   blackboard/verdict.md                        the lead's synthesis
 *
 * Phases: scouting → challenge → synthesizing → done
 * Message kinds: finding (scout → lead), objection (challenger → lead).
 * The synthesis shape follows the research-skill contract: per-claim
 * confidence, contradictions surfaced (never averaged away), sources cited.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "./lock.ts";

export type ResearchPhase = "scouting" | "challenge" | "synthesizing" | "done";

export interface ResearchScout {
  name: string;
  angle: string;
}

export interface ResearchProtocol {
  question: string;
  phase: ResearchPhase;
  /** 1-based round; round 1 = scouting, round 2 = cross-challenge. */
  round: number;
  scouts: ResearchScout[];
  /** Round-2 assignment: challenger name → target scout name. */
  challengeMap: Record<string, string>;
  startedAt: number;
  updatedAt: number;
  history: string[];
}

export function researchPath(teamDir: string): string {
  return join(teamDir, "research.json");
}

export function findingsPath(teamDir: string, scout: string, round: number): string {
  return join(teamDir, "blackboard", "findings", `${scout}.r${round}.md`);
}

export function challengePath(teamDir: string, challenger: string, target: string): string {
  return join(teamDir, "blackboard", "challenges", `${challenger}-on-${target}.md`);
}

export function verdictPath(teamDir: string): string {
  return join(teamDir, "blackboard", "verdict.md");
}

export async function loadResearch(dir: string): Promise<ResearchProtocol | undefined> {
  try {
    const raw = await readFile(researchPath(dir), "utf8");
    const parsed = JSON.parse(raw) as ResearchProtocol;
    if (typeof parsed.question !== "string" || typeof parsed.phase !== "string") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export async function saveResearch(dir: string, protocol: ResearchProtocol): Promise<void> {
  await withFileLock(`${researchPath(dir)}.lock`, async () => {
    await writeFile(researchPath(dir), JSON.stringify(protocol, null, 2), "utf8");
  });
}

export async function updateResearch(
  dir: string,
  mutator: (r: ResearchProtocol) => void | Promise<void>,
): Promise<ResearchProtocol> {
  return withFileLock(`${researchPath(dir)}.lock`, async () => {
    const existing = await loadResearch(dir);
    if (!existing) throw new Error(`No research protocol active in ${dir} — run team_research_start first`);
    await mutator(existing);
    existing.updatedAt = Date.now();
    await writeFile(researchPath(dir), JSON.stringify(existing, null, 2), "utf8");
    return existing;
  });
}

export function newResearch(input: {
  question: string;
  scouts: ResearchScout[];
}): ResearchProtocol {
  const now = Date.now();
  return {
    question: input.question,
    phase: "scouting",
    round: 1,
    scouts: input.scouts,
    challengeMap: {},
    startedAt: now,
    updatedAt: now,
    history: [
      `${new Date(now).toISOString()} research started: "${input.question}" — scouts: ${input.scouts.map((s) => `${s.name}(${s.angle})`).join(", ")}`,
    ],
  };
}
