/**
 * pi-teams — shared types (pi-free, testable with plain node).
 */

export const MESSAGE_KINDS = [
  "chat",
  "finding",
  "objection",
  "plan-approval-request",
  "plan-approval-response",
  "shutdown",
] as const;

export type MessageKind = (typeof MESSAGE_KINDS)[number];

export interface TeamMessage {
  id: string;
  ts: number;
  from: string;
  to: string;
  kind: MessageKind;
  body: string;
  refs?: string[];
}

export type MemberStatus = "pending" | "spawning" | "active" | "done" | "failed";
export type MemberRole = "lead" | "teammate";

export interface Member {
  name: string;
  role: MemberRole;
  /** Human-readable role label, e.g. "planner", "critic", "scout". */
  title?: string;
  /** pi-subagents agent/runtime name used to spawn this member. */
  agent?: string;
  model?: string;
  /** Optional comma-separated tool allowlist override for this member's agent file. */
  tools?: string;
  /** Session identity of the pi session currently bound to this member. */
  sessionId?: string;
  sessionFile?: string;
  status: MemberStatus;
  joinedAt?: number;
  lastActivityAt?: number;
  /** pi-subagents runId once spawned (Phase 1+). */
  runId?: string;
  /**
   * The spawned child's own runId (workflow children get their own async
   * record; reviving requires the child id, not the workflow id). Derived
   * from the child's session file at team_join.
   */
  childRunId?: string;
}

export interface TeamConfig {
  team: string;
  createdAt: number;
  updatedAt: number;
  members: Member[];
}
