#!/usr/bin/env bash
# multi-model fanout: run one prompt against 2-3 Herdr agent kinds in a dedicated tab.
# Companion script for SKILL.md in this directory. Requires HERDR_ENV=1.
#
# What it does:
#   1. Creates a new background tab and lays out N lane panes inside it.
#   2. Starts one Herdr agent per lane in its own pane.
#   3. Broadcasts the exact same prompt to every lane.
#   4. Waits for every lane to settle (idle/done/blocked) or time out.
#   5. Collects each lane's transcript plus a manifest.json into a run directory.
#
# Lanes are either kinds (--kinds claude,codex,gemini) or full specs with
# native agent arguments (--lane 'pi -- --provider google --model gemini-3-pro').
#
# Created panes and their agents are LEFT OPEN so the user can watch them.
# The orchestrating agent reads the run directory and writes the comparison.

set -u

usage() {
  cat <<'EOF'
Usage: fanout.sh (--kinds LIST | --lane SPEC [--lane SPEC...]) (--prompt TEXT | --prompt-file PATH) [OPTIONS]

Run the same prompt against 2-3 Herdr agent kinds in a dedicated new tab,
wait for every lane to settle, and collect each transcript plus a manifest.

Lanes (choose one form; 2-3 lanes total):
  --kinds LIST          comma-separated agent kinds, e.g. claude,codex,gemini
  --lane SPEC           repeatable; SPEC is "KIND" or "KIND -- NATIVE_ARGS...",
                        e.g. --lane 'pi -- --provider google --model gemini-3-pro'
                        (native args are passed after "--" to herdr agent start)

Prompt (choose one):
  --prompt TEXT         exact prompt broadcast to every lane
  --prompt-file PATH    read the prompt from a file

Options:
  --cwd PATH            working directory for the new panes (default: caller cwd)
  --direction MODE      right | down | auto (default: auto from new-tab geometry)
  --timeout MS          per-lane settle timeout in ms (default: 600000)
  --out DIR             run directory (default: fresh temp dir under $TMPDIR)
  --dry-run             validate inputs and print the plan; change nothing
  -h, --help            this help

Only works inside a Herdr-managed pane (HERDR_ENV=1). The new tab is created in
the caller's workspace without taking focus. Its panes and agents are left open
for inspection; the script never closes them.
EOF
}

die() { printf 'fanout: %s\n' "$*" >&2; exit 1; }
warn() { printf 'fanout: warning: %s\n' "$*" >&2; }

KINDS="" PROMPT="" PROMPT_FILE="" CWD="$PWD" DIRECTION="auto" TIMEOUT_MS=600000 OUT="" DRY=0
LANE_SPECS=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --kinds)        KINDS="${2:-}";       shift 2 ;;
    --lane)         LANE_SPECS+=("${2:-}"); shift 2 ;;
    --prompt)       PROMPT="${2:-}";      shift 2 ;;
    --prompt-file)  PROMPT_FILE="${2:-}"; shift 2 ;;
    --cwd)          CWD="${2:-}";         shift 2 ;;
    --direction)    DIRECTION="${2:-}";   shift 2 ;;
    --timeout)      TIMEOUT_MS="${2:-}";  shift 2 ;;
    --out)          OUT="${2:-}";         shift 2 ;;
    --dry-run)      DRY=1;                shift ;;
    -h|--help)      usage; exit 0 ;;
    *)              die "unknown argument: $1" ;;
  esac
done

# ---- input validation ---------------------------------------------------------

[ -n "$KINDS" ] || [ "${#LANE_SPECS[@]}" -gt 0 ] || die "--kinds or at least one --lane is required"
[ -n "$KINDS" ] && [ "${#LANE_SPECS[@]}" -gt 0 ] && die "use either --kinds or --lane, not both"
[ -n "$PROMPT" ] || [ -n "$PROMPT_FILE" ] || die "provide --prompt TEXT or --prompt-file PATH"
[ -n "$PROMPT" ] && [ -n "$PROMPT_FILE" ] && die "provide only one of --prompt or --prompt-file"

case "$TIMEOUT_MS" in
  ''|*[!0-9]*) die "invalid --timeout: $TIMEOUT_MS" ;;
esac

case "$DIRECTION" in
  right|down|auto) ;;
  *) die "invalid --direction (right|down|auto): $DIRECTION" ;;
esac

if [ -n "$PROMPT_FILE" ]; then
  [ -f "$PROMPT_FILE" ] || die "prompt file not found: $PROMPT_FILE"
  PROMPT="$(cat "$PROMPT_FILE")"
fi
[ -n "$PROMPT" ] || die "prompt is empty"

