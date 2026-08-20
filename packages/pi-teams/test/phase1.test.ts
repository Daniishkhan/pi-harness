/**
 * Phase 1 unit tests — pure helpers (no pi runtime needed):
 *   node test/phase1.test.ts
 */

import { formatMailNotice } from "../broker.ts";
import {
  buildJoinTask,
  teammateAgentRuntimeName,
  toolsForMember,
} from "../agent-files.ts";
import { parseChildRunId } from "../session-binding.ts";
import { createMessage } from "../mailbox.ts";
import type { Member } from "../types.ts";

let failures = 0;
function check(name: string, cond: boolean, extra?: string): void {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures++;
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

function member(over: Partial<Member>): Member {
  return { name: "x", role: "teammate", status: "pending", ...over };
}

// --- toolsForMember ---------------------------------------------------------
check("critic is read-only", toolsForMember(member({ title: "critic" })).join(",") === "read,grep,find,ls,load_tool_group,team_join,team_send,team_inbox,team_task,team_artifact,team_roster,team_leave");
check("planner gets write tools", toolsForMember(member({ title: "planner" })).includes("edit"));
check("researcher gets web tools", toolsForMember(member({ title: "research scout" })).includes("web_search"));
check("explicit tools override wins", toolsForMember(member({ tools: "read, bash" })).join(",") === "read,bash");

// --- buildJoinTask ----------------------------------------------------------
const task = buildJoinTask("t1", member({ title: "critic" }), "Review the plan");
check("join task names team", task.includes('team="t1"'));
check("join task names member", task.includes('name="x"'));
check("join task carries assignment", task.includes("Review the plan"));

// --- runtime naming ---------------------------------------------------------
check("runtime name format", teammateAgentRuntimeName("team-a", "critic") === "pi-teams.team-a-critic");

// --- formatMailNotice -------------------------------------------------------
const msgs = [
  createMessage("critic", "lead", "objection", "The plan ignores rollback."),
  createMessage("critic", "lead", "finding", "Migration takes 2x estimated time."),
];
const notice = formatMailNotice(msgs);
check("notice mentions count", notice.includes("2 new message(s)"));
check("notice names sender", notice.includes("critic"));
check("notice carries bodies", notice.includes("rollback") && notice.includes("2x estimated"));
check("notice has escalation line", notice.includes("escalate to lead"));

// --- long body truncated in notice ------------------------------------------
const long = createMessage("a", "b", "chat", "x".repeat(5000));
const longNotice = formatMailNotice([long]);
check("long body capped", !longNotice.includes("x".repeat(4000)) && longNotice.includes("…"));

// --- parseChildRunId ---------------------------------------------------------
check(
  "child runId parsed from session file",
  parseChildRunId("/x/y/z/18213087-2f53-4875-8a30-25dcbf778a53/run-0/session.jsonl") ===
    "18213087-2f53-4875-8a30-25dcbf778a53",
);
check(
  "child runId handles run-1",
  parseChildRunId("/x/00112233-4455-6677-8899-aabbccddeeff/run-1/session.jsonl") ===
    "00112233-4455-6677-8899-aabbccddeeff",
);
check("child runId rejects non-child paths", parseChildRunId("/x/abc-123/session.jsonl") === undefined);
check("child runId rejects missing", parseChildRunId(undefined) === undefined);

console.log("");
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
