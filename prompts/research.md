---
description: Deep-research a technical question with the pi-teams research protocol (or a solo pi-subagents fan-out) and capture a sourced brief to Obsidian
argument-hint: "<question>"
---

Research this question: $@

Follow the Deep research protocol in the pi-teams skill
(packages/pi-teams/skills/pi-teams/SKILL.md inside this package): scope the
question and the decision it informs, decompose into 2–4 angles, gather
sourced findings with per-claim confidence, then synthesize the brief.

If the user asked to research with agent teams: load_tool_group {group:
"teams"} and run team_research_start → team_research_challenge →
team_research_finish. Otherwise run the same contract solo with a
pi-subagents scout fan-out (load_tool_group {group: "agents"} first when
needed). Capture the final brief to Obsidian.
