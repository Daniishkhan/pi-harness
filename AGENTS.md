# Pi Harness contributor instructions

## Architecture

Pi Harness is a thin, deterministic process-construction layer for Pi. It owns four fresh-process workload profiles: `eng`, `design`, `research`, and `learn`. It does not turn one Pi session into a universal mode-switching harness.

Each launch must remain deny-by-default: disable discovered extensions, skills, prompt templates, project resources, and profile-controlled CLI overrides, then load only the selected manifest's prompt, extensions, skills, tools, and session directory. Keep the catalog as inventory; catalog membership must never imply loading.

Use a distinct `PI_CODING_AGENT_DIR` and session directory per workload. Generated settings exist for child-process discovery and must contain only the profile's declared child extensions/packages. Preserve extension-only package filters so Engineering and Research children do not rediscover package skills, prompts, themes, or unrelated global packages.

Share only the base authentication file, model store, themes, and `workbench/writer-leases`. Keep sessions, settings, prompts, tool sets, and extension discovery isolated. Never copy credentials into the repository or generated settings. A cell may seed `0600` authentication and model-store copies into its private retained state so OAuth can refresh without mounting the host files writable.

## Workload boundaries

- `eng` appends to Pi's default coding prompt, inherits project context, and is the only profile that exposes Pi Engineering actions for engineering work. Keep its web, Engineering, Plannotator, hashline, and LSP resources explicit. Pi Engineering remains the sole subagent assignment and write-lock authority.
- `design` replaces the prompt, inherits project context, and may write only an explicitly requested prototype in a designated area. Keep Chrome design-only and preserve its package-native lazy authorization; do not pre-register its tool schemas in the harness.
- `research` replaces the prompt, disables parent project context, and is tool-level read-only. Pi Engineering is present only to host the pinned shared subagent runtime before Pi Research. Do not expose Engineering model tools or shell/mutation tools.
- `learn` replaces the prompt, disables project context, and stays single-agent. Mutation belongs only in an explicit lab/container. Keep paper study and reproduction method in `skills/learning-lab`, not in the system prompt.

Keep cross-profile handoffs explicit through code, Git state, `DESIGN.md`, `RESEARCH.md`/`DECISION.md`-formatted output, and `LAB.md`. Do not add hidden shared conversation state, a central router, recursive delegation, or a generic plugin/tool marketplace.

## Herdr and cell boundary

Direct launches keep Herdr as the outer terminal/process supervisor. Profiled launches use automatic process/screen detection and may set `HERDR_AGENT=pi` as a wrapper hint. Do not load Herdr's official Pi extension by default: its current native restore runs bare `pi --session`, which cannot reconstruct the workload launcher after a full server restart.

Linux VPS launches may opt into rootless Podman cells with `PI_HARNESS_EXECUTION=cell`. Keep Herdr as an attach client only: create an interactive TTY container, start it through the lingering user systemd manager, and attach with signal proxying disabled. Never auto-restart a stopped cell or retain a launch request after Pi begins; either behavior could replay a mutating prompt. Keep the image and selected runtime resources read-only, host credentials unmounted, private cell credentials and task sessions isolated, and the selected workspace as the only project mutation surface. Do not mount a host home, SSH agent or keys, container socket, devices, or host networking. Before reading any request, the immutable entrypoint may use only the minimum network/identity capabilities needed to deny known cloud metadata routes and drop to the caller's keep-id identity; Pi and all workload code must start with zero inherited, permitted, effective, and ambient capabilities under `no-new-privileges`. Because Pi Engineering's PID leases cannot cross PID namespaces, use cell-local writer leases and enforce one retained mutation-capable cell per canonical Git worktree at the host cell-manager boundary.

## Change discipline

Prefer data changes in `workloads/*.json`, identity/authority changes in `system-prompts/`, reusable learning method in `skills/learning-lab/`, and small deterministic logic in `lib/`. Keep the runtime dependency-free on Node 24 or newer. Pin Pi and package versions in the catalog; never auto-update them at launch.

Treat the base Pi agent directory, generated profile homes, and retained cell homes as user state. Profile and cell generation may create exact directories, atomic state files, conservative symlinks, managed containers, and workspace leases, but must refuse to overwrite, retarget, or remove unrelated paths. Removing a cell runtime must retain its home and sessions. Never modify base settings, credentials, installed packages, remotes, or Herdr configuration automatically.

For behavior changes, add a focused contract test. Runtime probes must remain no-LLM, ephemeral, and exact about active tools, required commands, agent directories, and child package discovery.

## Validation

Run before handoff:

```sh
npm test
pi-doctor
```

When Pi Engineering or Pi Research pins or behavior change, also run the validation required by those repositories. Do not commit, push, publish, deploy, or alter credentials/remotes without explicit authorization.
