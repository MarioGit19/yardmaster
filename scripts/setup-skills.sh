#!/usr/bin/env bash
# Installs / refreshes the third-party agent skills used to build Yardmaster into .claude/skills/
# (project scope, git-ignored, so third-party content is never committed). Re-run any time to update.
#
# Also fetches read-only references into .claude/references/ (git-ignored): source the build loop
# may study and adapt, never import directly (see CLAUDE.md "Third-party effects").
#
# Plugins (Impeccable, Context7) are declared in .claude/settings.json and managed by Claude Code:
#   claude plugin marketplace update && claude plugin update impeccable@impeccable --scope project
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
dest=".claude/skills"
refs=".claude/references"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$dest" "$refs"
: >"$dest/SOURCES.txt"

# repo|directory holding the skills|skill names (space separated)
sources=(
  "emilkowalski/skills|skills|emil-design-eng animate review-animations animation-performance find-animation-opportunities improve-animations apple-design break-ui"
  "vercel-labs/agent-skills|skills|react-best-practices web-design-guidelines"
  "motiondivision/ai-kit|plugins/motion/skills|motion"
  "kaankiziltug/logo-design-skill|skills|logo-design"
  "luongnv89/skills|skills|logo-designer"
)

for entry in "${sources[@]}"; do
  IFS='|' read -r repo base skills <<<"$entry"
  dir="$work/${repo//\//_}"
  git clone -q --depth 1 "https://github.com/$repo" "$dir"
  sha="$(git -C "$dir" rev-parse --short HEAD)"
  for s in $skills; do
    [ -f "$dir/$base/$s/SKILL.md" ] || { echo "✗ $repo: skill '$s' not found" >&2; exit 1; }
    rm -rf "${dest:?}/$s"
    cp -R "$dir/$base/$s" "$dest/$s"
    [ -f "$dir/LICENSE" ] && cp "$dir/LICENSE" "$dest/$s/LICENSE.upstream"
    echo "$s  $repo@$sha" >>"$dest/SOURCES.txt"
  done
  echo "✓ $repo@$sha: $skills"
done

# React Bits (MIT + Commons Clause): the TypeScript + Tailwind variants, for reference only.
dir="$work/react-bits"
git clone -q --depth 1 https://github.com/DavidHDev/react-bits "$dir"
sha="$(git -C "$dir" rev-parse --short HEAD)"
rm -rf "${refs:?}/react-bits"
mkdir -p "$refs/react-bits"
cp -R "$dir/src/ts-tailwind/." "$refs/react-bits/"
cp "$dir/LICENSE.md" "$refs/react-bits/LICENSE.md"
echo "react-bits  DavidHDev/react-bits@$sha" >"$refs/SOURCES.txt"
echo "✓ DavidHDev/react-bits@$sha → $refs/react-bits"
