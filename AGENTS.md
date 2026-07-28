# Pi Harness contributor instructions

## Architecture

Pi Harness is a thin, deterministic process-construction layer for Pi. It owns four fresh-process workload profiles: `eng`, `design`, `research`, and `learn`. It does not turn one Pi session into a universal mode-switching harness.

Each launch must remain deny-by-default: disable discovered extensions, skills, prompt templates, project resources, and profile-controlled CLI overrides, then load only the selected manifest's prompt, extensions, skills, tools, and session directory. Keep the catalog as inventory; catalog membership must never imply loading.

Use a distinct `PI_CODING_AGENT_DIR` and session directory per workload. Generated settings exist for child-process discovery and must contain only the profile's declared child extensions/packages. Preserve extension-only package filters so Engineering and Research children do not rediscover package skills, prompts, themes, or unrelated global packages.

Share only the base authentication file, model store, themes, and `workbench/writer-leases`. Keep sessions, settings, prompts, tool sets, and extension discovery isolated. Never copy credentials into the repository or generated settings.

## Workload boundaries

- `eng` appends to Pi's default coding prompt, inherits project context, and is the only profile that exposes Pi Engineering actions for engineering work. Keep its web, Engineering, Plannotator, hashline, and LSP resources explicit. Pi Engineering remains the sole subagent assignment and write-lock authority.
- `design` replaces the prompt, inherits project context, and may write only an explicitly requested prototype in a designated area. Keep Chrome design-only and preserve its package-native lazy authorization; do not pre-register its tool schemas in the harness.
- `research` replaces the prompt, disables parent project context, and is tool-level read-only. Pi Engineering is present only to host the pinned shared subagent runtime before Pi Research. Do not expose Engineering model tools or shell/mutation tools.
- `learn` replaces the prompt, disables project context, and stays single-agent. Mutation belongs only in an explicit lab/container. Keep paper study and reproduction method in `skills/learning-lab`, not in the system prompt.

Keep cross-profile handoffs explicit through code, Git state, `DESIGN.md`, `RESEARCH.md`/`DECISION.md`-formatted output, and `LAB.md`. Do not add hidden shared conversation state, a central router, recursive delegation, or a generic plugin/tool marketplace.

## Herdr boundary

Herdr is the outer terminal/process supervisor. Profiled launches use automatic process/screen detection and may set `HERDR_AGENT=pi` as a wrapper hint. Do not load Herdr's official Pi extension by default: its current native restore runs bare `pi --session`, which cannot reconstruct the workload launcher after a full server restart. Normal detach/reattach remains the preferred persistence path.

## Change discipline

Prefer data changes in `workloads/*.json`, identity/authority changes in `system-prompts/`, reusable learning method in `skills/learning-lab/`, and small deterministic logic in `lib/`. Keep the runtime dependency-free on Node 24 or newer. Pin Pi and package versions in the catalog; never auto-update them at launch.

Treat the base Pi agent directory and generated profile homes as user state. Profile generation may create exact directories, atomic settings files, and conservative symlinks, but must refuse to overwrite or retarget unrelated paths. Never modify base settings, credentials, installed packages, remotes, or Herdr configuration automatically.

For behavior changes, add a focused contract test. Runtime probes must remain no-LLM, ephemeral, and exact about active tools, required commands, agent directories, and child package discovery.

## Validation

Run before handoff:

```sh
npm test
pi-doctor
```

When Pi Engineering or Pi Research pins or behavior change, also run the validation required by those repositories. Do not commit, push, publish, deploy, or alter credentials/remotes without explicit authorization.
