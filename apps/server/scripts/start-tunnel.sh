#!/usr/bin/env bash
set -euo pipefail

no_watchdog=false
if [[ "${1:-}" == "--no-watchdog" ]]; then no_watchdog=true; fi

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
platform="$(uname -s)"
case "$(uname -m)" in
  arm64|aarch64) asset_arch="arm64" ;;
  x86_64) asset_arch="amd64" ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

client_path="${project_root}/tools/tunnel-client-v0.0.13/tunnel-client"
if [[ "${platform}" == "Darwin" ]]; then
  profile_dir="${HOME}/Library/Application Support/tunnel-client"
else
  profile_dir="${XDG_CONFIG_HOME:-${HOME}/.config}/tunnel-client"
fi
tunnel_id="${OPENAI_TUNNEL_ID:?Set OPENAI_TUNNEL_ID before starting the tunnel.}"
organization_id="${OPENAI_ORGANIZATION_ID:?Set OPENAI_ORGANIZATION_ID before starting the tunnel.}"
workspace_root="${MCP_WORKSPACE_ROOT:-$(dirname "${project_root}")}"
access_mode="${MCP_ACCESS_MODE:-unrestricted}"
policy="${MCP_POLICY:-admin}"
approval_mode="${MCP_APPROVAL_MODE:-mrtr}"
machines_file="${MCP_MACHINES_FILE:-${project_root}/.chatgpt-machine/machines.json}"
supervisor_timeout="${MCP_SUPERVISOR_TIMEOUT_MS:-600000}"
tool_surface="${MCP_TOOL_SURFACE:-}"
if [[ -z "${tool_surface}" ]]; then
  if [[ "${access_mode}" == "unrestricted" ]]; then tool_surface="hybrid"; else tool_surface="legacy"; fi
fi
projects_root="$(dirname "${project_root}")"
skill_hub_dir="${MCP_SKILL_HUB_DIR:-${projects_root}/chatgpt-skill-hub}"
thinkforge_dir="${MCP_THINKFORGE_DIR:-${projects_root}/ThinkForge-MCP}"
memory_dir="${MCP_MEMORY_DIR:-${projects_root}/ourbook}"
provider_args=""
if [[ "${tool_surface}" == "hybrid" ]]; then
  if [[ "${access_mode}" != "unrestricted" ]]; then
    echo "Hybrid tool surface requires MCP_ACCESS_MODE=unrestricted." >&2
    exit 1
  fi
  for provider_dir in "${skill_hub_dir}" "${thinkforge_dir}" "${memory_dir}"; do
    if [[ ! -d "${provider_dir}" ]]; then
      echo "Hybrid provider directory not found: ${provider_dir}" >&2
      exit 1
    fi
  done
  provider_args=" --tool-surface hybrid --skill-hub-dir \"${skill_hub_dir}\" --thinkforge-dir \"${thinkforge_dir}\" --memory-dir \"${memory_dir}\""
fi
if [[ "${platform}" == "Darwin" ]]; then
  runtime_key="$(security find-generic-password -a "${USER}" -s chatgpt-machine-mcp-tunnel -w)"
else
  key_file="${project_root}/.tunnel/control-plane-api-key"
  if [[ -n "${CONTROL_PLANE_API_KEY:-}" ]]; then
    runtime_key="${CONTROL_PLANE_API_KEY}"
  elif [[ -r "${key_file}" ]]; then
    if [[ "$(stat -c '%a' "${key_file}")" != "600" ]]; then
      echo "Runtime key file must have mode 600: ${key_file}" >&2
      exit 1
    fi
    runtime_key="$(<"${key_file}")"
  else
    echo "Set CONTROL_PLANE_API_KEY or create ${key_file} with mode 600." >&2
    exit 1
  fi
fi

if [[ ! -x "${client_path}" ]]; then
  echo "Tunnel client not found or not executable: ${client_path}" >&2
  asset_os="$(tr '[:upper:]' '[:lower:]' <<<"${platform}")"
  echo "Download tunnel-client-v0.0.13-${asset_os}-${asset_arch}.zip, extract it there, then run chmod +x on tunnel-client." >&2
  exit 1
fi
if [[ "${runtime_key}" != sk-* ]]; then
  echo "Keychain entry did not return a valid runtime API key." >&2
  exit 1
fi

mkdir -p "${profile_dir}"
open_arg=""
if [[ "${access_mode}" == "unrestricted" ]]; then open_arg=" --dangerously-open-machine"; fi
mcp_command="node ${project_root}/dist/supervisor.js --supervisor-timeout ${supervisor_timeout} --root \"${workspace_root}\" --policy ${policy} --approval-mode ${approval_mode} --machines-file \"${machines_file}\"${open_arg}${provider_args}"
CONTROL_PLANE_API_KEY="${runtime_key}" "${client_path}" runtimes connect \
  --alias chatgpt-machine \
  --admin-profile default \
  --profile chatgpt-machine-runtime \
  --profile-dir "${profile_dir}" \
  --tunnel-id "${tunnel_id}" \
  --organization-id "${organization_id}" \
  --runtime-api-key env:CONTROL_PLANE_API_KEY \
  --mcp-command "${mcp_command}"

"${project_root}/scripts/status-tunnel.sh"

watchdog_pid_file="${project_root}/.tunnel/watch-tunnel.pid"
if [[ "${no_watchdog}" != true && "${MCP_TUNNEL_WATCHDOG:-}" != "1" && -x "${project_root}/scripts/watch-tunnel.sh" ]]; then
  existing_pid="$(cat "${watchdog_pid_file}" 2>/dev/null || true)"
  if [[ ! "${existing_pid}" =~ ^[0-9]+$ ]] || ! kill -0 "${existing_pid}" 2>/dev/null; then
    mkdir -p "${project_root}/.tunnel"
    nohup "${project_root}/scripts/watch-tunnel.sh" >/dev/null 2>&1 &
    printf '%s' "$!" >"${watchdog_pid_file}"
    echo "Tunnel watchdog started (PID $!)"
  fi
fi
