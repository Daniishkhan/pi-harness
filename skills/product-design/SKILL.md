---
name: product-design
description: Design modern app UIs with strong UX in Paper via the Paper MCP server. Use for designing new screens, flows, features, or redesigns for web/mobile apps — any request like "design this feature", "mock up this flow", or "improve this screen's UX" where the user journey matters. Always starts by asking the user discovery questions about intent, audience, and journey, then maps the journey and writes a design brief before touching the canvas, and runs an adversarial fresh-context review of the finished designs against the spec before delivering. Skip for pure code tasks and marketing-site work.
---

# Product Design

Design product UI in Paper by understanding the journey first. Never jump
straight to the canvas: discovery → journey map → brief → pixels →
adversarial review.

Prerequisite: the Paper MCP server must be connected. If Paper tools are
unavailable, ask the user to open Paper and reconnect, then stop.

## Phase 0 — Discovery (mandatory)

Before designing anything, understand intent. Ask with the `questionnaire`
tool — not prose questions — batching everything into one call with one tab
per topic.

Mine the conversation, the open Paper file (`get_basic_info`,
`get_selection`), and the user's codebase (theme/token files) for answers
first; ask only about real gaps. Typical gaps, in priority order:

1. **Intent** — what problem this solves, what the user should accomplish,
   what success looks like.
2. **Audience** — who uses it, their expertise, their context (focused
   desktop work, quick mobile check-in, high-frequency power use).
3. **Journey** — where the user comes from, the core tasks, decision points,
   the end state.
4. **Scope** — one screen or a flow; new surface or extending an existing
   one; platform (mobile 375px, desktop 1440px, or both).
5. **Brand & system** — existing design system or tokens to match, mood or
   brand direction, products to feel like (or avoid).
6. **Content** — real copy/data available, or realistic placeholders.

Rules:

- Max ~6 questions, each with sensible default options. If the request is
  already specific, ask a single question confirming your assumptions
  instead of interrogating.
- If the user says "just design it" (or similar), state your assumption for
  each unanswered gap in one line and proceed.
- Full question bank: [references/discovery-questions.md](references/discovery-questions.md).

## Phase 1 — Journey map

Turn the answers into a journey before touching the canvas, and post it in
chat: entry, task steps, decision branches, states (empty / loading / error
/ success), and exit — followed by the list of screens you will design, one
line each. Ask the user to confirm or adjust; a wrong journey is cheap to
fix in text and expensive on the canvas.

Template and example: [references/journey-mapping.md](references/journey-mapping.md).

## Phase 2 — Design brief

With the journey confirmed, post the visual brief before any mutation tool
call, in Paper's required format: mood candidates, mood chosen, palette
(5–6 hex values with roles), type scale, one-sentence direction. When the
file or codebase already has a design system or tokens, prefer matching it —
check `get_basic_info` / `get_tokens` first — instead of inventing a new
direction.

## Phase 3 — Design on the canvas

1. Call `get_guide({ topic: "paper-mcp-instructions" })` before any other
   Paper tool. Its rules are mandatory: small incremental `write_html`
   calls (one visual group each), `get_font_family_info` before typography,
   design tokens via CSS variables, screenshot review after each section.
2. Call `get_basic_info` and `get_selection` for context.
3. Create one artboard per screen, named after its journey step, arranged
   left-to-right in journey order so the flow reads as a story.
4. Build each screen incrementally — one visual group per `write_html`.
5. Design the states that make UX real, not just the happy path: first-run
   and empty states, loading, errors, and the success moment.
6. Screenshot after each meaningful section, critique against the review
   checkpoints, fix issues, then continue.
7. Call `finish_working_on_nodes` when done.

## Phase 4 — Adversarial review (author ≠ reviewer)

A design reviewed only by its author is an unreviewed design. Once the
canvas work passes your own screenshot checkpoints, hand the spec and the
screens to a fresh-context reviewer subagent — never grade your own work.

1. Export every artboard with `paper_export` (PNG) into a temp directory.
2. Spawn a read-only reviewer (the `reviewer` agent, fresh context) with
   `model: "openai/gpt-5.6-sol"` — the pinned cross-family reviewer. Give
   it the confirmed journey map, the design brief, the discovery answers
   (or the feature spec/PRD excerpt when one exists), and the PNG paths.
   Do NOT give it your rationale or self-critiques — that anchors it.
3. The reviewer attacks two axes: **spec conformance** (every journey step,
   decision branch, and required state has a screen; one primary action
   each) and **design principles** (hierarchy, spacing, typography,
   contrast, alignment, restraint, fidelity to the brief). Findings must be
   severity-tagged and cite the spec or a principle — no bare taste
   opinions, no redesigns.
4. You own the fixes: apply targeted canvas edits for blocker and
   should-fix findings (never delete-and-start-over), re-screenshot, and
   note anything declined or deferred in the wrap-up. One review round by
   default; a second only if the fixes were extensive.

Reviewer task template and checklist:
[references/design-review.md](references/design-review.md).

## Phase 5 — Wrap up

Report in chat: what was designed screen by screen, which journey steps and
states each covers, review findings accepted or declined (with reasons),
decisions made, and open questions or suggested next screens. Never include
raw node IDs.

## Rules

- No canvas mutations before discovery, journey map, and brief are done.
- Journey first, screens second, pixels third.
- Every screen exists because a journey step needs it — if you can't name
  the step, cut the screen.
- Give empty, loading, and error states the same care as the happy path.
- The author never reviews its own design — every flow gets one
  fresh-context adversarial pass against the spec before wrap-up, unless
  the user asks to skip it.
- Clarity over decoration for productivity tools; impressiveness only when
  the brief asks for it.
