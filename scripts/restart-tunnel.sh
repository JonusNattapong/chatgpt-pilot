#!/usr/bin/env bash
set -euo pipefail

# ChatGPTMCP is the sole owner of the `chatgpt-machine` tunnel lifecycle.
# Restart = stop then start (start reclaims the runtime profile when a
# legacy checkout owns it, and respawns the watchdog unless opted out).
no_watchdog=false
force=false
for arg in "$@"; do
  case "${arg}" in
    --no-watchdog) no_watchdog=true ;;
    --force) force=true ;;
  esac
done

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

"${project_root}/scripts/stop-tunnel.sh"

start_args=()
if [[ "${no_watchdog}" == true ]]; then start_args+=(--no-watchdog); fi
if [[ "${force}" == true ]]; then start_args+=(--force); fi
"${project_root}/scripts/start-tunnel.sh" "${start_args[@]:-}"
