#!/usr/bin/env bash
# ChatGPTMCP Doctor (bash port): read-only diagnostics, mirrors doctor.ps1.
# Exit 0 = HEALTHY (warnings allowed), 1 = UNHEALTHY.
set -uo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
platform="$(uname -s)"
case "$(uname -m)" in
  arm64|aarch64) _arch="arm64" ;;
  *) _arch="amd64" ;;
esac
client_path="${project_root}/tools/tunnel-client-v0.0.13/tunnel-client"
if [[ "${platform}" == "Darwin" ]]; then
  profile_dir="${HOME}/Library/Application Support/tunnel-client"
else
  profile_dir="${XDG_CONFIG_HOME:-${HOME}/.config}/tunnel-client"
fi
runtime_profile="${profile_dir}/chatgpt-machine-runtime.yaml"
owner_path="${project_root}/.tunnel/runtime-owner.json"
watchdog_pid_file="${project_root}/.tunnel/watch-tunnel.pid"
server_dist="${project_root}/apps/server/dist/index.js"

pass=0; warn=0; fail=0
result() { # name status detail
  printf '%-20s %-4s %s\n' "$1" "$2" "$3"
  case "$2" in
    PASS) pass=$((pass + 1)) ;;
    WARN|SKIP) warn=$((warn + 1)) ;;
    *) fail=$((fail + 1)) ;;
  esac
}

echo ''
echo 'ChatGPTMCP Doctor'
echo ''

# 1. Runtime owner ---------------------------------------------------------
owner=""
if [[ -f "${owner_path}" ]]; then
  owner="$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).owner||"")}catch(e){}' "${owner_path}" 2>/dev/null)"
fi
if [[ "${owner}" == "${project_root}" ]]; then
  result 'Runtime owner' 'PASS' "${project_root}"
elif [[ -n "${owner}" ]]; then
  result 'Runtime owner' 'FAIL' "claimed by ${owner}"
else
  result 'Runtime owner' 'WARN' 'no claim file (never started from here?)'
fi

# 2. Git state --------------------------------------------------------------
if ! git -C "${project_root}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  result 'Git state' 'WARN' 'not a git checkout?'
else
  dirty="$(git -C "${project_root}" status --porcelain 2>/dev/null | grep -c . || true)"
  if [[ "${dirty}" -eq 0 ]]; then result 'Git state' 'PASS' 'clean'
  else result 'Git state' 'WARN' "${dirty} dirty file(s)"; fi
fi

# 3. Build freshness ---------------------------------------------------------
fresh_json="$(node -e '
const fs=require("fs"),path=require("path");
const root=process.argv[1];
const pairs=[["server","apps/server"],["skill-hub","packages/skill-hub"],["thinkforge","packages/thinkforge"],["memory","packages/memory"]];
const out={};
for(const [name,rel] of pairs){
  const src=path.join(root,rel,"src"),dist=path.join(root,rel,"dist");
  if(!fs.existsSync(src)) continue;
  if(!fs.existsSync(dist)){out[name]="missing";continue;}
  const walk=(d,ext)=>{let m=null;for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory()){const r=walk(p,ext);if(r!==null&&(m===null||r>m))m=r;}else if(e.name.endsWith(ext)){const t=fs.statSync(p).mtimeMs;if(m===null||t>m)m=t;}}return m;};
  const newest=walk(src,".ts");
  let oldest=null;
  const walkMin=(d)=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walkMin(p);else if(e.name.endsWith(".js")){const t=fs.statSync(p).mtimeMs;if(oldest===null||t<oldest)oldest=t;}}};
  try{walkMin(dist);}catch(e){}
  out[name]=(newest!==null&&(oldest===null||newest>oldest))?"stale":"fresh";
}
console.log(JSON.stringify(out));' "${project_root}")"
missing="$(echo "${fresh_json}" | grep -o '"[a-z-]*":"missing"' | cut -d'"' -f2 | tr '\n' ' ')"
stale="$(echo "${fresh_json}" | grep -o '"[a-z-]*":"stale"' | cut -d'"' -f2 | tr '\n' ' ')"
if [[ -n "${missing// }" ]]; then result 'Build freshness' 'FAIL' "missing dist: ${missing}- run 'pnpm build'"
elif [[ -n "${stale// }" ]]; then result 'Build freshness' 'FAIL' "stale: ${stale}- run 'pnpm build'"
else result 'Build freshness' 'PASS' 'dist newer than src'; fi

