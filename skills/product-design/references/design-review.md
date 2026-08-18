# Adversarial Design Review

A fresh-context reviewer subagent grades the finished screens against the
spec and design principles. The author never reviews its own work: the
reviewer sees the spec and the pixels, not the author's rationale.

## Setup

1. Export every artboard as PNG via `paper_export` into a temp directory,
   named after the screen (e.g. `triage.png`, `triage-empty.png`).
2. Launch the `reviewer` agent fresh-context and read-only, with
   `model: "openai/gpt-5.6-sol"` (pinned; vision-capable, cross-family
   from the usual designing models). If that model is unavailable in the
   session, pick another configured image-capable model from a different
   family than the designer. The reviewer needs only file-read access —
   no Paper tools, no codebase, no write access.

## Reviewer task template

```
You are an adversarial design reviewer. You did not make these designs and
have no stake in them. Find what is wrong; do not praise.

## Spec under review
<the confirmed journey map: entry, steps, decision branches, states, exit>
<the design brief: mood, palette with roles, type scale, direction>
<discovery answers: intent, audience, platform, scope>
<feature spec / PRD excerpt, if one exists>

## Screens
<screen name> → <png path>   (one line per artboard, journey order)

## Review axes

A. Spec conformance — check each against the spec, line by line:
   - every journey step has a screen; every screen serves a journey step
   - every decision branch is handled (screen or explicit state)
   - required states exist: empty / loading / error / success, as mapped
   - each screen has exactly one primary action
   - platform and scope match what was agreed (mobile/desktop, screen list)

B. Design principles — check each screen as a senior designer:
   - hierarchy: does the eye land on the primary action first?
   - typography: readable sizes, clear heading/body/caption contrast
   - spacing: deliberate rhythm, no cramped groups or dead zones
   - contrast: all text legible at a glance, especially under 16px
   - alignment: repeated rows share vertical lanes
   - fidelity: palette, type, and mood match the brief — flag drift
   - restraint: elements that could be removed without loss

## Output format
One finding per line:
  [blocker|should-fix|nit] <screen> — <what is wrong> — <spec line or
  principle it violates>
End with a one-line verdict: ship / fix-and-recheck / rethink.
No redesigns, no alternative directions, no compliments. If a check passes,
say nothing about it.
```

## Handling findings

- **blocker** — spec violation or unreadable/unusable: fix on the canvas
  before wrap-up, no exceptions.
- **should-fix** — fix now, or note in the wrap-up as a conscious deferral
  with the reason.
- **nit** — fix only when trivially cheap; list the rest.
- Disagree with a finding? You may decline it, but say so in the wrap-up
  with a one-line reason. Silent dismissal is not allowed.
- After fixes, re-screenshot the touched sections and verify against the
  original findings. Run a second full review only if fixes touched most
  screens.
