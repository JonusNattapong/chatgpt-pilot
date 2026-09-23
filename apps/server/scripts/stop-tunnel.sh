#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
client_path="${project_root}/tools/tunnel-client-v0.0.13/tunnel-client"
watchdog_pid_file="${project_root}/.tunnel/watch-tunnel.pid"

if [[ ! -x "${client_path}" ]]; then
  echo "Tunnel client not found or not executable: ${client_path}" >&2
  exit 1
fi

# PIDs get reused. A recorded PID from an earlier session can belong to an
# unrelated process by now, so every PID is re-identified before it is killed.
if [[ -f "${watchdog_pid_file}" ]]; then
  watchdog_pid="$(cat "${watchdog_pid_file}" 2>/dev/null || true)"
  if [[ "${watchdog_pid}" =~ ^[0-9]+$ ]]; then
    watchdog_args="$(ps -p "${watchdog_pid}" -o args= 2>/dev/null || true)"
    if [[ "${watchdog_args}" == *watch-tunnel* ]]; then
      kill "${watchdog_pid}" 2>/dev/null || true
    elif [[ -n "${watchdog_args}" ]]; then
      echo "Ignoring stale watchdog PID ${watchdog_pid}"
    fi
  fi
  rm -f "${watchdog_pid_file}"
fi

# "runtimes stop" kills the recorded daemon PID without checking what it is now.
# When the runtime is already down, skip the stop so a reused PID is never hit.
status_json="$("${client_path}" runtimes status chatgpt-machine --json 2>/dev/null || true)"
if [[ -n "${status_json}" ]]; then
  read -r running daemon_pid < <(printf '%s' "${status_json}" | node -e '
    let text = "";
    process.stdin.on("data", (chunk) => { text += chunk; });
    process.stdin.on("end", () => {
      try {
        const status = JSON.parse(text);
        const pid = Number.isInteger(status?.process?.pid) ? status.process.pid : 0;
        console.log(`${status.process_running === true} ${pid}`);
      } catch {
        console.log("unknown 0");
      }
    });
  ' 2>/dev/null || echo "unknown 0")
  if [[ "${running}" != "unknown" ]]; then
    daemon_name=""
    if [[ "${daemon_pid}" != "0" ]]; then daemon_name="$(ps -p "${daemon_pid}" -o comm= 2>/dev/null || true)"; fi
    if [[ "${running}" != "true" || "$(basename "${daemon_name}")" != tunnel-client* ]]; then
      if [[ -n "${daemon_name}" && "$(basename "${daemon_name}")" != tunnel-client* ]]; then
        echo "Recorded tunnel-client PID ${daemon_pid} now belongs to ${daemon_name}; not stopping it."
      fi
      echo "Tunnel runtime chatgpt-machine is already stopped."
      exit 0
    fi
  fi
fi

"${client_path}" runtimes stop chatgpt-machine