# 4. Tunnel ------------------------------------------------------------------
status_json=""
if [[ -x "${client_path}" ]]; then
  status_json="$("${client_path}" runtimes status chatgpt-machine --json 2>/dev/null || true)"
fi
tunnel_state="$(echo "${status_json}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(j.process_running&&j.healthy&&j.ready?"ready":("state="+(j.runtime_state||"unknown")))}catch(e){console.log("down")}})')"
tunnel_pid="$(echo "${status_json}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).process.pid||"")}catch(e){}})')"
if [[ "${tunnel_state}" == "ready" ]]; then result 'Tunnel' 'PASS' "connected (pid ${tunnel_pid})"
else result 'Tunnel' 'FAIL' "${tunnel_state:-not connected}"; fi

# 5. Profile ownership ---------------------------------------------------------
profile_owner=""
if [[ -f "${runtime_profile}" ]]; then
  profile_owner="$(grep -o '[A-Za-z]:[^" ]*/\(apps/server/\)\?dist/supervisor\.js' "${runtime_profile}" | head -n 1 | sed 's|/\(apps/server/\)\?dist/supervisor\.js$||')"
  if [[ -z "${profile_owner}" ]] && grep -qF "${project_root}" "${runtime_profile}"; then profile_owner="${project_root}"; fi
fi
if [[ -z "${profile_owner}" && ! -f "${runtime_profile}" ]]; then
  result 'Profile ownership' 'WARN' 'no runtime profile yet'
elif [[ "${profile_owner}" == "${project_root}" ]]; then
  result 'Profile ownership' 'PASS' "${project_root}"
else
  result 'Profile ownership' 'FAIL' "owned by ${profile_owner:-unknown-foreign-owner}"
fi

# 6. Supervisor ---------------------------------------------------------------
sup_state=""
for candidate in \
  "${project_root}/apps/server/.pilot/supervisor.json" \
  "${project_root}/.pilot/supervisor.json" \
  "${project_root}/apps/server/.chatgpt-machine/supervisor.json" \
  "${project_root}/.chatgpt-machine/supervisor.json"; do
  if [[ -f "${candidate}" ]]; then
    pids="$(node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log((j.supervisorPid||"")+" "+(j.workerPid||"")+" "+(j.restarts||0))}catch(e){}' "${candidate}")"
    sup_pid="${pids%% *}"; rest="${pids##* }"; worker_pid="$(echo "${pids}" | awk '{print $2}')"
    if [[ "${sup_pid}" =~ ^[0-9]+$ ]] && kill -0 "${sup_pid}" 2>/dev/null \
      && [[ "${worker_pid}" =~ ^[0-9]+$ ]] && kill -0 "${worker_pid}" 2>/dev/null; then
      sup_state="supervisor=${sup_pid} worker=${worker_pid} restarts=${rest} (${candidate})"
      break
    fi
  fi
done
if [[ -n "${sup_state}" ]]; then result 'Supervisor' 'PASS' "${sup_state}"
else
  any_state=""
  for candidate in \
    "${project_root}/apps/server/.pilot/supervisor.json" \
    "${project_root}/.pilot/supervisor.json" \
    "${project_root}/apps/server/.chatgpt-machine/supervisor.json" \
    "${project_root}/.chatgpt-machine/supervisor.json"; do
    if [[ -f "${candidate}" ]]; then any_state="${candidate}"; break; fi
  done
  if [[ -z "${any_state}" ]]; then result 'Supervisor' 'WARN' 'no state file (supervisor never ran here?)'
  else result 'Supervisor' 'FAIL' "stale state in ${any_state}"; fi
fi

# 7. Watchdog -----------------------------------------------------------------
if [[ -f "${watchdog_pid_file}" ]]; then
  wpid="$(cat "${watchdog_pid_file}" 2>/dev/null || true)"
  if [[ "${wpid}" =~ ^[0-9]+$ ]] && kill -0 "${wpid}" 2>/dev/null; then result 'Watchdog' 'PASS' "pid ${wpid}"
  else result 'Watchdog' 'FAIL' "stale pid file (${wpid} dead)"; fi
