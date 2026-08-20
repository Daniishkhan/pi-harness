/**
 * pi-teams — teammate glue. Loaded into child sessions via
 * subagentOnlyExtensions on generated agent files (see agent-files.ts).
 *
 * Registers NO tools (pi-teams/index.ts provides them globally in every
 * session). This module only adds teammate-side behavior:
 *   - unread-mail reminder injected at session start (safety net for cases
 *     where the broker could not steer/resume)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cursorPath, getCursor, inboxPath, readInbox } from "./mailbox.ts";
import { findBindingForSession } from "./session-binding.ts";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    try {
      const me = await findBindingForSession(ctx.cwd, ctx);
      if (!me || me.role !== "teammate") return;
      const cursor = await getCursor(cursorPath(me.dir, me.name));
      const res = await readInbox(inboxPath(me.dir, me.name), { sinceLine: cursor });
      if (res.messages.length === 0) return;
      const froms = [...new Set(res.messages.map((m) => m.from))].join(", ");
      pi.sendMessage(
        {
          customType: "pi-teams-mail-reminder",
          content:
            `You have ${res.messages.length} unread team message(s) from ${froms}. ` +
            "Call team_inbox to read them before doing other work.",
          display: true,
          details: { team: me.team, count: res.messages.length },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    } catch {
      // Never break a child session over mail glue.
    }
  });

  // Idle heartbeat: when this teammate's run settles, record it in the team
  // dir so the lead's roster can show last-activity without polling.
  pi.on("agent_settled", async (_event, ctx) => {
    try {
      const me = await findBindingForSession(ctx.cwd, ctx);
      if (!me || me.role !== "teammate") return;
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const dir = join(me.dir, "inboxes", ".activity");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${me.name}.json`), JSON.stringify({ idleAt: Date.now() }), "utf8");
    } catch {
      // Heartbeat is best-effort.
    }
  });
}
