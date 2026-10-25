#!/usr/bin/env bash
# Copies the README screenshots out of `pnpm shots` / `pnpm e2e` output (demo mode only) into
# docs/screenshots/ as WebP. Run those first; needs `cwebp` (brew install webp).
#
#   scripts/readme-shots.sh
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
src="artifacts/shots"
out="docs/screenshots"
mkdir -p "$out"
command -v cwebp >/dev/null || { echo "cwebp not found (brew install webp)" >&2; exit 1; }

# destination name → source shot
shots=(
  "hero:focus-1440x900-dark"
  "layout-minimal:overview-1440x900-dark"
  "layout-office:layout-office-active-1440-dark"
  "layout-grid:layout-grid3d-active-1440-dark"
  "layout-transit:layout-transit-rest-1440-dark"
  "layout-retro:layout-retro-rest-1440-dark"
  "attention:attention-1440-dark"
  "phone:phone-overview-minimal-dark"
)

for pair in "${shots[@]}"; do
  name="${pair%%:*}"
  file="$src/${pair#*:}.png"
  [ -f "$file" ] || { echo "missing $file: run pnpm shots and pnpm e2e first" >&2; exit 1; }
  resize=()
  [ "$name" = "phone" ] && resize=(-resize 390 0)
  cwebp -quiet -q 82 -m 6 ${resize[@]+"${resize[@]}"} "$file" -o "$out/$name.webp"
done
ls -l "$out"