else
  result 'Watchdog' 'WARN' 'not running (starts with start-tunnel)'
fi

# 8-10. Providers --------------------------------------------------------------
check_entry() { # dir; prints entry or empty
  if [[ -f "$1/dist/src/index.js" ]]; then echo 'dist/src/index.js'
  elif [[ -f "$1/dist/index.js" ]]; then echo 'dist/index.js'; fi
}
for provider in "Skill Hub:packages/skill-hub" "ThinkForge:packages/thinkforge" "Memory:packages/memory"; do
  name="${provider%%:*}"; rel="${provider##*:}"
  entry="$(check_entry "${project_root}/${rel}")"
  if [[ -n "${entry}" ]]; then result "${name}" 'PASS' "${entry}"
  else result "${name}" 'FAIL' 'build output missing'; fi
done

# 11-12. Capability registry -----------------------------------------------------
if [[ ! -f "${server_dist}" ]]; then
  result 'Capability registry' 'FAIL' 'server dist missing'
  result 'Remote git tool' 'SKIP' 'no server build'
else
  legacy_tools="$(node "${server_dist}" --check 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).tools.join("\n"))}catch(e){}})') "
  if [[ -z "${legacy_tools}" ]]; then
    result 'Capability registry' 'FAIL' 'legacy --check did not complete'
    result 'Remote git tool' 'SKIP' 'check unavailable'
  else
    source_tools="$(grep -hoE "^[[:space:]]+name: '[a-z0-9_]+'," "${project_root}/apps/server/src/tools.ts" "${project_root}/apps/server/src/machine-router.ts" 2>/dev/null | grep -oE "'[a-z0-9_]+'" | tr -d "'" | sort -u)"
    missing=""; extra=""
    while IFS= read -r t; do
      [[ -z "${t}" ]] && continue
      if [[ "${t}" == osint_search || "${t}" == osint_fetch ]]; then continue; fi
      echo "${legacy_tools}" | grep -qxF "${t}" || missing="${missing} ${t}"
    done <<< "${source_tools}"
    while IFS= read -r t; do
      [[ -z "${t}" ]] && continue
      echo "${source_tools}" | grep -qxF "${t}" || extra="${extra} ${t}"
    done <<< "${legacy_tools}"
    if [[ -z "${missing// }" && -z "${extra// }" ]]; then
      count="$(echo "${legacy_tools}" | grep -c .)"
      result 'Capability registry' 'PASS' "source == built == registered (${count} tools, 2 conditional excluded)"
    else
      detail=""
      [[ -n "${missing// }" ]] && detail="missing:${missing}"
      [[ -n "${extra// }" ]] && detail="${detail} unregistered:${extra}"
      result 'Capability registry' 'FAIL' "${detail}"
    fi
    if echo "${legacy_tools}" | grep -qxF 'git_remote_status'; then result 'Remote git tool' 'PASS' 'git_remote_status exposed'
    else result 'Remote git tool' 'FAIL' 'git_remote_status NOT in tool surface (stale dist?)'; fi
    hybrid_providers="$(node "${server_dist}" --tool-surface hybrid --dangerously-open-machine --check 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(j.capabilityCount+"|"+j.providers.join("/"))}catch(e){}})')"
    if [[ -z "${hybrid_providers}" ]]; then
      result 'Providers' 'FAIL' 'hybrid --check did not complete'
    else
      prov="${hybrid_providers##*|}"
      ok=1
      for p in machine skills think memory; do echo "${prov}" | tr '/' '\n' | grep -qxF "${p}" || ok=0; done
      if [[ "${ok}" -eq 1 ]]; then result 'Providers' 'PASS' "${hybrid_providers%%|*} caps via ${prov}"
      else result 'Providers' 'FAIL' "providers incomplete: ${prov}"; fi
    fi
  fi
fi

echo ''
if [[ "${fail}" -eq 0 ]]; then
  if [[ "${warn}" -eq 0 ]]; then echo 'Overall: HEALTHY'; else echo 'Overall: HEALTHY (with warnings)'; fi
  exit 0
else
  echo "Overall: UNHEALTHY (${fail} failing)"
  exit 1
fi
