version_before() {
  [[ "$1" != "$2" && "$(printf '%s\n' "$1" "$2" | sort -V | head -n 1)" = "$1" ]]
}

# The image's program, or a newer overlay which has not exhausted its startup attempts.
program_version() {
  local store="$1" image="$2" version attempts
  version="$(head -n 1 "$store/current" 2>/dev/null || true)"
  if [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && -f "$store/$version/apps/server/src/main.ts" ]] \
    && version_before "$image" "$version"; then
    attempts="$(cat "$store/attempts" 2>/dev/null || echo 0)"
    if [[ "$attempts" =~ ^[0-2]$ ]]; then printf '%s\n' "$version"; return; fi
    echo "Program $version did not start; running $image from the image." >&2
  fi
  printf '%s\n' "$image"
}
