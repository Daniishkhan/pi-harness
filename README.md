# Pi Harness

Pi Harness starts Pi as one of four small, deterministic workload environments:

```text
pi-eng        engineering and delivery
pi-design     product design and prototypes
pi-research   read-only evidence work
pi-learn      reproducible learning labs
```

Each command creates a fresh Pi process with one workload prompt, an exact extension and skill set, an explicit tool allowlist, and a separate session namespace. This is process construction, not an in-session mode switch: changing workloads means handing off an artifact and starting the corresponding command.

## Architecture

```mermaid
flowchart TB
    H["Shell or Herdr pane<br/>processes, worktrees, persistence"] --> L["pi-eng · pi-design<br/>pi-research · pi-learn"]

    C["workloads/catalog.json<br/>trusted resource inventory and pins"] --> M["selected workload manifest<br/>prompt · extensions · skills · tools"]
    L --> M
    M --> P["fresh Pi process<br/>deny defaults, then load exact resources"]

    B["base ~/.pi/agent<br/>auth · model store · themes · installed packages"] -. "safe shared links and resolved paths" .-> PH
    P --> PH["~/.pi/profiles/profile<br/>generated child settings · isolated sessions"]
    WL["shared Pi Engineering<br/>writer-leases"] -. "one cross-profile mutation lock" .-> PH

    P --> W["selected worktree, prototype, source tree, or lab"]
    W --> A["durable handoff<br/>code · DESIGN.md · RESEARCH/DECISION · LAB.md"]
```

The layers have deliberately narrow jobs:

- **Herdr** owns panes, long-running processes, worktrees, and human attention through its normal terminal/screen supervision.
- **The launcher** owns workload selection and Pi process configuration.
- **A system prompt** defines identity, evidence standards, authority, artifacts, and stop conditions.
- **A skill** supplies an on-demand method inside that identity.
- **An extension** supplies executable capability or bounded orchestration.
- **Files and Git state** carry results between workloads; hidden cross-profile conversation state does not.

### Catalog versus loaded resources

[workloads/catalog.json](workloads/catalog.json) is the approved inventory: it maps stable names to local extension/package paths and records expected package versions. Being in the catalog does **not** load a resource.

The selected file under [workloads/](workloads/) names the extensions, skills, tools, prompt behavior, and child-process resources for one launch. The launcher starts Pi with `--no-extensions`, `--no-skills`, `--no-prompt-templates`, and `--no-approve`, then passes only that manifest's explicit resources. Attempts to override controlled isolation flags on the command line are rejected.

Before creating or refreshing any profile state, every launch probes `pi --version` and requires the exact catalog version. An ambient `pi update`, PATH change, or partial fleet rollout therefore fails closed instead of silently running an untested core against the workload contracts.

The separate profile home matters for subagents. A parent Pi process receives exact CLI resources, while a `pi-subagents` child discovers resources from `PI_CODING_AGENT_DIR`. Pi Harness therefore generates a minimal `settings.json` for each profile's children instead of letting them rediscover the global package set.

## Workload contracts

| Command | Prompt | Loaded capability | Context and mutation boundary | Handoff |
|---|---|---|---|---|
| `pi-eng` | Appends the engineering contract to Pi's default prompt | Pi Engineering, web retrieval, Plannotator, hashline editing, LSP | Project context enabled; mutation only in the selected Git worktree; Pi Engineering retains one writer | Working code plus fresh verification and delivery notes |
| `pi-design` | Replaces the default with the design contract | Web retrieval, design and librarian skills, plus the `/chrome` authorization command | Project context enabled; production is read-only unless an explicit prototype is requested in a designated area | `DESIGN.md`, references, screenshots, and optional prototype |
| `pi-research` | Replaces the default with the evidence-research contract | Read-only web tools and `/research`; Engineering is loaded only as the trusted subagent runtime host | Parent project context disabled; no shell or mutation tools | A `RESEARCH.md`- or `DECISION.md`-formatted response for a user or write-capable profile to persist |
| `pi-learn` | Replaces the default with the learning-scientist contract | Web retrieval plus the progressive-disclosure `learning-lab` skill | Project context disabled; writes and execution only in a designated lab/container, never a production checkout | `LAB.md`, experiment artifacts, implementation, and rerun evidence |

