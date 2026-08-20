---
name: webbridge
description: Control the user's logged-in Chrome or Edge through Kimi WebBridge. Use for browser, webpage, URL, screenshot, scraping, form, or authenticated-site tasks.
metadata:
  version: "1.0.0"
---

# Kimi WebBridge

Drive the user's **real browser** (their logins, cookies, extensions) via a local daemon: `POST http://127.0.0.1:10086/command`. The daemon relays to a browser extension attached to the user's running Chrome/Edge.

## Call format

Every command is one curl via the `bash` tool. Body is `{action, args, session}` — `session` is a **top-level field** naming the current task:

```bash
curl -s -X POST http://127.0.0.1:10086/command \
  -H 'Content-Type: application/json' \
  -d '{"action":"navigate","args":{"url":"https://example.com","newTab":true,"group_title":"Task label"},"session":"my-task"}'
```

Response envelope: `{"ok":true,"data":{...}}` or `{"ok":false,"error":"..."}`.

**If an inline call fails** (bash quoting/syntax error, or HTTP 400 from the daemon), do **not** retry the same command unchanged. Resend as a file body:

1. Write the JSON to a uniquely-named temp file with the `write` tool — never `echo`/heredoc, which mangle JSON the same way — e.g. `/tmp/webbridge-req-<random>.json`.
2. POST it: `curl -s -X POST http://127.0.0.1:10086/command -H 'Content-Type: application/json' --data-binary @/tmp/webbridge-req-<random>.json`
3. Delete the temp file once the response returns.

## Tools

| Action | Args | Returns | Note |
|--------|------|---------|------|
| `navigate` | `url`, `newTab`(bool), `group_title` | `{success, url, tabId}` | Sets current tab. `group_title` on first navigate labels the tab group |
| `find_tab` | `url`, `active`(bool) | `{success, url, tabId, borrowed}` | Re-select a tab **this session** opened (pass exact full URL). `active:true` borrows the tab the **user** is currently viewing |
| `snapshot` | — | `{url, title, tree}` | **Accessibility tree** with `@e` refs — use this to read pages and find elements |
| `click` | `selector` (@e or CSS) | `{success, tag, text}` | Synthetic `el.click()` |
| `fill` | `selector`, `value` | `{success, tag, mode}` | Works on `<input>`/`<textarea>` AND `[contenteditable]` (ProseMirror/Lexical/Slate). Clear-and-insert |
| `evaluate` | `code` (async/await ok) | `{type, value}` | JS in the page realm |
| `cdp` | `method`, `params` | raw CDP response | Raw `chrome.debugger` passthrough — low-level escape hatch |
| `screenshot` | `format`(png\|jpeg), `quality`, `selector`, `path` | `{format, path, sizeBytes}` | Returns a **file path** — open it with the `read` tool |
| `network` | `cmd`(start\|stop\|list\|detail), `filter`, `requestId` | request/response data | |
| `upload` | `selector`, `files`(string[]) | `{success, fileCount}` | |
| `save_as_pdf` | `paper_format`, `landscape`, `scale`, `print_background`, `path` | `{path, sizeBytes}` | File path, same semantics as screenshot. 100 MB cap |
| `list_tabs` | — | `{tabs:[{tabId,url,title,active,groupTitle}]}` | |
| `close_tab` | — | `{closed: bool}` | Closes current tab |
| `close_session` | — | `{closed: int}` | Closes all session tabs |

## Sessions — one task = one session = one tab group

- Pick **one** session name at task start (`camping-research`, not per-site names), put it on every command, never switch mid-task.
- Name it after the **task**, not the site. Set `group_title` (user's language) on the first `navigate` only.
- Tell the user once: pages are grouped under «title» in their browser, closed whenever they ask.
- `close_session` **only** when the user explicitly asks.

## Current tab

Single-tab tools (`snapshot`, `click`, `fill`, `screenshot`, `save_as_pdf`) act on the **current tab** — last opened via `navigate` or selected via `find_tab`.

- `newTab:true` when pages coexist (comparing, cross-referencing); omit to reuse the current tab.
- To re-select a tab opened earlier, pass its **exact full URL** — take it from `list_tabs` or the earlier `navigate` result (a bare root domain like `kimi.com` can miss a `www.kimi.com` tab).
- To act on a page **the user** already has open: `find_tab` with `active:true` ("use my open X tab"). It **borrows** the tab the user is currently viewing, operated in place — not pulled into the session's tab group.
- `find_tab` without `active` searches only this session's tabs — it never touches the user's other tabs. If it errors "no tab matching", `navigate` with `newTab:true` instead.

## Reading pages: snapshot first

`snapshot` returns interactive elements with `@e` refs based on semantic role/name — they survive CSS class-hash churn that breaks hand-written selectors. Use `@e` refs directly with click/fill.

Fall back to `evaluate` (JS) only when: no `@e` ref exists, you need attributes not in the snapshot (e.g. `href`), or you need complex event dispatch / scrolling.

## Screenshots & PDFs

The daemon writes files to disk and returns a path. Never expect image bytes inline. Take the `.path` and view it with the `read` tool (it renders images). Caller-supplied `path` is honored verbatim (parent dirs created, existing file overwritten).

## Evaluate tips

- Always `JSON.stringify(data)` compact — never pretty-print (`null, 2` inflates responses and can truncate).
- `evaluate` shares the page's JS realm — re-declaring the same `const`/`let` across calls throws `SyntaxError`. Wrap in an IIFE: `(() => { const x = ...; return x; })()`.

## Text input & forms

- `fill` is **clear-and-insert**. To append: read current value via `evaluate`, concatenate, `fill` the result.
- No "press Enter" tool — click the submit button via its `@e` ref. For special keys (e.g. Escape to close a modal): `evaluate` with `document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`.

## Known limitations

- Sites that strictly check `event.isTrusted` (banking, captchas) ignore synthetic `click`/`fill`. Tell the user manual interaction is needed there. Trusted input is possible via `cdp` but treat as advanced.
- Cross-origin iframes: tools operate on the top frame. If the target lives in a cross-origin iframe, navigate to the iframe's URL directly.

## Recovery — if a call can't reach the daemon

Connection refused → start it yourself, don't ask the user (idempotent, safe anytime):

```bash
~/.kimi-webbridge/bin/kimi-webbridge start
```

Then retry. Check health first if unsure: `curl -s http://127.0.0.1:10086/status` → `{running, extension_connected, ...}` (need `extension_connected:true` for browser tools to work).

If the daemon is up but `extension_connected:false`, or an error says **"Please update the Kimi WebBridge extension"**, don't deep-troubleshoot — tell the user to update the extension and point them to https://www.kimi.com/features/webbridge.

**Never** run `stop` / `restart` / `uninstall` automatically — they kill a live daemon and fight the Kimi Desktop app's management. If a hard restart is truly needed, ask the user to do it themselves.
