# Session Forks (`/btw`)

Claude-style background side questions forked from the current Pi session.

## Primary command

```text
/btw [question]
```

- **With a question:** waits for the current main turn to settle, forks its conversation branch, starts a read-only answer in a separate Pi process, and opens an overlay. Press `Enter` (or `f`) to ask a follow-up in that same side conversation. Press `Esc` to return to the main session while the side answer keeps running.
- **Without a question:** reopens the overlay on the most recent side conversation. Use `Enter`/`f` to continue it, `←`/`→` to browse other side conversations, and `↑`/`↓` to scroll answers.
- **With no previous side questions:** prompts you to enter one.

Side questions and answers never enter the main model context.

## Inline diagrams

The overlay has **Answer** and **Diagram** tabs. The side agent can request one diagram on demand when you ask it to diagram, map, or visualize something, or when a visual materially improves an exploratory explanation. A diagram is supplemental: the **Answer** remains understandable on its own, and ordinary side questions do not render one.

When a diagram is available, press `Tab` (or `d`) to switch between **Answer** and **Diagram**. In the diagram view:

- drag to pan,
- press `+` or `-` to zoom,
- press `0` to fit the diagram,
- press `Tab`/`d` to return to the answer.

The image is rendered directly inside the `/btw` overlay. It does not open or reuse a Herdr pane. `Enter`/`f`, `←`/`→`, and `Esc`/`q` keep their normal follow-up, thread-navigation, and close behavior from either tab.

## Additional commands

| Command | Purpose |
| --- | --- |
| `/fork-ask <question>` | Start a side question without automatically opening the overlay |
| `/fork-continue <id> <question>` | Continue one side-thread session; follow-ups are serialized |
| `/forks` | List side threads and states |
| `/fork-show [id]` | Render the latest answer as a durable TUI-only entry |
| `/fork-stop [id]` | Stop a running side thread and discard queued follow-ups |
| `/fork-terminal` | Show a read-only `pi --fork '<current-session>' …` command for a new terminal |
| `/fork-terminal <id>` | Show a read-only `pi --session '<side-thread>' …` command for a new terminal |

Example:

```text
/btw What assumption are we making about cache invalidation?
# Press Enter in the overlay and ask a follow-up.
# Or press Esc, continue using the main session, then reopen it:
/btw
```

## What Pi already provides

Pi core has `/fork` and `/clone`, but both replace the active session. From a separate terminal, Pi also supports:

```bash
pi --fork '/path/to/current-session.jsonl'
```

The installed `pi-subagents` package can launch async agents with forked context, but its normal completion path reports results into the parent conversation. This extension is specifically for isolated side answers that do not alter or trigger the main conversation.

## Behavior and safety

- A request made during active main-thread work uses `ctx.waitForIdle()` rather than interrupting it. This avoids a copied transcript ending at an unresolved tool call or partial parallel tool batch.
- Each initial side question gets a normal Pi JSONL conversation file. Overlay follow-ups continue that same child session and run sequentially; up to four different side conversations may run concurrently.
- Child tools are restricted to `read`, `grep`, `find`, and `ls`, plus one presentation-only inline-diagram request tool; `bash`, `edit`, and `write` are explicitly excluded.
- Child extension discovery is disabled by default to avoid recursive or unrelated extension side effects.
- Inline diagrams are rendered by the parent extension with the `termdiag` file presenter and stored beneath the private Session Forks state directory. They never create a dedicated terminal pane or grant the child a general command-execution tool.
- The child inherits the selected model, thinking level, cwd, and project trust decision.
- Unsafe signed/redacted Anthropic thinking blocks are removed from copied transcripts. An Anthropic child is forced to thinking `off` if sanitation was needed.
- Active children are terminated on Pi shutdown, session replacement, or `/reload`. An in-flight question is recorded as interrupted; follow-ups that had not started remain queued and resume when that parent session is loaded again.
- Metadata is stored atomically under `~/.pi/agent/state/session-forks/<parent-session-id>.json`. Full answers remain in child session JSONL files. Explicitly using `/fork-show` also persists its displayed (maximum 50 KiB) TUI-only copy in the parent JSONL, but that custom entry is excluded from model context.
- A parent-session runtime lease prevents two Pi processes from concurrently managing the same `/btw` registry. A second Pi opened on the same parent session can still use Pi normally, but this extension stays disabled there until the first runtime exits.
- A per-thread lock prevents two managed prompts from writing one child file. A separately launched Pi CLI does not honor that lock, so stop the managed side thread before opening its file in another terminal.
- After an extremely narrow crash during child launch, the extension may retain an **unverified** lock rather than risk a second writer. If no related Pi child is running, the lock can be removed manually at `<child-session>.session-forks.lock`. On Windows, orphan PIDs are never killed automatically because their command line cannot be safely verified.

### Important limitation

Only conversation history is snapshotted. The child reads the **live working tree**, so it can observe edits made by the main thread after the fork. Its available tools cannot modify files.

## Extension-provided model providers

Children use `--no-extensions` by default. If the selected model provider is itself registered by an extension rather than built into Pi or configured through `models.json`, launch the parent Pi process with:

```bash
PI_SESSION_FORK_LOAD_EXTENSIONS=1 pi
```

The child then loads normal extensions, while Session Forks detects `PI_SESSION_FORK_CHILD=1` and does not register recursively. The read-only tool allowlist still applies.

A parent started with a one-off CLI `--api-key` cannot safely forward that secret to a subprocess. Side threads therefore require credentials available through Pi's auth store or the provider's normal environment variable.

## Installation

Installed globally at:

```text
~/.pi/agent/extensions/session-forks/
```

Inline diagrams require the `termdiag` binary at `~/.cargo/bin/termdiag` or on `PATH`. Set `TERMDIAG_BIN` to an explicit executable path when it is installed elsewhere.

Run `/reload` once after installation or editing.