# Build lanes: KIND[i] and ARGS[i] (bash 3.2 compatible).
KIND=() ARGS=()
if [ -n "$KINDS" ]; then
  OLD_IFS="$IFS"; IFS=','
  read -r -a KIND <<<"$KINDS"
  IFS="$OLD_IFS"
  for _ in "${KIND[@]}"; do ARGS+=(""); done
else
  for spec in "${LANE_SPECS[@]}"; do
    case "$spec" in
      *" -- "*) KIND+=("${spec%% -- *}"); ARGS+=("${spec#* -- }") ;;
      *)        KIND+=("$spec");            ARGS+=("") ;;
    esac
  done
fi

N="${#KIND[@]}"
[ "$N" -ge 2 ] && [ "$N" -le 3 ] || die "exactly 2 or 3 lanes required (got $N)"

for kind in "${KIND[@]}"; do
  printf '%s' "$kind" | grep -Eq '^[a-z][a-z0-9_-]{0,31}$' || die "invalid agent kind: $kind"
done

if [ "$DRY" -eq 1 ]; then
  printf 'dry-run plan\n'
  printf '  lanes:      %s\n' "$N"
  printf '  cwd:        %s\n' "$CWD"
  printf '  tab:        new background tab labeled multi-model\n'
  printf '  direction:  %s (resolved at runtime from new-tab geometry)\n' "$DIRECTION"
  printf '  timeout:    %sms per lane\n' "$TIMEOUT_MS"
  i=1
  while [ "$i" -le "$N" ]; do
    if [ -n "${ARGS[$((i - 1))]}" ]; then
      printf '  lane %d:     %s (native args: %s)\n' "$i" "${KIND[$((i - 1))]}" "${ARGS[$((i - 1))]}"
    else
      printf '  lane %d:     %s\n' "$i" "${KIND[$((i - 1))]}"
    fi
    i=$((i + 1))
  done
  printf '  prompt (%s chars):\n%s\n' "$(printf '%s' "$PROMPT" | wc -c | tr -d ' ')" "$PROMPT"
  printf 'dry-run: nothing was created or started\n'
  exit 0
fi

# ---- environment checks -------------------------------------------------------

[ "${HERDR_ENV:-}" = 1 ] || die "not running inside a Herdr-managed pane (HERDR_ENV=1 required)"
command -v herdr >/dev/null 2>&1 || die "herdr binary not found on PATH"
command -v jq   >/dev/null 2>&1 || die "jq is required"

# ---- run directory ------------------------------------------------------------

if [ -n "$OUT" ]; then
  mkdir -p "$OUT" || die "cannot create run directory: $OUT"
else
  OUT="$(mktemp -d "${TMPDIR:-/tmp}/multi-model.XXXXXX")" || die "mktemp failed"
fi
printf '%s\n' "$PROMPT" > "$OUT/prompt.md"

# ---- caller context and dedicated lane tab -----------------------------------

CALLER_JSON="$(herdr pane current --current 2>&1)" || die "herdr pane current failed: $(printf '%s' "$CALLER_JSON" | head -c 300)"
CALLER="$(printf '%s' "$CALLER_JSON" | jq -r '.result.pane.pane_id // empty')"
CALLER_TAB="$(printf '%s' "$CALLER_JSON" | jq -r '.result.pane.tab_id // empty')"
WORKSPACE="$(printf '%s' "$CALLER_JSON" | jq -r '.result.pane.workspace_id // empty')"
[ -n "$CALLER" ] || die "could not resolve caller pane"
[ -n "$CALLER_TAB" ] || die "could not resolve caller tab"
[ -n "$WORKSPACE" ] || die "could not resolve caller workspace"

TAB_JSON="$(herdr tab create --workspace "$WORKSPACE" --cwd "$CWD" --label multi-model --no-focus 2>&1)" \
  || die "tab create failed: $(printf '%s' "$TAB_JSON" | head -c 300)"
TAB="$(printf '%s' "$TAB_JSON" | jq -r '.result.tab.tab_id // empty')"
ROOT_PANE="$(printf '%s' "$TAB_JSON" | jq -r '.result.root_pane.pane_id // empty')"
[ -n "$TAB" ] || die "tab create returned no tab id"
[ -n "$ROOT_PANE" ] || die "tab create returned no root pane id"
printf 'fanout: tab %s created in workspace %s (focus preserved)\n' "$TAB" "$WORKSPACE"

