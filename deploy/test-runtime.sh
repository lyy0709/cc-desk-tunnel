#!/usr/bin/env bash
# Offline Linux runner check. Its only CLI binary is the shell fixture below.
set -euo pipefail
cd "$(dirname -- "$0")/.."
work=$(mktemp -d)
name=ccdt-fixture-$$
cleanup() {
  docker rm -f "$name" "$name-peer" >/dev/null 2>&1 || true
  docker volume rm "$name" "$name-sockets" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
image=node:24-bookworm
docker_cmd=(docker run --pull=never --rm --network none)
first=11111111-2222-4333-8444-555555555555
second=22222222-2222-4333-8444-555555555555
terminal=33333333-2222-4333-8444-555555555555
socket=/data/state/project-sockets/12345678-1234-4234-8234-123456789abc.sock
mkdir -p "$work/native/$first" "$work/native/$second" "$work/config" "$work/node_modules"
printf '%s\n' '{"env":{"ANTHROPIC_API_KEY":"fixture-only"}}' > "$work/config/provider.json"
cat > "$work/fixture" <<'MOCK'
#!/bin/sh
set -eu
test "$(id -u)" = 1000
test "$(id -g)" -ge 12000
test ! -e /data/config/service.env
test ! -e /data/tls
test -z "${PROXY_TOKEN:-}"
test ! -r /data/cc-runner/launch.sock
denied() {
  node -e 'const fs=require("node:fs");try{fs.closeSync(fs.openSync(process.argv[1],process.argv[2]));process.exit(2)}catch(e){if(e.code!=="EACCES")throw e}' "$1" "$2"
}
if [ "$1" = auth ]; then
  if [ "$2" = login ]; then
    test "$HOME" = /data/home
    test -z "${CCDT_HISTORY:-}${CCDT_TERMINAL:-}${ANTHROPIC_API_KEY:-}"
    printf 'fixture authorization URL https://example.invalid/authorize\n'
    read -r reply
    test "$reply" = fixture-reply
    printf 'ok\n' > "$HOME/fixture-signed-in"
    printf 'terminal completed\n'; exit 0
  fi
  test "$2" = status
  if [ "$HOME" = /data/home ]; then
    test -z "${CLAUDE_CONFIG_DIR:-}"
    test -z "${ANTHROPIC_API_KEY:-}"
    if [ -e "$HOME/fixture-signed-in" ]; then printf '{"loggedIn":true}\n'; exit 0; fi
  elif [ "${ANTHROPIC_API_KEY:-}" = fixture-only ]; then printf '{"loggedIn":true,"authMethod":"api_key"}\n'; exit 0; fi
  printf '{"loggedIn":false,"authMethod":"none"}\n'; exit 1
fi
test "$ENABLE_CLAUDEAI_MCP_SERVERS" = false
if [ "$1" = fixture-status-read ]; then
  test "$CLAUDE_CODE_DISABLE_DEFERRED_TOOL_RESUME" = 1
  printf 'status only\n'; exit 0
fi
test -z "${CLAUDE_CODE_DISABLE_DEFERRED_TOOL_RESUME:-}"
if [ "$1" = --settings ]; then
  cat "$2" >/dev/null
  denied "$2" r+
  touch "$CCDT_TERMINAL/events/own-event"
  test -z "${ANTHROPIC_API_KEY:-}"
  test "$HOME" = /data/home
  denied "$3/fixture-record" r
  cat "$CCDT_HISTORY/fixture-record" >/dev/null
  test -e "$HOME/fixture-signed-in"
  printf 'project terminal completed\n'; exit 0
fi
denied "$2" r
test "$CLAUDE_CODE_SDK_READS_SESSION_STATE" = 1
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then printf 'fixture reports signed out\n'; exit 1; fi
test "$ANTHROPIC_API_KEY" = fixture-only
printf 'record\n' > "$CCDT_HISTORY/fixture-record"
node -e 'const s=require("net").connect(process.argv[1]);s.on("data",b=>process.stdout.write(b))' "$1"
printf 'fixture at %s: ' "$PWD"
cat
exit 7
MOCK
chmod +x "$work/fixture"
# Build the already-installed PTY dependency against the test image's headers, offline.
cp -R node_modules/node-pty node_modules/node-addon-api "$work/node_modules/"
"${docker_cmd[@]}" -v "$work/node_modules:/node_modules" -w /node_modules/node-pty "$image" \
  node /usr/local/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js rebuild --nodedir=/usr/local >/dev/null
"${docker_cmd[@]}" -v "$PWD/deploy/docker/runtime-guard.c:/guard.c:ro" -v "$work:/out" "$image" cc -Wall -Wextra -Werror /guard.c -o /out/guard
docker volume create "$name" >/dev/null
docker volume create "$name-sockets" >/dev/null
"${docker_cmd[@]}" --name "$name" -d --cap-drop ALL --security-opt no-new-privileges --user 0:0 \
  --cap-add CHOWN --cap-add SETUID --cap-add SETGID --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add KILL --read-only --tmpfs /tmp \
  -v "$PWD/apps/server/src:/app:ro" -v "$work/node_modules:/node_modules:ro" -v "$name:/data/cc-runner" \
  -v "$name-sockets:/data/state/project-sockets" --tmpfs /data/state/terminals -v "$work/guard:/usr/local/bin/ccdt-guard:ro" \
  -v "$work/native:/data/state/native" -v "$work/config/provider.json:/data/provider.json:ro" --tmpfs /opt/runtime:exec -v "$work/fixture:/fixture:ro" \
  --tmpfs /data/home --tmpfs /data/home/.claude/projects:mode=0711 --tmpfs /data/app-home \
  -e HOME=/data/app-home -e CLAUDE_CONFIG_DIR=/data/app-home/.claude "$image" sh -ec \
  'mkdir -p /opt/runtime/cli/bin; cp /fixture /opt/runtime/cli/bin/claude; exec node /app/runtime-worker.ts' >/dev/null
for _ in $(seq 1 40); do docker exec "$name" test -S /data/cc-runner/launch.sock && break; sleep .2; done
docker exec "$name" test -S /data/cc-runner/launch.sock
docker exec "$name" sh -ec 'mkdir -p "$1/events"; touch "$1/settings.json"; chown -R 1000:1000 "$1"' sh "/data/state/terminals/$terminal"
"${docker_cmd[@]}" -d --name "$name-peer" --cap-drop ALL --user 1000:1000 -v "$name-sockets:/data/state/project-sockets" "$image" node -e \
 'require("net").createServer(s=>s.end("own tool; ")).listen(process.argv[1])' "$socket" >/dev/null
for _ in $(seq 1 40); do docker exec "$name-peer" test -S "$socket" && break; sleep .2; done
settings=/data/state/terminals/$terminal/settings.json
broker=("${docker_cmd[@]}" -i --user 1000:1000 --cap-drop ALL -v "$name:/data/cc-runner" -v "$PWD/apps/server/src:/app:ro" \
  -v "$work/native:/data/state/native" -e ENABLE_CLAUDEAI_MCP_SERVERS=false -e PROXY_TOKEN=fixture-broker-only)
relay=(node /app/runtime-relay.mjs)
status() {
  local output actual=0
  output=$("${broker[@]}" -e "CCDT_ACCOUNT_PROFILE=$1" "$image" "${relay[@]}" auth status --json) || actual=$?
  test "$actual" = "$2" && test "$output" = "$3"
}
status terminal 1 '{"loggedIn":false,"authMethod":"none"}'
status sdk 0 '{"loggedIn":true,"authMethod":"api_key"}'
response=$("${broker[@]}" -e CCDT_RUNTIME_SESSION="$first" -e CLAUDE_CODE_DISABLE_DEFERRED_TOOL_RESUME=1 \
  -w "/data/state/native/$first" "$image" "${relay[@]}" fixture-status-read)
test "$response" = 'status only'
for project in "$first" "$second"; do
  # Each run receives a new socket. Recreate the first fixture socket for the second run.
  if [[ $project = "$second" ]]; then
    docker exec "$name" chown 1000:1000 "$socket"
  fi
  code=0
  response=$(printf 'safe input\n' | "${broker[@]}" -e CCDT_RUNTIME_SESSION="$project" -e CCDT_PROJECT_SOCKET="$socket" \
    -e CLAUDE_CODE_SDK_READS_SESSION_STATE=1 -w "/data/state/native/$project" "$image" "${relay[@]}" "$socket" "$settings") || code=$?
  test "$code" = 7 && test "$response" = "own tool; fixture at /data/state/native/$project: safe input" || exit 1
done
# The initial frame selects a real Linux PTY. Only the fixture above receives the synthetic reply.
"${broker[@]}" "$image" node --input-type=module - "$first" "$second" "$settings" <<'JS'
import assert from 'node:assert/strict';
import net from 'node:net';
import {createInterface} from 'node:readline';
const [first,other,settings]=process.argv.slice(2);
for (const launch of [{profile:'terminal',cwd:'/tmp',args:['auth','login']},
  {session:first,cwd:'/data/state/native/'+first,args:['--settings',settings,'/data/app-home/.claude/projects/-data-state-native-'+other]}]) {
  const socket=net.connect('/data/cc-runner/launch.sock');
  const send=frame=>socket.write(JSON.stringify(frame)+'\n');
  send({...launch,tty:true,env:{ENABLE_CLAUDEAI_MCP_SERVERS:'false'}});
  let text='',sent=false,exit;
  for await(const line of createInterface({input:socket})){
    const frame=JSON.parse(line);
    if(frame.data) text+=Buffer.from(frame.data,'base64').toString();
    if(!sent && text.includes('https://example.invalid/authorize')){sent=true;send({input:Buffer.from('fixture-reply\r').toString('base64')});}
    if(frame.exit!==undefined){exit=frame.exit;break;}
  }
  assert.equal(exit,0,text);assert.match(text,/terminal completed/);assert.equal(sent,!!launch.profile);
}
JS
printf '{}\n' > "$work/config/provider.json"
status sdk 1 '{"loggedIn":false,"authMethod":"none"}'
status terminal 0 '{"loggedIn":true}'
code=0
response=$("${broker[@]}" -e CCDT_RUNTIME_SESSION="$first" -e CLAUDE_CODE_SDK_READS_SESSION_STATE=1 \
  -w "/data/state/native/$first" "$image" "${relay[@]}" unused "$settings") || code=$?
test "$code" = 1
test "$response" = 'fixture reports signed out'
echo 'Fixture passed: native login and auth status, provider isolation, project history, settings, MCP controls and relay I/O.'
