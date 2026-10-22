#!/usr/bin/env bash
# Installs / refreshes the third-party agent skills used to build c-board into .claude/skills/
# (project scope, git-ignored, so third-party content is never committed). Re-run any time to update.
#
# Plugins (Impeccable, Context7) are declared in .claude/settings.json and managed by Claude Code:
#   claude plugin marketplace update && claude plugin update impeccable@impeccable --scope project
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
dest=".claude/skills"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$dest"
: >"$dest/SOURCES.txt"

# repo|skill names (space separated)
sources=(
  "emilkowalski/skills|emil-design-eng animate review-animations animation-performance find-animation-opportunities improve-animations apple-design break-ui"
  "vercel-labs/agent-skills|react-best-practices web-design-guidelines"
)

for entry in "${sources[@]}"; do
  repo="${entry%%|*}"
  skills="${entry#*|}"
  dir="$work/${repo//\//_}"
  git clone -q --depth 1 "https://github.com/$repo" "$dir"
  sha="$(git -C "$dir" rev-parse --short HEAD)"
  for s in $skills; do
    [ -f "$dir/skills/$s/SKILL.md" ] || { echo "✗ $repo: skill '$s' not found" >&2; exit 1; }
    rm -rf "${dest:?}/$s"
    cp -R "$dir/skills/$s" "$dest/$s"
    [ -f "$dir/LICENSE" ] && cp "$dir/LICENSE" "$dest/$s/LICENSE.upstream"
    echo "$s  $repo@$sha" >>"$dest/SOURCES.txt"
  done
  echo "✓ $repo@$sha: $skills"
done