if [ "$DIRECTION" = auto ]; then
  LAYOUT_JSON="$(herdr pane layout --pane "$ROOT_PANE" 2>&1)" || die "herdr pane layout failed: $(printf '%s' "$LAYOUT_JSON" | head -c 300)"
  DIMS="$(printf '%s' "$LAYOUT_JSON" | jq -r '.result.layout.panes[] | select(.pane_id == "'"$ROOT_PANE"'") | [.rect.width, .rect.height] | @tsv' 2>/dev/null)"
  read -r PW PH <<<"$DIMS"
  if [ "${PW:-0}" -gt "${PH:-0}" ] 2>/dev/null; then
    DIRECTION=right
  else
    DIRECTION=down
  fi
  printf 'fanout: tab root pane %s is %sx%s -> splitting %s\n' "$ROOT_PANE" "${PW:-?}" "${PH:-?}" "$DIRECTION"
fi

# ---- create lane panes inside the dedicated tab -------------------------------

# Lane 1 uses the tab's root pane. Split the newest lane for each remaining lane
# so three lanes become L1 | L2 | L3 without touching the caller's tab.
PANES=()
PANES[1]="$ROOT_PANE"
printf 'fanout: lane 1 pane %s ready (tab root)\n' "$ROOT_PANE"
TARGET="$ROOT_PANE"
i=2
while [ "$i" -le "$N" ]; do
  SPLIT_JSON="$(herdr pane split --pane "$TARGET" --direction "$DIRECTION" --cwd "$CWD" --no-focus 2>&1)" \
    || die "pane split failed: $(printf '%s' "$SPLIT_JSON" | head -c 300)"
  PANE="$(printf '%s' "$SPLIT_JSON" | jq -r '.result.pane.pane_id // empty')"
  [ -n "$PANE" ] || die "pane split returned no pane id"
  PANES["$i"]="$PANE"
  printf 'fanout: lane %d pane %s created\n' "$i" "$PANE"
  TARGET="$PANE"
  i=$((i + 1))
done

# ---- start one agent per lane -------------------------------------------------

START_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
NAMES=() STATES=() STARTED=() SENT=() ERRS=()

i=1
while [ "$i" -le "$N" ]; do
  kind="${KIND[$((i - 1))]}"
  NAME="m${i}-${kind}-$$"
  NAMES["$i"]="$NAME"
  STARTED["$i"]=0
  SENT["$i"]=0
  ERRS["$i"]=""

  ok=0
  attempt=1
  while [ "$attempt" -le 2 ]; do
    if [ "$attempt" -gt 1 ]; then sleep 3; fi
    if [ -n "${ARGS[$((i - 1))]}" ]; then
      read -r -a AARGS <<<"${ARGS[$((i - 1))]}"
      START_JSON="$(herdr agent start "$NAME" --kind "$kind" --pane "${PANES[$i]}" --timeout 120000 -- "${AARGS[@]}" 2>&1)"
    else
      START_JSON="$(herdr agent start "$NAME" --kind "$kind" --pane "${PANES[$i]}" --timeout 120000 2>&1)"
    fi
    rc=$?
    if [ "$rc" -eq 0 ]; then ok=1; break; fi
    ERR="$(printf '%s' "$START_JSON" | jq -r '.error.message // empty' 2>/dev/null | head -c 300)"
    [ -n "$ERR" ] || ERR="$(printf '%s' "$START_JSON" | head -c 300)"
    ERRS["$i"]="$ERR"
    attempt=$((attempt + 1))
  done

  if [ "$ok" -eq 1 ]; then
    STARTED["$i"]=1
    printf 'fanout: lane %d agent %s (%s) started\n' "$i" "$NAME" "$kind"
  else
    printf 'fanout: lane %d (%s) FAILED to start: %s\n' "$i" "$kind" "${ERRS[$i]}"
  fi
  i=$((i + 1))
done

# ---- broadcast the identical prompt to every started lane ----------------------

i=1
while [ "$i" -le "$N" ]; do
  if [ "${STARTED[$i]}" -eq 1 ]; then
    PROMPT_JSON="$(herdr agent prompt "${NAMES[$i]}" "$PROMPT" 2>&1)"
    rc=$?
    if [ "$rc" -eq 0 ]; then
      SENT["$i"]=1
      printf 'fanout: lane %d prompt sent\n' "$i"
    else
      ERR="$(printf '%s' "$PROMPT_JSON" | jq -r '.error.message // empty' 2>/dev/null | head -c 300)"
      [ -n "$ERR" ] || ERR="$(printf '%s' "$PROMPT_JSON" | head -c 300)"
      ERRS["$i"]="prompt failed: $ERR"
      printf 'fanout: lane %d prompt FAILED: %s\n' "$i" "${ERRS[$i]}"
    fi
  fi
  i=$((i + 1))
done

# ---- wait for every lane, then record its settled state ------------------------

