#!/usr/bin/env bash
# Unattended build loop: runs headless Claude Code once per PLAN.md task until done or blocked.
#
#   loop/loop.sh                 run until all tasks are done / a [HUMAN] task / blocked
#   MAX_ITERS=5 loop/loop.sh     cap iterations
#   touch loop/.state/STOP       stop gracefully after the current iteration
#   loop/loop.sh --resume <id>   first finish an interrupted iteration (its session id is in its log)
#
# Env:
#   YARDMASTER_LOOP_PERMISSION_MODE  permission mode for claude -p (default: auto)
#   YARDMASTER_LOOP_MODEL            model alias/name (default: your Claude Code default)
#   YARDMASTER_LOOP_PUSH             1 = push after each successful iteration (default: 1)
#   MAX_ITERS                    default 200
#   MAX_STALLS                   consecutive iterations without a ticked task before stopping (default 2)
set -uo pipefail

cd "$(git rev-parse --show-toplevel)"
mkdir -p loop/logs loop/.state
rm -f loop/.state/BLOCKED loop/.state/STOP

resume_id=""
if [ "${1:-}" = --resume ]; then
  resume_id="${2:-}"
  [[ "$resume_id" =~ ^[0-9a-f-]{36}$ ]] || { echo "✗ --resume needs a session id"; exit 1; }
fi

# The CBOARD_LOOP_* names from before the rename still work.
MODE="${YARDMASTER_LOOP_PERMISSION_MODE:-${CBOARD_LOOP_PERMISSION_MODE:-auto}}"
PUSH="${YARDMASTER_LOOP_PUSH:-${CBOARD_LOOP_PUSH:-1}}"
MAX_ITERS="${MAX_ITERS:-200}"
MAX_STALLS="${MAX_STALLS:-2}"
model_args=()
model="${YARDMASTER_LOOP_MODEL:-${CBOARD_LOOP_MODEL:-}}"
[ -n "$model" ] && model_args=(--model "$model")

next_task() { grep -m1 -E '^- \[ \] ' PLAN.md || true; }
done_count() { grep -cE '^- \[x\] ' PLAN.md || true; }

for bin in claude git pnpm node python3; do
  command -v "$bin" >/dev/null || { echo "✗ '$bin' not found on PATH"; exit 1; }
done
[ -f .claude/skills/motion/SKILL.md ] && [ -f .claude/references/SOURCES.txt ] || scripts/setup-skills.sh

stalls=0
for ((i = 1; i <= MAX_ITERS; i++)); do
  task="$(next_task)"
  if [ -z "$task" ]; then echo "✓ All tasks in PLAN.md are done."; exit 0; fi
  if [[ "$task" == *"[HUMAN]"* ]]; then
    echo "⏸  Next task needs you:"; echo "   $task"
    echo "   Do it, tick it in PLAN.md, commit, then re-run loop/loop.sh"; exit 0
  fi
  if [ -z "$resume_id" ] && [ -n "$(git status --porcelain)" ]; then
    echo "✗ Working tree is dirty. Commit or stash before running the loop."; git status --short; exit 1
  fi

  before_done="$(done_count)"
  before_head="$(git rev-parse HEAD 2>/dev/null || echo none)"
  ts="$(date +%Y%m%d-%H%M%S)"
  log="loop/logs/$ts-iter$i.jsonl"
  echo "▶ [$i] $task"
  echo "  log: $log"

  if [ -n "$resume_id" ]; then
    prompt_args=(--resume "$resume_id" -p "This iteration was interrupted by the loop runner, not by you. Continue the same task from where you left off (the working tree has your changes), following the original instructions.")
    resume_id=""
  else
    prompt_args=(-p "$(cat loop/PROMPT.md)")
  fi
  claude "${prompt_args[@]}" \
    --permission-mode "$MODE" \
    --disallowedTools ScheduleWakeup CronCreate Monitor \
    --output-format stream-json --verbose \
    ${model_args[@]+"${model_args[@]}"} >"$log" 2>&1 &
  pid=$!
  # Background jobs ignore Ctrl+C in scripts, so pass it on.
  trap 'kill "$pid" 2>/dev/null; exit 130' INT TERM
  # A result event isn't always the end: claude -p resumes when a background task it started
  # finishes. Only a run whose last event is a result, with no child processes and a log quiet
  # for 3 minutes, is treated as hung and ended.
  ended=0
  while kill -0 "$pid" 2>/dev/null; do
    sleep 10
    if tail -n 1 "$log" | python3 -c 'import sys,json; sys.exit(0 if json.loads(sys.stdin.read()).get("type")=="result" else 1)' 2>/dev/null \
      && ! pgrep -P "$pid" >/dev/null \
      && python3 -c 'import os,sys,time; sys.exit(0 if time.time()-os.path.getmtime(sys.argv[1])>=180 else 1)' "$log"; then
      echo "  claude finished but didn't exit; ending it."; kill "$pid" 2>/dev/null; ended=1; break
    fi
  done
  wait "$pid"; code=$?
  trap - INT TERM
  [ "$ended" = 1 ] && code=0

  # Show the final result line, if any
  tail -n 1 "$log" | python3 -c 'import sys,json
try:
  o=json.loads(sys.stdin.read()); r=o.get("result") or ""
  print("  result:", (r[:400]+"…") if len(r)>400 else r)
  if "total_cost_usd" in o: print("  cost: $%.2f" % o["total_cost_usd"])
except Exception: pass' || true

  if [ $code -ne 0 ]; then echo "✗ claude exited with code $code (see $log)"; exit $code; fi
  if [ -f loop/.state/BLOCKED ]; then echo "⏸  Blocked: $(cat loop/.state/BLOCKED)"; exit 0; fi
  if [ -n "$(git status --porcelain)" ]; then
    echo "✗ Iteration left uncommitted changes; stopping for review."; git status --short; exit 1
  fi

  after_head="$(git rev-parse HEAD 2>/dev/null || echo none)"
  if [ "$after_head" != "$before_head" ]; then
    if ! scripts/privacy-check.sh --range "${before_head}..${after_head}"; then
      echo "✗ Privacy check failed on new commits. NOT pushing. Fix history before continuing."; exit 1
    fi
    if [ "$PUSH" = "1" ]; then git push -q origin HEAD || { echo "✗ push failed"; exit 1; }; fi
  fi

  if [ "$(done_count)" -gt "$before_done" ]; then stalls=0; else
    stalls=$((stalls + 1)); echo "⚠ No task ticked this iteration ($stalls/$MAX_STALLS)."
    [ "$stalls" -ge "$MAX_STALLS" ] && { echo "✗ Stalled; stopping."; exit 1; }
  fi
  if [ -f loop/.state/STOP ]; then echo "⏹  STOP file found; stopping."; exit 0; fi
done
echo "Reached MAX_ITERS=$MAX_ITERS."
