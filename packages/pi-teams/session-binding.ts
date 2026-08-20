/**
 * pi-teams — session binding: map the current pi session to a team member
 * seat via config.json (durable across restarts). Shared by index.ts (lead)
 * and teammate.ts (child glue).
 */

import { readdir } from "node:fs/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, teamDir, teamsRoot } from "./team.ts";
import type { Member } from "./types.ts";

export interface Binding {
  team: string;
  dir: string;
  name: string;
  role: "lead" | "teammate";
}

export function matchesThisSession(member: Member, ctx: ExtensionContext): boolean {
  const sessionId = ctx.sessionManager.getSessionId();
  const sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
  if (member.sessionId && sessionId && member.sessionId === sessionId) return true;
  if (member.sessionFile && sessionFile && member.sessionFile === sessionFile) return true;
  return false;
}

/**
 * Child sessions live at <childRunId>/run-<n>/session.jsonl under the parent
 * session dir. The child run id is the revive/steer target pi-subagents uses
 * for workflow children (see listRetainedChildren in pi-subagents).
 */
export function parseChildRunId(sessionFile?: string): string | undefined {
  if (!sessionFile) return undefined;
  const match = /[\\/]([0-9a-fA-F-]{36})[\\/]run-\d+[\\/]session\.jsonl$/.exec(sessionFile);
  return match?.[1];
}

export async function findBindingForSession(
  cwd: string,
  ctx: ExtensionContext,
): Promise<Binding | null> {
  let names: string[];
  try {
    names = await readdir(teamsRoot(cwd));
  } catch {
    return null;
  }
  for (const name of names) {
    const dir = teamDir(cwd, name);
    const config = await loadConfig(dir).catch(() => undefined);
    if (!config) continue;
    for (const member of config.members) {
      if (matchesThisSession(member, ctx)) {
        return { team: config.team, dir, name: member.name, role: member.role };
      }
    }
  }
  return null;
}
