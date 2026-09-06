#!/usr/bin/env bash
set -euo pipefail

no_watchdog=false
force=false
for arg in "$@"; do
  case "${arg}" in
    --no-watchdog) no_watchdog=true ;;
    --force) force=true ;;
  esac
done

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
supervisor_timeout="${MCP_SUPERVISOR_TIMEOUT_MS:-120000}"
tool_surface="${MCP_TOOL_SURFACE:-}"
if [[ -z "${tool_surface}" ]]; then
  if [[ "${access_mode}" == "unrestricted" ]]; then tool_surface="hybrid"; else tool_surface="legacy"; fi
fi
projects_root="$(dirname "${project_root}")"
default_skill_hub="${project_root}/packages/skill-hub"
if [[ ! -d "${default_skill_hub}" ]]; then default_skill_hub="${projects_root}/chatgpt-skill-hub"; fi

default_thinkforge="${project_root}/packages/thinkforge"
if [[ ! -d "${default_thinkforge}" ]]; then default_thinkforge="${projects_root}/ThinkForge-MCP"; fi

default_memory="${project_root}/packages/memory"
if [[ ! -d "${default_memory}" ]]; then default_memory="${projects_root}/ourbook"; fi

skill_hub_dir="${MCP_SKILL_HUB_DIR:-${default_skill_hub}}"
thinkforge_dir="${MCP_THINKFORGE_DIR:-${default_thinkforge}}"
memory_dir="${MCP_MEMORY_DIR:-${default_memory}}"
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

# Ownership guard: ChatGPTMCP is the sole owner of the `chatgpt-machine`
# alias and the `chatgpt-machine-runtime` profile (see start-tunnel.ps1).
owner_path="${project_root}/.tunnel/runtime-owner.json"
runtime_profile_path="${profile_dir}/chatgpt-machine-runtime.yaml"
profile_owner=""
if [[ -f "${runtime_profile_path}" ]]; then
  profile_owner="$(grep -o '[A-Za-z]:[^" ]*/\(apps/server/\)\?dist/supervisor\.js' "${runtime_profile_path}" | head -n 1 | sed 's|/\(apps/server/\)\?dist/supervisor\.js$||')"
fi
daemon_ready=false
if "${client_path}" runtimes status chatgpt-machine --json 2>/dev/null | grep -q '"ready": *true'; then
  daemon_ready=true
fi
if [[ "${daemon_ready}" == true ]]; then
  if [[ -n "${profile_owner}" && "${profile_owner}" == "${project_root}" ]]; then
    echo 'Tunnel already running and owned by this checkout; nothing to do.'
    "${project_root}/scripts/status-tunnel.sh"
    exit 0
  fi
  if [[ "${force}" != true ]]; then
    echo "Runtime already owned by: ${profile_owner:-unknown-foreign-owner}. Stop it there first, or re-run with --force to reclaim ownership." >&2
    exit 1
  fi
  echo "WARNING: reclaiming live runtime from foreign owner: ${profile_owner}" >&2
  "${client_path}" runtimes stop chatgpt-machine >/dev/null 2>&1 || true
elif [[ -n "${profile_owner}" && "${profile_owner}" != "${project_root}" ]]; then
  echo "WARNING: runtime profile ${runtime_profile_path} points outside this checkout (${profile_owner}); reclaiming ownership." >&2
  "${client_path}" runtimes stop chatgpt-machine >/dev/null 2>&1 || true
fi
open_arg=""
if [[ "${access_mode}" == "unrestricted" ]]; then open_arg=" --dangerously-open-machine"; fi
supervisor_path="${project_root}/dist/supervisor.js"
if [[ -f "${project_root}/apps/server/dist/supervisor.js" ]]; then
  supervisor_path="${project_root}/apps/server/dist/supervisor.js"
fi
mcp_command="node ${supervisor_path} --supervisor-timeout ${supervisor_timeout} --root \"${workspace_root}\" --policy ${policy} --approval-mode ${approval_mode} --machines-file \"${machines_file}\"${open_arg}${provider_args}"

# Claim ownership (mirrors start-tunnel.ps1 runtime-owner.json).
mkdir -p "${project_root}/.tunnel"
commit="$(git -C "${project_root}" rev-parse HEAD 2>/dev/null || true)"
build_commit="$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).commit||"")}catch(e){}' "${project_root}/apps/server/dist/build-info.json")"
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '{\n  "alias": "chatgpt-machine",\n  "owner": "%s",\n  "startedAt": "%s",\n  "commit": "%s",\n  "buildCommit": "%s",\n  "supervisor": "%s",\n  "pid": null\n}\n' "${project_root}" "${started_at}" "${commit}" "${build_commit}" "${supervisor_path}" > "${owner_path}"
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

