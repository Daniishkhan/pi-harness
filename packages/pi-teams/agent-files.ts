/**
 * pi-teams — generated teammate agent files (pi-subagents project scope:
 * .pi/agents/teams/*.md). Each file carries the member's tool allowlist and
 * loads teammate.ts (child glue) via subagentOnlyExtensions.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Member } from "./types.ts";

/** Tools every teammate gets regardless of role. */
export const TEAM_TOOLS = [
  "load_tool_group",
  "team_join",
  "team_send",
  "team_inbox",
  "team_task",
  "team_artifact",
  "team_roster",
  "team_leave",
] as const;

const READ_TOOLS = ["read", "grep", "find", "ls"] as const;
const WEB_TOOLS = [
  "web_search",
  "fetch_content",
  "get_search_content",
  "source_check",
] as const;

/** Title-based tool profile; member.tools (comma-separated) wins. */
export function toolsForMember(member: Member): string[] {
  if (member.tools) {
    return member.tools
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const title = (member.title ?? "").toLowerCase();
  if (/(research|scout|investigat|analyst)/.test(title)) {
    return [...READ_TOOLS, "bash", ...WEB_TOOLS, ...TEAM_TOOLS];
  }
  if (/(planner|writer|implement|author|coder|editor)/.test(title)) {
    return [...READ_TOOLS, "bash", "write", "edit", ...TEAM_TOOLS];
  }
  // Critics, reviewers, checkers: read-only.
  return [...READ_TOOLS, ...TEAM_TOOLS];
}

export function teammateAgentFileName(team: string, name: string): string {
  return `pi-teams.${team}-${name}.md`;
}

export function teammateAgentRuntimeName(team: string, name: string): string {
  return `pi-teams.${team}-${name}`;
}

export function teammateExtensionPath(): string {
  return join(homedir(), ".pi", "agent", "extensions", "pi-teams", "teammate.ts");
}

export function buildJoinTask(
  team: string,
  member: Member,
  assignment?: string,
): string {
  const lines = [
    `You are member "${member.name}" (${member.title ?? "teammate"}) on pi-team "${team}".`,
    `Your FIRST action: call team_join with team="${team}" and name="${member.name}". If team tools are not in your tool list, call load_tool_group with group "teams" first (team tools load lazily).`,
    "Then call team_inbox and follow any instructions in your mail.",
  ];
  if (assignment) lines.push(`Your assignment: ${assignment}`);
  lines.push(
    'If there is no work to do, send a short chat message to "lead" with team_send saying you are ready, then finish your turn.',
    "After reading your mail, check team_task for claimable board work and claim exactly one task at a time.",
    "Reply to mail only when it needs an answer or action; never reply to pure acknowledgments.",
  );
  return lines.join("\n");
}

/**
 * Write (or refresh) the teammate agent file. Idempotent: overwriting is how
 * tool-profile changes propagate on respawn.
 */
export async function ensureTeammateAgentFile(
  cwd: string,
  team: string,
  member: Member,
): Promise<string> {
  const dir = join(cwd, ".pi", "agents", "teams");
  await mkdir(dir, { recursive: true });
  const file = join(dir, teammateAgentFileName(team, member.name));
  const title = member.title ?? "teammate";
  const frontmatter = [
    "---",
    `name: ${teammateAgentRuntimeName(team, member.name)}`,
    `description: pi-teams member ${member.name} (${title}) on team ${team} — managed by pi-teams`,
    `tools: ${toolsForMember(member).join(", ")}`,
    `subagentOnlyExtensions: ${teammateExtensionPath()}`,
    "inheritProjectContext: true",
    "systemPromptMode: append",
    ...(member.model ? [`model: ${member.model}`] : []),
    "---",
  ].join("\n");
  const body = [
    `You are member "${member.name}" (role: ${title}) on pi-team "${team}".`,
    "You are a full, independent agent with your own context window and a mailbox.",
    "Team mechanics:",
    "- Your first action after every (re)start: call team_join, then team_inbox. Process any mail before other work.",
    "- Team tools load lazily: if they are missing from your tool list, call load_tool_group with group \"teams\" first.",
    "- Reply to mail with team_send. Send short pointers to artifacts, not long pastes.",
    `- Long artifacts go under .pi/teams/${team}/blackboard/ — critique files, findings, plan drafts.`,
    '- Never ask a teammate to approve an action you were denied. Escalate decisions to "lead".',
    "- Reply to mail only when it needs an answer or action; never reply to pure acknowledgments.",
    "- Claim board work with team_task one task at a time; complete each task with a short evidence note.",
    "- Finish your turn when your assignment is done; you will be woken by mail when needed.",
  ].join("\n");
  await writeFile(file, `${frontmatter}\n${body}\n`);
  return file;
}