i=1
while [ "$i" -le "$N" ]; do
  if [ "${SENT[$i]}" -eq 1 ]; then
    herdr agent wait "${NAMES[$i]}" --timeout "$TIMEOUT_MS" >/dev/null 2>&1
    rc=$?
    if [ "$rc" -eq 0 ]; then
      STATE="$(herdr agent get "${NAMES[$i]}" 2>/dev/null | jq -r '.result.agent.agent_status // "settled"')"
    else
      STATE="error"
      ERRS["$i"]="${ERRS[$i]}${ERRS[$i]:+; }wait failed (timeout or stalled)"
    fi
  else
    STATE="failed"
  fi
  STATES["$i"]="$STATE"
  printf 'fanout: lane %d final state: %s\n' "$i" "$STATE"
  i=$((i + 1))
done

# ---- collect transcripts and manifest ------------------------------------------

# Alternate-screen renders land in Herdr's scrollback slightly after settle;
# wait, then take two reads a few seconds apart and keep the longer one.
sleep 5

LANE_ENTRIES=()
i=1
while [ "$i" -le "$N" ]; do
  FILE="$OUT/${NAMES[$i]}.md"
  if [ "${STARTED[$i]}" -eq 1 ]; then
    TMP1="$OUT/.read1.$i"; TMP2="$OUT/.read2.$i"
    herdr agent read "${NAMES[$i]}" --source recent-unwrapped --lines 400 > "$TMP1" 2>/dev/null
    sleep 4
    herdr agent read "${NAMES[$i]}" --source recent-unwrapped --lines 400 > "$TMP2" 2>/dev/null
    if [ "$(wc -c < "$TMP2" 2>/dev/null || echo 0)" -gt "$(wc -c < "$TMP1" 2>/dev/null || echo 0)" ]; then
      mv "$TMP2" "$FILE"
    else
      mv "$TMP1" "$FILE"
    fi
    [ -s "$FILE" ] || {
      warn "could not read transcript for lane $i"
      printf '_transcript read failed for lane %d_\n' "$i" > "$FILE"
    }
  else
    printf '_lane %d never started: %s_\n' "$i" "${ERRS[$i]}" > "$FILE"
  fi
  LANE_ENTRIES+=("$(jq -n \
    --arg i "$i" \
    --arg name "${NAMES[$i]}" \
    --arg kind "${KIND[$((i - 1))]}" \
    --arg args "${ARGS[$((i - 1))]}" \
    --arg pane "${PANES[$i]}" \
    --arg state "${STATES[$i]}" \
    --arg started "${STARTED[$i]}" \
    --arg sent "${SENT[$i]}" \
    --arg err "${ERRS[$i]}" \
    --arg file "$FILE" \
    '{index: ($i | tonumber), name: $name, kind: $kind,
      native_args: (if $args == "" then null else $args end),
      pane_id: $pane, state: $state,
      started: ($started == "1"), prompt_sent: ($sent == "1"),
      error: (if $err == "" then null else $err end),
      transcript_file: $file}')")
  i=$((i + 1))
done

LANES_JSON="$(printf '%s\n' "${LANE_ENTRIES[@]}" | jq -s '.')"
jq -n \
  --arg created "$START_TIME" \
  --arg workspace "$WORKSPACE" \
  --arg caller "$CALLER" \
  --arg caller_tab "$CALLER_TAB" \
  --arg tab "$TAB" \
  --arg direction "$DIRECTION" \
  --arg cwd "$CWD" \
  --arg timeout "$TIMEOUT_MS" \
  --arg out "$OUT" \
  --argjson lanes "$LANES_JSON" \
  '{created_at: $created, workspace_id: $workspace, caller_pane: $caller,
    caller_tab_id: $caller_tab, lane_tab_id: $tab, direction: $direction, cwd: $cwd,
    timeout_ms: ($timeout | tonumber), out_dir: $out, prompt_file: "prompt.md", lanes: $lanes}' \
  > "$OUT/manifest.json" || die "failed to write manifest"

# ---- summary -------------------------------------------------------------------

printf '\n==== multi-model run complete ====\n'
printf 'run dir:     %s\n' "$OUT"
printf 'lane tab:    %s (workspace %s)\n' "$TAB" "$WORKSPACE"
printf 'direction:   %s\n' "$DIRECTION"
printf 'caller pane: %s in tab %s (focus preserved)\n' "$CALLER" "$CALLER_TAB"
printf '%-4s %-24s %-10s %-10s %s\n' 'lane' 'agent' 'kind' 'state' 'pane'
i=1
while [ "$i" -le "$N" ]; do
  printf '%-4d %-24s %-10s %-10s %s\n' "$i" "${NAMES[$i]}" "${KIND[$((i - 1))]}" "${STATES[$i]}" "${PANES[$i]}"
  i=$((i + 1))
done
printf '\nAll lane panes and agents were left open for inspection.\n'
