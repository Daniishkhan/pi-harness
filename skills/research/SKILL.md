---
name: research
description: Deep research on technical questions — libraries, tools, architecture approaches, tradeoffs, comparisons, "how does X work", "should we use X or Y", "research / look into / dig into X". Fans out parallel fresh-context research subagents with distinct angles, synthesizes a sourced brief tied to the user's decision, and delivers it inline in chat. Skip for quick factual lookups answerable inline and for questions about the local codebase.
---

# Research

Produce a sourced, decision-ready research brief — not a pile of links.

## Phase 0 — Scope

1. Restate the question in one line and identify the decision it informs ("choose a job queue", "understand advisory locks before building Y"). If unclear, ask the user one question.
2. Decompose into 2–4 angles that cannot all be answered from the same sources. Typical angles: primary sources (official docs, RFCs, papers, changelogs); practitioner experience (postmortems, engineering blogs, forums); comparisons and benchmarks; current status (maintenance activity, recency, ecosystem).
3. Quick factual questions stop here — answer inline with `web_search` and skip the rest of this workflow.

## Phase 1 — Fan-out

Launch one fresh-context research subagent per angle, in parallel (prefer the `scout` agent when executable):

Each subagent task includes the one-line question, its assigned angle, and these output rules:

- every claim carries a source URL; no unsourced claims
- record dates for time-sensitive claims (versions, pricing, maintenance status)
- report contradictions found between sources — do not average them away
- confidence per claim: high / medium / low
- prefer primary sources; treat SEO content-farm material as low confidence

If a subagent lacks web tools in this session, run that angle yourself with `web_search` / `fetch_content` instead.

## Phase 2 — Synthesize

Merge the angle reports into a brief, in chat:

1. **TL;DR** — 5 lines max
2. **Findings by theme**, with citations
3. **Contested points** — contradictions are findings, not noise
4. **Recommendation** — tied to the user's decision, or "no clear winner; here is the tradeoff axis that decides it"
5. **Open questions** worth a follow-up

For genuinely deep topics, delegate the synthesis to the `oracle` agent with the angle reports as input.

## Rules

- Citations or it didn't happen.
- Never smooth over contradictions — surface them.
- The brief serves the decision, not the topic's completeness.
