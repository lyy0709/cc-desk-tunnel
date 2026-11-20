# Host-side Compose configuration. 0.3 ran Claude Code in proxy; 0.4 runs it in runtime, sharing proxy's network.
image_platform() {
  docker image inspect --format '{{.Os}}/{{.Architecture}}{{if .Variant}}/{{.Variant}}{{end}}' "$1" | sed 's|^linux/arm64$|linux/arm64/v8|'
}
cpu_capabilities() {
  docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
    --entrypoint /bin/sh "$1" -ec 'LC_ALL=C grep -E "^(vendor_id|model name|flags|Features|CPU implementer|CPU architecture|CPU part|CPU revision)[[:space:]]*:" /proc/cpuinfo | LC_ALL=C sort -u'
}
project_container() {
  local ids
  ids="$(docker ps -aq --no-trunc --filter "label=com.docker.compose.project=$PROJECT_NAME" --filter "label=com.docker.compose.service=$1" --filter 'label=com.docker.compose.oneoff=False')" || return
  [[ "$ids" != *$'\n'* ]] || fail "Cannot identify a single $1 container."
  printf '%s' "$ids"
}
allocation() {
  docker inspect --format '{{with .HostConfig}}{{.NanoCpus}}|{{.CpusetCpus}}|{{.CpuPeriod}}|{{.CpuQuota}}|{{.CpuShares}}|{{.Memory}}|{{.MemorySwap}}|{{.MemoryReservation}}|{{.ShmSize}}|{{if or .Devices .DeviceRequests .CpusetMems}}custom{{end}}{{end}}' "$1"
}
capture_hardware() (
  local dir="$1" host="$2" owner="$3" runner="$4" stage base fields image platform nano cpuset period quota shares memory swap reserve shm devices
  local label network mac networks netname domain label_project seen=' '
  image="$(docker inspect --format '{{.Image}}' "$runner")"
  fields="$(allocation "$runner")"
  IFS='|' read -r nano cpuset period quota shares memory swap reserve shm devices <<< "$fields"
  [[ -n "$image" && "$shm" =~ ^[0-9]+$ && -z "$devices" ]] || fail "Cannot automatically carry over custom hardware devices or NUMA affinity."
  platform="$(image_platform "$image")"
  [[ "$platform" =~ ^linux/(amd64|arm64)(/v[0-9]+)?$ ]] || fail "Unsupported server image platform: $platform"
  stage="$(mktemp -d "$dir.XXXXXXXX")"
  trap 'rm -rf -- "$stage"' EXIT
  base="$(realpath -- "$COMPOSE")"
  safe_value "$base" && safe_value "$dir" || fail "Unsupported Compose file path."
  printf '%s\n' "$host" > "$stage/engine"
  printf '%s\n' "$platform" > "$stage/platform"
  printf '%s\n' "$fields" > "$stage/allocation"
  printf '%s\n' "$base" > "$stage/base"
  cpu_capabilities "$image" > "$stage/cpu" && [[ -s "$stage/cpu" ]] || fail "Cannot read the previous CPU capabilities."
  {
    printf '    platform: %s\n    shm_size: %s\n' "$platform" "$shm"
    if ((nano)); then printf '    cpus: %d.%09d\n' "$((nano / 1000000000))" "$((nano % 1000000000))"; fi
    if [[ -n "$cpuset" ]]; then printf "    cpuset: '%s'\n" "$cpuset"; fi
    if ((period)); then printf '    cpu_period: %s\n' "$period"; fi
    if ((quota)); then printf '    cpu_quota: %s\n' "$quota"; fi
    if ((shares)); then printf '    cpu_shares: %s\n' "$shares"; fi
    if ((memory)); then printf '    mem_limit: %s\n' "$memory"; fi
    if ((swap)); then printf '    memswap_limit: %s\n' "$swap"; fi
    if ((reserve)); then printf '    mem_reservation: %s\n' "$reserve"; fi
  } > "$stage/compute"
  fields="$(docker inspect --format '{{.Config.Hostname}}|{{.Config.Domainname}}' "$owner")"
  IFS='|' read -r netname domain <<< "$fields"
  valid_host "$netname" && { [[ -z "$domain" ]] || valid_host "$domain"; } || fail "Cannot verify the previous container hostname."
  printf '%s\n' "$netname" > "$stage/hostname"
  printf "    hostname: '%s'\n" "$netname" > "$stage/network"
  if [[ -n "$domain" ]]; then printf "    domainname: '%s'\n" "$domain" >> "$stage/network"; fi
  printf '    networks:\n' >> "$stage/network"
  networks="$(docker inspect --format '{{range $key,$net := .NetworkSettings.Networks}}{{printf "%s|%s\n" $key $net.MacAddress}}{{end}}' "$owner")"
  while IFS='|' read -r network mac; do
    [[ -n "$network" && "$mac" =~ ^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$ && "$mac" != 00:00:00:00:00:00 ]] \
      || fail "Docker has no verifiable MAC for the previous container; it reports one only while the container runs. If the container is stopped, start it with: docker start ${owner:0:12} — then repeat this command."
    fields="$(docker network inspect --format '{{index .Labels "com.docker.compose.project"}}|{{index .Labels "com.docker.compose.network"}}' "$network")"
    IFS='|' read -r label_project label <<< "$fields"
    [[ "$label_project" = "$PROJECT_NAME" && "$label" =~ ^[a-zA-Z0-9_.-]+$ && "$seen" != *" $label "* ]] \
      || fail "Cannot match the previous interface to a network managed by this Compose project."
    seen="$seen$label "
    printf "      '%s':\n        mac_address: '%s'\n" "$label" "$mac" >> "$stage/network"
    printf '%s %s\n' "$network" "$mac" >> "$stage/endpoints"
  done <<< "$networks"
  { printf 'services:\n  proxy:\n'; cat "$stage/network"; printf '  runtime:\n'; cat "$stage/compute"; } > "$stage/runtime.yml"
  { printf 'services:\n  proxy:\n'; cat "$stage/network" "$stage/compute"; } > "$stage/proxy.yml"
  # 0.3's unchanged manager takes a single -f file. An include retains the selected release's full Compose definition.
  printf "include:\n  - path: ['%s', '%s/proxy.yml']\n" "$base" "$dir" > "$stage/legacy.yml"
  if ! mv -T -- "$stage" "$dir" 2>/dev/null; then
    [[ -d "$dir" && "$host" = "$(cat "$dir/engine")" ]] || fail "Cannot save the server hardware configuration."
  fi
)
retain_hardware() {
  local dir="$CONFIG.hardware" host saved owner runner temp network mac endpoints used other names
  host="$(docker info --format '{{.ID}} {{.OSType}} {{.Architecture}} {{.NCPU}} {{.MemTotal}}')"
  [[ "$host" =~ ^[^[:space:]]+[[:space:]]linux[[:space:]][^[:space:]]+[[:space:]][1-9][0-9]*[[:space:]][1-9][0-9]*$ ]] || fail "Cannot identify the Docker Engine and its CPU/memory allocation."
  owner="$(project_container proxy)"
  if [[ ! -d "$dir" ]]; then
    if [[ -z "$owner" ]]; then
      [[ "${1:-}" != existing && ( "$command" = restore || ! -f "$DATA_DIR/state/sessions.sqlite" || -e "$dir-reset" ) ]] \
        || fail "The previous container is required to verify this installation's hardware. If it was removed and cannot be started again, run: $(self) hardware --reset"
      return
    fi
    runner="$(project_container runtime)"
    capture_hardware "$dir" "$host" "$owner" "${runner:-$owner}"
    rm -f -- "$dir-reset"
  fi
  saved="$(cat "$dir/engine")"
  # The Engine, its system, architecture and CPU count say which machine this is. Its total memory, the last field,
  # also moves with the host kernel: a difference there is reported and the service goes on.
  [[ "${host% *}" = "${saved% *}" ]] \
    || fail "Docker Engine, CPU count or architecture changed. The running service was not replaced. To go on with this machine as it is now, run: $(self) hardware --reset"
  [[ "$host" = "$saved" ]] \
    || echo "注意：宿主机总内存与保存的硬件记录不同（内核升级或调整配置后常见），服务照常继续。运行 $(self) hardware --reset 可按当前环境重新记录。" >&2
  names="$(docker network ls --format '{{.Name}}')"
  while read -r network mac; do
    if grep -Fxq -- "$network" <<< "$names"; then
      endpoints="$(docker network inspect --format '{{range $id,$ep := .Containers}}{{printf "%s %s\n" $id $ep.MacAddress}}{{end}}' "$network")"
      while read -r other used; do
        [[ "$used" != "$mac" || "$other" = "$owner" ]] || fail "The saved MAC is in use by another container on this network."
      done <<< "$endpoints"
    fi
  done < "$dir/endpoints"
  if ! grep -Fxq "COMPOSE='$dir/legacy.yml'" "$CONFIG"; then
    temp="$(mktemp "$CONFIG.XXXXXXXX")"
    { cat "$CONFIG"; write_var COMPOSE "$dir/legacy.yml"; } > "$temp"
    mv -- "$temp" "$CONFIG"
  fi
}
verify_runtime_hardware() {
  local actual expected
  [[ "$(allocation "$1")" = "$(cat "$CONFIG.hardware/allocation")" ]] || fail "The runtime CPU or memory allocation does not match the previous container."
  actual="$(docker exec "$1" sh -ec 'hostname
    for nic in /sys/class/net/*; do
      [ -f "$nic/type" ] && [ "$(cat "$nic/type")" = 1 ] || continue
      mac=$(cat "$nic/address")
      [ "$mac" = 00:00:00:00:00:00 ] || printf "%s\n" "$mac"
    done')"
  expected="$(cat "$CONFIG.hardware/hostname"; cut -d' ' -f2 "$CONFIG.hardware/endpoints")"
  [[ "$(LC_ALL=C sort <<< "$actual")" = "$(LC_ALL=C sort <<< "$expected")" ]] || fail "The running container's hostname or interface MAC does not match the retained deployment."
}
# Records the machine as it is now: after the host's kernel, size or Docker Engine changed, or when the previous
# container is gone. A container of this deployment is captured again, and has to be running for its MAC to be read;
# with none, the next start takes the hostname and MAC Docker assigns and records those. The record replaced is kept
# until the new one is made.
reset_hardware() {
  local dir="$CONFIG.hardware" aside temp
  aside="$(mktemp -d "$dir.replaced.XXXXXXXX")"
  cp -p -- "$CONFIG" "$aside/config"
  if [[ -d "$dir" ]]; then mv -- "$dir" "$aside/record"; fi
  # Without its record the deployment configuration names the Compose file it had before.
  temp="$(mktemp "$CONFIG.XXXXXXXX")"
  { grep -Fxv "COMPOSE='$dir/legacy.yml'" "$aside/config" || true; } > "$temp"
  mv -- "$temp" "$CONFIG"
  rm -f -- "$dir-reset"
  if [[ -n "$(project_container proxy)" ]]; then
    if ! PROXY_DEPLOY_CONFIG="$CONFIG" PROXY_COMPOSE_FILE="$COMPOSE" bash "$ROOT/deploy/manage.sh" hardware; then
      rm -rf -- "$dir"
      if [[ -d "$aside/record" ]]; then mv -- "$aside/record" "$dir"; fi
      mv -- "$aside/config" "$CONFIG"
      rm -rf -- "$aside"
      fail "The server hardware record was left as it was."
    fi
  else
    : > "$dir-reset"
    echo "No container of this deployment exists. The next start takes the hostname and MAC Docker assigns and records them."
  fi
  rm -rf -- "$aside"
}