Web retrieval is the small cross-cutting capability. Pi Chrome is loaded only for design, and its `chrome_*` tools become active only after `/chrome authorize`; their schemas do not occupy the startup context. Pi Engineering is not loaded for design or learning. Learning remains single-agent until real usage demonstrates that another orchestration layer is worth its cost.

Pi Chrome controls an existing authorized Chrome profile on the **same host as Pi**. In a headless cloud/SSH VM, `pi-design` still has web retrieval, but Chrome automation requires a browser and bridge running on that VM (or a future remote-browser integration). It does not automatically reach a Chrome session on your local desktop.

The current Research package depends on Pi Engineering to host the pinned `pi-subagents` runtime. Its Engineering model tools are absent from the Research allowlist, so the Research parent remains read-only. Current Research child manifests explicitly inherit project context, however, even though the parent starts with `--no-context-files`. Until that package policy is tightened, run `pi-research` from a neutral research directory when inspecting an untrusted repository and refer to the repository by path.

## Requirements and setup

The catalog currently targets Node 24 or newer and Pi `0.82.1`; `herdr` must also be available on `PATH` (or configured with `PI_HARNESS_HERDR_BIN`). It expects the pinned packages and local Engineering/Research package links already present under the base Pi agent directory (normally `~/.pi/agent`). Authenticate once with bare `pi` and `/login` before using the harness: profile generation intentionally refuses to invent or copy missing authentication, model-store, or theme state. `pi-doctor` reports every missing path or version mismatch.

Install the launch commands into `~/.local/bin` and verify the complete harness:

```sh
cd /path/to/pi-harness
npm run install:launchers
pi-doctor
```

Make sure `~/.local/bin` is on `PATH`. Launcher installation is conservative: it creates or verifies known symlinks and refuses to replace an unrelated file or retarget an existing symlink.

`pi-doctor` validates the strict manifests, Node, Pi and Herdr availability, catalog paths and package pins, skills, profile homes, exact active tool sets, and required slash commands in real headless Pi processes. Useful narrower checks are:

```sh
pi-doctor research
pi-doctor --no-smoke
pi-eng --doctor
pi-learn --print-agent-dir
```

`--no-smoke` skips runtime probes; use it for a quick structural check, not final verification.

## Running work

Start interactively or pass an initial Pi prompt:

```sh
pi-eng
pi-design "Audit the onboarding flow and prepare DESIGN.md"
pi-research "Compare the architectural tradeoffs in these two repositories"
pi-learn "Study this paper and reproduce one central claim on a tiny local example"
```

The generic form is also available:

```sh
pi-run eng
pi-run design
pi-run research
pi-run learn
```

Ordinary Pi arguments such as model selection and thinking level pass through. `-c`/`--continue`, `-r`/`--resume`, and profile-local session IDs remain available. Explicit `--session` and `--fork` paths are accepted only when they resolve inside the selected profile's `sessions/` directory; cross-profile paths are rejected. Resource, prompt, tool, context, approval, and session-directory flags are owned by the workload manifest and cannot be overridden from the launcher command line.

## Profile homes and shared state

On first launch or doctor run, each workload is materialized under:

```text
~/.pi/profiles/
├── eng/
├── design/
├── research/
└── learn/
```

Each profile has its own generated `settings.json` and `sessions/`. The launcher sets both `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR`, so parent and child processes stay in the same workload boundary.

Four resources are intentionally linked to the base agent directory:

- `auth.json`
- `models-store.json`
- `themes/`
- `workbench/writer-leases/`

The first three avoid duplicating credentials and model/UI configuration. The writer-lease link ensures separate profile homes cannot accidentally create separate Pi Engineering write locks. Generated profile settings inherit non-resource base settings, force project trust to `never`, remove all global resource arrays, and add only the child extensions/packages declared by the selected workload. The harness also resets each generated profile's trust store on launch; Engineering specialist children independently reject project-local trust, so an earlier `/trust` decision cannot widen a child process.

This is context and capability isolation, not credential or operating-system isolation. Every profile intentionally shares base credentials, and loaded extensions run with the Pi process's user permissions. Use a separate base agent directory for a different credential domain, and run untrusted code in a container or VM with only the lab/worktree and minimum credentials mounted.

Portable installations can override paths without editing manifests:

