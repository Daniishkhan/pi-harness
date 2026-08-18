/**
 * review-gate — hard gate requiring adversarial review before opening a PR.
 *
 * The plan/execute/ship pipeline and the `review` skill are soft habits; this
 * extension makes them enforceable. When the agent tries to run `gh pr create`
 * or `gh pr ready` without evidence of review in this session, the call is
 * blocked and the block reason routes the agent to the review skill. Blocking
 * returns the reason to the model, so the agent self-corrects and retries.
 *
 * Review evidence (session-scoped):
 *   - user input invoking /skill:review, /skill:execute, or /skill:ship
 *     (the pipeline runs its own spec/quality reviews)
 *   - the agent reading the review skill's SKILL.md (model-invoked load)
 *   - quality-reviewer / spec-reviewer subagent launches
 *   - explicit user override via confirm dialog
 *
 * The user running `!gh pr create` themselves is never gated (user_bash does
 * not pass through tool_call). Agent-side escape hatch for headless runs:
 * append `# review-waived` to the command — deliberate and greppable.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

const PR_COMMAND = /\bgh\s+pr\s+(create|ready)\b/;
const REVIEW_SKILL_PATH = /skills[\\/]review[\\/]SKILL\.md$/;
const REVIEWER_AGENT = /quality-reviewer|spec-reviewer/;
const PIPELINE_INPUT = /^\/skill:(review|execute|ship)\b/;
const USER_WAIVER = /#\s*review-waived/;

const BLOCK_REASON = [
	"Blocked by review-gate: no adversarial review has run in this session.",
	"Run the review skill first (`/skill:review`), follow it for this change, then retry the PR command.",
	"If the user explicitly waived review, retry the command with `# review-waived` appended.",
].join(" ");

export default function (pi: ExtensionAPI) {
	let reviewEngaged = false;

	const engage = (ctx: ExtensionContext, why: string) => {
		if (reviewEngaged) return;
		reviewEngaged = true;
		if (ctx.hasUI) ctx.ui.notify(`review-gate: satisfied (${why})`, "info");
	};

	pi.on("input", async (event, ctx) => {
		if (PIPELINE_INPUT.test(event.text.trim())) engage(ctx, "pipeline invocation");
		return { action: "continue" as const };
	});

	pi.on("tool_call", async (event, ctx) => {
		// Evidence: the model loaded the review skill itself
		if (isToolCallEventType("read", event)) {
			if (REVIEW_SKILL_PATH.test(event.input.path ?? "")) engage(ctx, "review skill loaded");
			return;
		}

		// Evidence: reviewer subagents launched (pipeline or review skill)
		if (event.toolName === "subagent") {
			if (REVIEWER_AGENT.test(JSON.stringify(event.input ?? {}))) engage(ctx, "reviewer subagents");
			return;
		}

		// Gate: PR creation / ready-for-review
		if (isToolCallEventType("bash", event)) {
			const command = event.input.command ?? "";
			if (!PR_COMMAND.test(command) || reviewEngaged) return;

			if (USER_WAIVER.test(command)) {
				engage(ctx, "explicit waiver in command");
				return;
			}

			if (ctx.hasUI) {
				const override = await ctx.ui.confirm(
					"Review gate",
					"No adversarial review detected in this session. Open or ready the PR anyway?",
				);
				if (override) {
					engage(ctx, "user override");
					return;
				}
			}

			return { block: true, reason: BLOCK_REASON };
		}
	});
}
