#!/usr/bin/env bash
set -euo pipefail
umask 077
mkdir -p /data/home/.claude/projects /data/state /data/workspace /data/cc-runner /data/state/{native,terminals,project-sockets} /data/app-home/.claude
# Only native transcripts migrate. The personal CLI home and its credentials stay separate.
if [[ ! -e /data/app-home/.history-migrated ]]; then
  if [[ -d /data/home/.claude/projects && ! -e /data/app-home/.claude/projects ]]; then
    staged="$(mktemp -d /data/app-home/.claude/.history-XXXXXXXX)"
    trap 'rm -rf -- "$staged"' EXIT
    cp -a /data/home/.claude/projects/. "$staged/"
    # Import regular history and memory files only. The broker must not follow legacy links.
    find "$staged" ! -type d ! -type f -delete
    mv -T -- "$staged" /data/app-home/.claude/projects
    trap - EXIT
  fi
  touch /data/app-home/.history-migrated
fi
if [ ! -r /data/config/service.env ] || [ ! -w /data/home ] || [ ! -w /data/state ]; then
  echo "Run manage.sh init first; data must be writable by container uid 1000." >&2
  exit 1
fi
[ "${1:-}" = server ] || exec "$@"

# The service runs the program in the image unless a newer one was installed into the data directory from the
# client. One that failed to start three times in a row is left aside.
PROGRAM=/app
STORE=/data/program
IMAGE_VERSION="$(node -p "require('/app/apps/desktop/package.json').version")"
source /usr/local/lib/cc-desk-tunnel/program.sh
VERSION="$(program_version "$STORE" "$IMAGE_VERSION")"
if [[ "$VERSION" != "$IMAGE_VERSION" ]]; then
  ATTEMPTS="$(cat "$STORE/attempts" 2>/dev/null || echo 0)"
  echo "$((ATTEMPTS + 1))" > "$STORE/attempts"
  PROGRAM="$STORE/$VERSION"
fi
[ ! -x "$PROGRAM/cli/bin/claude" ] || PATH="$PROGRAM/cli/bin:$PATH"
echo "Starting program $(node -p "require('$PROGRAM/apps/desktop/package.json').version") from $PROGRAM"
export PROXY_PROGRAM_DIR="$STORE" PROXY_RUNTIME_DIR=/opt/runtime
exec node --env-file=/data/config/service.env "$PROGRAM/apps/server/src/main.ts"
