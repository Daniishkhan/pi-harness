# Pi Harness contributor guide

This repository is a sanitized, installable snapshot of a personal Pi setup. Keep it portable and safe to share.

## Boundaries

- Never commit `auth.json`, OAuth material, API keys, service-account files, MCP bearer tokens, cookies, session transcripts, run artifacts, browser profiles, or other runtime state.
- Keep machine- and account-specific values in ignored local files or environment variables. Examples may contain placeholders only. The Qwen provider endpoint and key (`QWEN_BASE_URL`, `QWEN_API_KEY`) are environment-only.
- The Herdr lifecycle extension is managed by `herdr integration install pi`; do not vendor its generated file.
- Keep third-party Pi packages as pinned installer dependencies unless this repository owns the source. `pi-computer-use` and `pi-teams` are intentionally vendored here.
- The autonomous delivery pipeline (plan/execute/review/ship skills and its restricted agents) lives in a separate private repository; do not copy it into this one.
- Do not make setup installation overwrite an existing user configuration by default.

## Structure

- `extensions/`: package-loaded custom Pi extensions.
- `skills/`: user-authored skills and their references/assets.
- `packages/pi-computer-use/`: the locally owned browser package.
- `packages/pi-teams/`: the locally owned agent-teams package (mailboxes, board, plan-review and research protocols).
- `config/`: optional configuration copied or merged by the installer.
- `settings.example.json` and `mcp.example.json`: manual, sanitized examples.

## Verification

Run before committing or pushing:

```sh
npm install
npm run check
pi -e . --list-models >/dev/null
```

Review `git diff --cached` and run an independent secret scan before publication.
