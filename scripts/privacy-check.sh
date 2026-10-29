#!/usr/bin/env bash
# Blocks personal or machine-specific data from entering this public repo.
#
#   scripts/privacy-check.sh              scan all tracked + untracked (non-ignored) files
#   scripts/privacy-check.sh --staged     scan only staged changes (pre-commit)
#   scripts/privacy-check.sh --range A..B scan commits in range (content + author/committer emails)
#
# Checks: this machine's home path / username, non-noreply emails, common secret formats,
# and any extra terms listed (one per line) in the git-ignored file `.privacy-denylist`.
# A line containing `privacy-check:allow` is skipped (use for synthetic test fixtures).
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
mode="${1:-all}"
range="${2:-}"
fail=0
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

# --- collect content to scan into $tmp as "file:line:text" -------------------------------
self="scripts/privacy-check.sh"
case "$mode" in
  --staged)
    git diff --cached --name-only --diff-filter=ACMR -z | while IFS= read -r -d '' f; do
      [ "$f" = "$self" ] && continue
      git show ":$f" 2>/dev/null | grep -nI '' | sed "s|^|$f:|" >>"$tmp" || true
    done
    ;;
  --range)
    [ -n "$range" ] || { echo "usage: $0 --range A..B" >&2; exit 2; }
    git diff "$range" -U0 -- . ":(exclude)$self" | grep -E '^\+' | grep -vE '^\+\+\+' | sed 's|^+|diff:0:|' >>"$tmp" || true
    while IFS= read -r email; do
      case "$email" in
        *@users.noreply.github.com|noreply@anthropic.com|noreply@github.com) ;;
        *) echo "✗ commit identity uses a non-noreply email: $email"; fail=1 ;;
      esac
    done < <(git log --format='%ae%n%ce' "$range" | sort -u)
    if git log --format='%B' "$range" | grep -qiE '^co-authored-by:'; then
      echo "✗ commit message contains a Co-Authored-By trailer (commits in this repo carry no co-author trailers)"; fail=1
    fi
    ;;
  all|*)
    { git ls-files -z; git ls-files -z --others --exclude-standard; } | while IFS= read -r -d '' f; do
      [ "$f" = "$self" ] || [ ! -f "$f" ] && continue
      grep -nI '' "$f" 2>/dev/null | sed "s|^|$f:|" >>"$tmp" || true
    done
    ;;
esac

scan() { # label, extended-regex, [flags]
  local hits
  hits="$(grep -v 'privacy-check:allow' "$tmp" | grep -E ${3:-} -- "$2" || true)"
  if [ -n "$hits" ]; then
    echo "✗ $1:"; echo "$hits" | head -20 | sed 's/^/    /'; fail=1
  fi
}

# --- machine identity (built at runtime, so this script itself contains nothing personal) --
esc() { printf '%s' "$1" | sed 's#[][\.*^$|()+?{}]#\\&#g'; }
# Skipped on CI runners: their home/username (e.g. "runner") are generic, not personal data.
if [ -z "${CI:-}" ]; then
  user="$(id -un)"
  scan "home directory path" "$(esc "$HOME")"
  if [ "${#user}" -ge 5 ]; then scan "local username" "$(esc "$user")" -i; fi
fi

# --- emails (allow noreply + reserved example domains) --------------------------------------
emails="$(grep -v 'privacy-check:allow' "$tmp" | grep -oE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' |
  grep -vE '@users\.noreply\.github\.com$|^noreply@anthropic\.com$|^noreply@github\.com$|@example\.(com|org|net)$|\.(test|invalid|example|localhost)$' |
  sort -u || true)"
if [ -n "$emails" ]; then echo "✗ email addresses found:"; echo "$emails" | sed 's/^/    /'; fail=1; fi

# --- secrets ---------------------------------------------------------------------------------
scan "Anthropic API key" 'sk-ant-[A-Za-z0-9_-]{20,}'
scan "GitHub token" '(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}'
scan "AWS access key" 'AKIA[0-9A-Z]{16}'
scan "Slack token" 'xox[abprs]-[A-Za-z0-9-]{10,}'
scan "private key block" '-----BEGIN [A-Z ]*PRIVATE KEY-----'

# --- personal denylist (git-ignored, local only) --------------------------------------------
if [ -f .privacy-denylist ]; then
  while IFS= read -r term || [ -n "$term" ]; do
    term="${term%%#*}"; term="$(printf '%s' "$term" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [ -z "$term" ] && continue
    scan "denylisted term" "$(esc "$term")" -i
  done < .privacy-denylist
fi

if [ "$fail" -ne 0 ]; then
  echo "privacy-check: FAILED. Remove the data above (or mark synthetic fixture lines with privacy-check:allow)."
  exit 1
fi
echo "privacy-check: OK"
