#!/usr/bin/env bash
# Block private / non-publishable paths and obvious secret payloads before commit.
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$ROOT"

RED=$'\033[31m'
GRN=$'\033[32m'
YLW=$'\033[33m'
RST=$'\033[0m'

fail=0

deny_path_regexes=(
  # Real env files only — .env.example is publishable
  '(^|/)\.env$'
  '(^|/)\.env\.(local|secret|private|production|development|prod|dev)(\..*)?$'
  '(^|/)data(/|$)'
  '(^|/)discord-app(/|$)'
  '(^|/)(vencord|equicord|vesktop|betterdiscord|clients)(/|$)'
  '(^|/)node_modules(/|$)'
  '(^|/)(\.cache|tmp|temp)(/|$)'
  '(^|/)(Cookies|Login Data|Local Storage|Session Storage|IndexedDB)(/|$)'
  '(^|/).*\.leveldb(/|$)'
  '(^|/)vencord-settings-backup'
  '(^|/).*\.pem$'
  '(^|/)id_rsa'
  '(^|/)id_ed25519'
  '(^|/)credentials\.json$'
  '(^|/)sernicord\.local\.conf$'
  '(^|/)\.sernicord\.local$'
)

# Content heuristics on staged text files (small files only)
content_regexes=(
  'mfa\.[A-Za-z0-9_-]{20,}'
  '[\w-]{24}\.[\w-]{6}\.[\w-]{25,}'   # classic Discord user token shape
  'Bot [A-Za-z0-9_\-.]{50,}'
  '-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----'
  'ghp_[A-Za-z0-9]{20,}'
  'gho_[A-Za-z0-9]{20,}'
  'github_pat_[A-Za-z0-9_]{20,}'
  'xox[baprs]-'
  'AKIA[0-9A-Z]{16}'
)

if [[ $# -gt 0 ]]; then
  files=("$@")
else
  mapfile -t files < <(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null || true)
fi

if [[ ${#files[@]} -eq 0 || -z "${files[0]:-}" ]]; then
  echo "${GRN}secret-scan: nothing to check${RST}"
  exit 0
fi

for f in "${files[@]}"; do
  [[ -z "$f" ]] && continue
  for re in "${deny_path_regexes[@]}"; do
    if [[ "$f" =~ $re ]]; then
      echo "${RED}BLOCKED path:${RST} $f  (matched /$re/)"
      fail=1
    fi
  done

  # Never allow live settings dumps
  base=$(basename "$f")
  case "$base" in
    settings.json|native-settings.json|Cookies|Cookies-journal)
      echo "${RED}BLOCKED private file:${RST} $f"
      fail=1
      ;;
  esac

  if [[ -f "$f" ]] && [[ -s "$f" ]]; then
    size=$(wc -c < "$f" | tr -d ' ')
    if (( size > 0 && size < 2000000 )) && file -b --mime-type "$f" 2>/dev/null | grep -Eq '^(text/|application/(json|javascript|xml)|inode/x-empty)'; then
      for cre in "${content_regexes[@]}"; do
        if grep -EIq -- "$cre" "$f" 2>/dev/null; then
          echo "${RED}BLOCKED secret-like content:${RST} $f  (/$cre/)"
          fail=1
        fi
      done
    fi
  fi
done

if (( fail )); then
  echo
  echo "${RED}secret-scan failed.${RST} Refusing to commit private / non-publishable material."
  echo "${YLW}Sernicord only publishes tooling + plugins/. Discord profiles live under data/ and stay local.${RST}"
  exit 1
fi

echo "${GRN}secret-scan: clean (${#files[@]} file(s))${RST}"
exit 0