| Variable | Default | Purpose |
|---|---|---|
| `PI_HARNESS_BASE_AGENT_DIR` | `~/.pi/agent` | Base auth, settings, installed resources, and writer leases |
| `PI_HARNESS_PROFILES_DIR` | `~/.pi/profiles` | Generated workload homes and sessions |
| `PI_HARNESS_SHARED_SKILLS_DIR` | `~/.agents/skills` | Cross-cutting skill source |
| `PI_HARNESS_PI_BIN` | `pi` | Pi executable |
| `PI_HARNESS_HERDR_BIN` | `herdr` | Herdr executable checked by the doctor |
| `PI_HARNESS_BIN_DIR` | `~/.local/bin` | Installed launcher symlinks |
| `PI_HARNESS_HOME_DIR` | OS home directory | Root used to derive the defaults above |

## Herdr lifecycle and restore boundary

Run one explicit `pi-<profile>` command in each Herdr pane. Herdr remains the outer supervisor through normal screen/process detection and [detach/reattach](https://herdr.dev/docs/session-state/); it should not recreate Pi's specialist graphs or choose a workload automatically.

Pi Harness deliberately does **not** load [Herdr's official Pi lifecycle extension](https://herdr.dev/docs/integrations/#pi). `--no-extensions` suppresses any global installation, and the workload manifests do not opt it back in. This keeps normal profiled sessions out of Herdr's native agent-restore path; no global uninstall or restore-disable step is required.

The reason is fidelity: the current native restore invokes bare `pi --session ...`, bypassing `pi-<profile>`. It cannot reconstruct the workload prompt, extensions, skills, tools, or agent home after a full Herdr server restart. Normal detach/reattach is safe while the process remains alive. If the process is gone, relaunch it with the matching profile: use `pi-<profile> --session <saved-session-path>` only for a path under that profile's `~/.pi/profiles/<profile>/sessions/`, or use a profile-local session ID. `pi-<profile> -r` is sufficient only when the intended session is available in that profile's picker.

Treat the official Pi integration as opt-in only after a profile-aware resume helper exists. Installing it globally is harmless to these deny-by-default launches, but adding it to a workload would reintroduce the native-restore caveat. The doctor warns when it finds the global integration file so this distinction remains visible.

## Artifact handoffs

Keep profile crossings explicit and reviewable:

```text
pi-research  -> RESEARCH.md / DECISION.md-formatted response
pi-design    -> DESIGN.md + references/prototype
pi-learn     -> LAB.md + reproducible experiment artifacts
pi-eng       -> code + tests + delivery evidence
```

Research is intentionally unable to persist its own report. The user can accept it, or a write-capable profile can save it in the chosen workspace. Design authority does not silently become production implementation authority. A successful learning experiment becomes engineering input only after its assumptions and reproducibility limits are recorded.

## Why tool loading is static for now

Pi supports dynamic tool activation, but it solves tool-schema pressure rather than extension isolation. Loading an extension and merely hiding its tools still executes privileged extension code. These four profiles have small enough startup tool sets that static manifests are easier to audit, reproduce, cache, and diagnose.

The deliberate exception is Pi Chrome's own authorization gate in `pi-design`: the extension and `/chrome` command load with the profile, while `chrome_*` tools activate only after authorization. The harness does not add another generic tool-search or mode-switching layer around it.

Add deferred loading only after measurements show that one profile's inactive schemas materially consume context. Keep the process-start profile boundary even then; a tool loader should optimize a profile, not turn one Pi process back into a universal harness.

## Changing the harness

- Change identity and authority in [system-prompts/](system-prompts/).
- Change a workload's resource selection in its strict JSON manifest under [workloads/](workloads/).
- Add an approved extension/package or skill path and version to [workloads/catalog.json](workloads/catalog.json) before selecting it.
- Keep reusable learning method in [skills/learning-lab](skills/learning-lab/), not in the learning system prompt.
- Do not edit generated profile settings; the launcher refreshes them from the manifests.
- Run `npm test` and `pi-doctor` after every manifest, launcher, prompt, or resource change.

Pi's relevant native mechanisms are documented in its [CLI usage](https://pi.dev/docs/latest/usage), [packages](https://pi.dev/docs/latest/packages), [extensions](https://pi.dev/docs/latest/extensions), [skills](https://pi.dev/docs/latest/skills), [environment variables](https://pi.dev/docs/latest/environment-variables), and [security model](https://pi.dev/docs/latest/security) references.
