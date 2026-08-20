/**
 * pi-teams — assignment text builders for protocol dispatches.
 * Pure module (no pi runtime imports) so tests can run under plain node.
 */

import { planPath } from "./protocol.ts";
import type { TeamConfig } from "./types.ts";

export function criticAssignment(
  team: string,
  title: string,
  round: number,
  teamDir: string,
  criticName: string,
): string {
  return [
    `Plan review assignment (round ${round}) on team "${team}" for "${title}".`,
    `1. Read the plan at ${planPath(teamDir)}.`,
    `2. Save your critique with team_artifact at path "critiques/${criticName}.r${round}.md": numbered objections, each with severity (blocker/major/minor), a concrete reason, and a suggested fix. Be adversarial: hunt for correctness gaps, missing tests, unclear scope, risky assumptions. Do not soften findings and do not edit the plan yourself.`,
    "3. Send your top 3 objections to lead via team_send with kind=objection, including the pointer to your critique file in refs.",
    "4. Complete your assigned board task with team_task (evidence = your critique file path).",
    "If you have no objections, say so explicitly in the critique file — a clean pass is a finding too.",
  ].join("\n");
}

export function plannerDraftAssignment(team: string, title: string): string {
  return [
    `Plan drafting assignment on team "${team}" for "${title}".`,
    "Draft the plan, then save it with team_plan_revise (pass the full plan text).",
    "Then send team_send kind=plan-approval-request to lead with a 3-line summary and any risks you want the lead to weigh.",
  ].join("\n");
}

export function criticNamesFor(config: TeamConfig, requested?: string[]): string[] {
  if (requested?.length) return requested;
  return config.members
    .filter(
      (m) =>
        m.role === "teammate" && /critic|review|checker|adversar/i.test(m.title ?? ""),
    )
    .map((m) => m.name);
}

export function scoutAssignment(
  team: string,
  question: string,
  angle: string,
  round: number,
  scoutName: string,
): string {
  return [
    `Research assignment (round ${round}) on team "${team}": "${question}"`,
    `Your angle: ${angle}`,
    "1. Research your angle with web tools. Collect specific, checkable claims — each with a source URL and its date. Prefer primary sources over SEO content farms.",
    `2. Save your findings with team_artifact at path "findings/${scoutName}.r${round}.md": TL;DR, claims with sources + per-claim confidence (high/medium/low), and open questions. Do not invent sources; if you cannot verify a claim, mark it low confidence instead of dropping it.`,
    "3. Send team_send kind=finding to lead with your 3 strongest claims and a pointer to your findings file.",
    "4. Complete your assigned board task with team_task (evidence = your findings file path).",
  ].join("\n");
}

export function challengerAssignment(
  team: string,
  question: string,
  target: string,
  challengerName: string,
): string {
  const targetFindings = `blackboard/findings/${target}.r1.md`;
  return [
    `Cross-challenge assignment on team "${team}": try to falsify ${target}'s findings for "${question}".`,
    `1. Read ${targetFindings} (full path: .pi/teams/${team}/${targetFindings}; use the read tool).`,
    "2. Hunt for: unsupported claims, outdated sources, cherry-picked evidence, contradictions between sources, missing counter-evidence. Verify the most load-bearing sources yourself with web tools.",
    `3. Save your challenge with team_artifact at path "challenges/${challengerName}-on-${target}.md": per-claim verdicts (stands / weakened / refuted) with reasons and sources. Contradictions are findings — do not average them away.`,
    "4. Send team_send kind=objection to lead with your top findings and the pointer to your challenge file.",
    "5. Complete your assigned board task with team_task (evidence = your challenge file path).",
  ].join("\n");
}

export function scoutNamesFor(config: TeamConfig, requested?: string[]): string[] {
  if (requested?.length) return requested;
  return config.members
    .filter(
      (m) =>
        m.role === "teammate" && /research|scout|investigat|analyst/i.test(m.title ?? ""),
    )
    .map((m) => m.name);
}
