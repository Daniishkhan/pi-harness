# Pi Harness contributor guide

This repository is a sanitized, installable snapshot of a personal Pi setup. Keep it portable and safe to share.

## Boundaries

- Never commit `auth.json`, OAuth material, API keys, service-account files, MCP bearer tokens, cookies, session transcripts, run artifacts, browser profiles, or other runtime state.
- Keep machine- and account-specific values in ignored local files or environment variables. Examples may contain placeholders only.
- The Herdr lifecycle extension is managed by `herdr integration install pi`; do not vendor its generated file.
- Keep third-party Pi packages as pinned installer dependencies unless this repository owns the source. The local `pi-computer-use` package is intentionally vendored here.
- Preserve capability restrictions on `plan-worker`, `spec-reviewer`, and `quality-reviewer`.
- Do not make setup installation overwrite an existing user configuration by default.

## Structure

- `extensions/`: package-loaded custom Pi extensions.
- `skills/`: user-authored skills and their references/assets.
- `agents/`: custom agents discovered by `pi-subagents` through the package manifest.
- `packages/pi-computer-use/`: the locally owned browser package.
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
