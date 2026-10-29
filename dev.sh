#!/usr/bin/env bash
# Back-compat wrapper → ./sernicord
# Prefer: ./sernicord  or  ./sernicord menu
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
cmd=${1:-dev}
shift || true
case "$cmd" in
  -h|--help|help) exec "$ROOT/sernicord" help ;;
  up|dev|"") exec "$ROOT/sernicord" dev "$@" ;;
  *) exec "$ROOT/sernicord" "$cmd" "$@" ;;
esac
