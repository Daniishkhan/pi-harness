# Pi Harness

A sanitized, portable snapshot of my day-to-day [Pi](https://pi.dev) setup: custom extensions, workflow skills, vendored agent-team machinery, themes, prompts, and a safety-first browser tool.

The repository is a Pi package. It intentionally excludes credentials, sessions, run history, browser profiles, OAuth state, and machine-specific configuration. The autonomous delivery pipeline (pickup → plan → execute → review → ship) lives in a separate private repository and is registered locally, not vendored here.

## Included

### Extensions

- **Lean startup** — defers web, subagent, MCP, and team tools behind a `load_tool_group` gate so sessions start with a minimal prompt footprint; `/tool-profile`, `/tool-status`, and `/prompt-audit` commands.
- **Questionnaire** — single- and multi-question interactive clarification UI.
- **Nodes Qwen** — optional self-hosted Qwen (vLLM, OpenAI-compatible) provider for cheap fan-out and bulk subagent work. Configured entirely through environment variables; registers nothing unless `QWEN_BASE_URL` is set.
- **Session Forks (`/btw`)** — isolated, read-only side conversations with optional inline diagrams.
- **Vertex AI bootstrap** — optional non-secret routing defaults and `/vertex-ai-status` for Pi's native Vertex provider.
- **Computer use** — a vendored safety-first Playwright/Chrome package with explicit approvals for external and high-risk browser actions.

The generated Herdr lifecycle extension is deliberately not vendored. Install it through Herdr so updates remain managed by its owner:

```sh
herdr integration install pi
```

### Vendored packages

- **pi-teams** (`packages/pi-teams/`) — spawned teammates with a durable file mailbox, shared task board, and structured protocols for plan review and deep research. Loaded through this repository's package manifest.
- **pi-computer-use** (`packages/pi-computer-use/`) — the browser automation package described above.

### Skills

- `herdr` — explicit Herdr terminal and agent control.
- `product-design` — journey-first UI design in Paper.
- `multi-model` — run one prompt against 2–3 models in dedicated Herdr panes and compare the responses. Requires HERDR_ENV=1.
- `webbridge` — drive the logged-in Chrome/Edge through the Kimi WebBridge daemon.
- `computer-use` — safe browser-debugging workflow (from the vendored package).
- `pi-teams` — team orchestration protocol (from the vendored package).

### Supporting configuration

- Gruvbox Dark and Catppuccin Mocha themes.
- A deep-research prompt template that routes through the pi-teams research protocol.
- A Powerline footer color override.
- Sanitized settings and MCP examples that are never applied automatically.

## Requirements

- Node.js 24 or newer.
- Pi installed and available as `pi`.
- Git and an authenticated GitHub CLI for pipeline shipping (external to this repo).
- Google Chrome for `computer-use`.
- Optional: Herdr, Paper, Obsidian, Google Cloud CLI, and `termdiag` depending on the features you use.

## Install from a clone

This repository is private, so first ensure your GitHub account has access:

```sh
git clone git@github.com:Daniishkhan/pi-harness.git
cd pi-harness
npm install
npm run check
npm run install:setup
```

The installer:

1. installs the pinned third-party Pi packages listed below;
2. registers this checkout as a local Pi package;
3. installs the Powerline color override only when it will not overwrite a different existing file.

It does **not** copy settings, MCP credentials, Vertex account details, authentication, or Herdr configuration. Preview its actions with:

```sh
npm run install:setup -- --dry-run
```

Useful options:

```text
--no-deps       register only this package
--force-config  replace the Powerline color override
```

Restart Pi or run `/reload` after installation.

You can also install the package directly from Git, but the helper is still the easiest way to install the companion packages and local configuration:

```sh
pi install git:git@github.com:Daniishkhan/pi-harness.git
```

## Pinned companion packages

The installer registers these independently so Pi loads each package's own manifest correctly:

| Package | Version | Purpose |
| --- | ---: | --- |
| `pi-web-access` | `0.24.0` | Web search and content retrieval |
| `pi-subagents` | `0.52.1` | Delegation, review, and workflow runtime |
| `pi-powerline-footer` | `0.15.1` | Powerline editor/footer UI |
| `pi-lsp` | `0.1.7` | LSP diagnostics and navigation |
| `pi-mcp-adapter` | `2.26.1` | MCP servers and direct MCP tools |
| `@hk_net/pi-usage-bars` | `0.4.2` | Usage visualization |
| `pi-notify` | `1.4.0` | Desktop notifications |
| `@mobrienv/pi-tidy-tools` | `0.4.1` | Compact tool rendering |

## Apply personal preferences manually

`settings.example.json` contains the non-secret model, theme, Powerline, and subagent preferences from this setup. Merge only the keys you want into `~/.pi/agent/settings.json`; do not replace an existing file wholesale. Model IDs are account-dependent, so remove or change any model you cannot access.

`mcp.example.json` contains Paper, Linear, and Obsidian endpoints. Merge selected servers into `~/.pi/agent/mcp.json`. The Obsidian example reads its token from `OBSIDIAN_MCP_TOKEN`; never commit the value.

### Self-hosted Qwen provider

The `nodes-qwen` extension registers nothing unless configured. To use it:

```sh
export QWEN_BASE_URL="https://your-vllm-host.example/v1"
export QWEN_API_KEY="your-deployment-key"
```

Never commit the endpoint or key; both are environment-only.

### Vertex AI

The Vertex extension is optional and loads safely without account configuration. To use it:

```sh
export GOOGLE_CLOUD_PROJECT="your-gcp-project-id"
export GOOGLE_CLOUD_LOCATION="global"
gcloud auth application-default login
```

See [`extensions/vertex-ai/README.md`](extensions/vertex-ai/README.md) for the ignored local-file alternative.

### Session Fork diagrams

`/btw` side conversations work without diagrams. Inline diagrams additionally require `termdiag` on `PATH` or an explicit `TERMDIAG_BIN`. See [`extensions/session-forks/README.md`](extensions/session-forks/README.md).

### Computer use

Run `/computer setup`, then `/computer connect dev` for an isolated session browser. Attaching to personal Chrome requires enabling remote debugging and confirming every connection. External origins and high-risk actions fail closed without interactive approval. See [`packages/pi-computer-use/README.md`](packages/pi-computer-use/README.md).

## Verify

```sh
npm run check
pi -e . --list-models >/dev/null
```

The repository check validates package resource paths, skill/agent frontmatter, JSON, symlinks, private filenames, local account paths, and common credential formats.

## Security boundary

Pi extensions execute with the user's full system permissions, and skills can instruct an agent to take actions. Review this repository and every pinned third-party package before installing. No setup script can make untrusted agent code safe.

Never add these files or their contents to the repository:

- `~/.pi/agent/auth.json` or model/auth stores;
- `settings.json` or `mcp.json` with live credentials;
- service-account JSON, API keys, OAuth tokens, cookies, or browser profiles;
- sessions, transcripts, subagent artifacts, mission state, or run history.
