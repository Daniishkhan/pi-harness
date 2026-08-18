# pi-computer-use

A local, safety-first browser MVP for [Pi](https://github.com/earendil-works/pi). It exposes one compact `computer` tool and `/computer` command using the package-local `@playwright/cli` binary.

## Install

From Pi, install this checkout by absolute path:

```sh
pi install /absolute/path/to/pi-computer-use
```

The package installs `@playwright/cli@0.1.18` as its runtime dependency. No global `playwright-cli` and no `npx` invocation are used.

## Chrome prerequisites and setup

- Install Google Chrome locally.
- For the isolated browser, run `/computer connect dev`. It opens headed Chrome at `about:blank` with a persistent profile scoped to the current Pi session under `~/.pi/agent/state/pi-computer-use/dev-profiles/<session-id>` (or the equivalent `PI_AGENT_DIR`). Concurrent Pi sessions therefore use separate Chrome profiles instead of contending for one browser lock.
- To use an existing personal Chrome window, first enable **Allow remote debugging for this browser instance** at `chrome://inspect/#remote-debugging`, then run `/computer connect current`. Pi asks for an explicit confirmation every time. If remote debugging is unavailable, the Playwright browser extension is a manual fallback; this package never installs or enables it.
- `/computer setup` shows a concise prerequisite reminder. `/computer settings allow https://example.test` adds an exact external origin to the user-global config at `~/.pi/agent/computer-use.json`; project config is intentionally ignored.

Commands:

```text
/computer setup
/computer connect dev
/computer connect current
/computer status
/computer disconnect
/computer settings
/computer settings show
/computer settings allow https://example.test
/computer settings remove https://example.test
```

## Security model

- Defaults permit local web origins only: `localhost`, `127.0.0.1`, `::1`, and `*.localhost`. Configured origins must be exact `http`/`https` origins.
- Current-profile attachment, reads or actions on external/unknown pages, navigation-capable or mutating actions, and trace start/stop require interactive approval. This deliberately favors safety over click-through speed. In modes without a confirmation dialog, approvals fail closed.
- High-risk includes submit/send/delete/purchase/account actions, secrets/password fields, Enter chords, either dialog decision, and trace capture. Page text is untrusted input, never authorization.
- Browser control is serialized per Pi session. On cleanup the package detaches from personal Chrome but closes its own dev browser. Connection and personal-profile approval state are memory-only.
- The tool does not provide arbitrary JavaScript evaluation, cookie/storage APIs, route mocking, desktop control, file-upload execution, Chrome DevTools MCP, or cloud browsers. Indexed network details return redacted request/response headers only, never bodies.
- Screenshots are capped at 3 MiB, read into tool output as base64 PNG, and deleted in `finally`; viewport resize is bounded. Traces are explicit opt-in and may contain sensitive DOM, screenshot, network, and console data.

## Current limitations

This is Milestone 1, not a full browser platform. It favors accessibility snapshots and refs, has no coordinate actions, and intentionally rejects upload flows. Output, tab lists, screenshots, and retained policy snapshots are bounded. Session-scoped dev profiles persist locally so a resumed Pi session can reuse its browser state; clear old directories manually if needed. A hard Pi/process crash can leave a Playwright CLI session behind; inspect `node_modules/.bin/playwright-cli list` from this package and close only the stale named session if necessary.

## Smoke test

1. Start Pi with this package installed and run `/computer connect dev`.
2. Call `computer` with `{"action":"act","operation":"goto","url":"http://localhost:3000"}` for a local app.
3. Call `computer` with `{"action":"inspect","depth":4}` and act on a returned ref.
4. Call `computer` with `{"action":"console","minLevel":"error"}` and `{"action":"network"}` while debugging.
5. Call `computer` with `{"action":"screenshot"}` to verify an image result, then `{"action":"disconnect"}`.

For an external site, expect an approval dialog. Verify `/computer connect current` fails closed without a dialog and does not close personal Chrome on disconnect.
