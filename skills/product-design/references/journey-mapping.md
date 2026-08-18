# Journey Mapping

A journey map keeps screens honest: every artboard exists because a step in
the user's story needs it.

## Template

Post this in chat and ask the user to confirm before designing:

```
Journey: <name>
Entry:     <how the user arrives, what they know, what they want>
Steps:     1. <task> → screen: <name>
           2. <task> → screen: <name>
Decisions: <branch> → <path A> / <path B>
States:    empty / loading / error / success for: <screens>
Exit:      <end state, where the user goes next>

Screens (one artboard each, left-to-right):
1. <screen name> — <purpose; primary action>
2. ...
```

## What good looks like

- Steps are user tasks ("compare candidates"), not UI parts ("open modal").
- Each screen has exactly one primary action. If you listed two, split the
  screen or demote one.
- Include the first-run or empty state of the most important screen — it is
  the first UX moment real users meet.
- Every decision branch gets its own screen or an explicit state on an
  existing one. Never leave a branch unaccounted for.
- Keep a first pass to 3–6 screens; offer to extend after review instead of
  designing the whole app at once.

## Example

```
Journey: reviewing new applicants (hiring app)
Entry:     recruiter opens a "12 new applicants" email link, desktop, 9am
Steps:     1. scan the triage list → screen: Triage
           2. open a promising profile → screen: Profile
           3. compare against the role bar → screen: Profile (same)
           4. shortlist or pass → screens: Shortlist confirm / Pass flow
Decisions: shortlist → confirmation + suggested next step
           pass → reason capture → suggestion to send feedback
States:    empty triage list; loading profiles; pass-confirmation error
Exit:      shortlist confirmed; recruiter continues to scheduling

Screens:
1. Triage — scan and prioritize new applicants; primary: open profile
2. Profile — evidence vs. the role bar; primary: shortlist
3. Pass flow — capture a reason; primary: confirm pass
4. Triage (empty) — first-run moment; primary: adjust filters
```

## From map to canvas

- One artboard per screen, named after the journey step, arranged
  left-to-right in journey order.
- State variants sit directly below their happy-path artboard.
- If the map changes mid-design (user edits, new constraint), update the
  posted map first, then the canvas.
