#!/usr/bin/env bash
# A real Docker runtime on both sides of a version change. Only Node and sleep run in these containers.
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
project="ccdt-hardware-$(basename "$work" | tr -dc 'a-z0-9')"
export PROXY_DEPLOY_CONFIG="$work/deployment.env" PROXY_COMPOSE_FILE="$work/compose.yml"
image="${CCDT_PROBE_IMAGE:-node:24-bookworm}"
next="${CCDT_NEXT_PROBE_IMAGE:-$image}"
docker image inspect "$image" >/dev/null
docker image inspect "$next" >/dev/null
mkdir -p "$work/data/state"
touch "$work/data/.cc-desk-tunnel-data"
cat > "$PROXY_DEPLOY_CONFIG" <<CONFIG
PROJECT_NAME='$project'
DATA_DIR='$work/data'
PROXY_IMAGE='$image'
CONFIG
compose=(docker compose --env-file "$PROXY_DEPLOY_CONFIG" -p "$project")
trap '"${compose[@]}" -f "$PROXY_COMPOSE_FILE" down --remove-orphans >/dev/null 2>&1 || true; rm -rf -- "$work"' EXIT
cat > "$work/legacy.yml" <<'YAML'
networks:
  default: {internal: true}
  secondary: {internal: true}
services:
  proxy:
    image: ${PROXY_IMAGE}
    entrypoint: ["sleep", "300"]
    command: []
    networks: [default, secondary]
    healthcheck: {test: ["CMD", "true"], interval: 1s}
YAML
cp "$work/legacy.yml" "$PROXY_COMPOSE_FILE"
first_cpu="$(docker run --rm --network none --entrypoint node "$image" -e 'console.log(require("fs").readFileSync("/proc/self/status","utf8").match(/^Cpus_allowed_list:\s*(\d+)/m)[1])')"
cat > "$work/original-limits.yml" <<YAML
services:
  proxy:
    cpus: 0.5
    cpuset: '$first_cpu'
    mem_limit: 256m
    memswap_limit: 256m
    shm_size: 32m
YAML
probe() {
  local id
  id="$("${compose[@]}" -f "$PROXY_COMPOSE_FILE" ps -q "$1")"
  docker inspect --format '{{range $name,$network := .NetworkSettings.Networks}}{{println $name $network.MacAddress}}{{end}}' \
    "$("${compose[@]}" -f "$PROXY_COMPOSE_FILE" ps -q proxy)"
  docker inspect --format '{{with .HostConfig}}{{.NanoCpus}} {{.CpusetCpus}} {{.Memory}} {{.MemorySwap}} {{.ShmSize}}{{end}}' "$id"
  docker exec "$id" node -e 'const os=require("node:os"),fs=require("node:fs");
    console.log(os.hostname(),Object.values(os.networkInterfaces()).flat().filter(n=>!n.internal).map(n=>n.mac).sort().join(","));
    console.log(JSON.stringify([process.arch,os.cpus().map(c=>c.model),os.availableParallelism(),os.totalmem(),fs.statfsSync("/dev/shm").blocks]));
    console.log(fs.readFileSync("/proc/self/status","utf8").match(/^Cpus_allowed_list:.*$/m)[0]);
    for(const f of ["cpu.max","memory.max","memory.swap.max"]) if(fs.existsSync("/sys/fs/cgroup/"+f)) console.log(f,fs.readFileSync("/sys/fs/cgroup/"+f,"utf8").trim());'
}
"${compose[@]}" -f "$PROXY_COMPOSE_FILE" -f "$work/original-limits.yml" up -d
probe proxy > "$work/original"
printf "PROXY_IMAGE='%s'\n" "$next" >> "$PROXY_DEPLOY_CONFIG"
cat >> "$PROXY_COMPOSE_FILE" <<'YAML'
  runtime:
    image: ${PROXY_IMAGE}
    entrypoint: ["sleep", "300"]
    command: []
    network_mode: service:proxy
    depends_on: [proxy]
    healthcheck: {test: ["CMD", "true"], interval: 1s}
YAML
bash "$root/deploy/manage.sh" up
probe runtime > "$work/upgraded"
cmp "$work/original" "$work/upgraded"
bash "$root/deploy/manage.sh" stop
bash "$root/deploy/manage.sh" up
probe runtime > "$work/restarted"
cmp "$work/original" "$work/restarted"
id="$("${compose[@]}" -f "$PROXY_COMPOSE_FILE" ps -q runtime)"
cp "$PROXY_DEPLOY_CONFIG.hardware/engine" "$work/engine"
echo 'different Docker Engine' > "$PROXY_DEPLOY_CONFIG.hardware/engine"
if bash "$root/deploy/manage.sh" up > "$work/refused" 2>&1; then exit 1; fi
grep -q 'Docker Engine, CPU count' "$work/refused"
test "$id" = "$("${compose[@]}" -f "$PROXY_COMPOSE_FILE" ps -q runtime)"
mv "$work/engine" "$PROXY_DEPLOY_CONFIG.hardware/engine"
cp "$work/legacy.yml" "$PROXY_COMPOSE_FILE"
printf "PROXY_IMAGE='%s'\n" "$image" >> "$PROXY_DEPLOY_CONFIG"
# As in 0.3.x, the deployment config supplies the single Compose file. The image is already installed.
(
  source "$PROXY_DEPLOY_CONFIG"
  if [[ -n "${CCDT_LEGACY_MANAGER:-}" ]]; then
    COMPOSE_REMOVE_ORPHANS=true bash "$CCDT_LEGACY_MANAGER" up
  else
    "${compose[@]}" -f "$COMPOSE" up -d --no-build --remove-orphans
  fi
)
probe proxy > "$work/downgraded"
cmp "$work/original" "$work/downgraded"
echo 'PASS: legacy proxy → runtime → restart → legacy proxy. In-container hostname, MAC, CPU, affinity, memory, swap and shared memory match.'
