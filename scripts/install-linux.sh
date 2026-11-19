#!/usr/bin/env bash
set -euo pipefail

NODE_VERSION=v24.22.2
CLAUDE_VERSION=2.1.328
RUNTIME="${CC_DESK_TUNNEL_RUNTIME:-$HOME/.local/share/cc-desk-tunnel/runtime}"
case "$(uname -m)" in
  x86_64) ARCH=x64 ;;
  aarch64) ARCH=arm64 ;;
  *) echo "Unsupported architecture" >&2; exit 1 ;;
esac
if [ "$(id -u)" -eq 0 ]; then
  echo "Run as the intended ordinary user, without sudo." >&2
  exit 1
fi
mkdir -p "$RUNTIME"
if [ -x "$RUNTIME/node/bin/node" ] && [ "$("$RUNTIME/node/bin/node" --version)" != "$NODE_VERSION" ]; then
  echo "Existing managed Node runtime is not $NODE_VERSION. Choose a new CC_DESK_TUNNEL_RUNTIME directory." >&2
  exit 1
fi
TEMP="$(mktemp -d)"
trap 'rm -rf -- "$TEMP"' EXIT
ARCHIVE="node-$NODE_VERSION-linux-$ARCH.tar.xz"
if [ ! -x "$RUNTIME/node/bin/node" ]; then
  curl --connect-timeout 20 --max-time 300 -fsSL "https://nodejs.org/dist/$NODE_VERSION/$ARCHIVE" -o "$TEMP/$ARCHIVE"
  curl --connect-timeout 20 --max-time 60 -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$TEMP/checksums"
  (cd "$TEMP" && grep "  $ARCHIVE$" checksums | sha256sum -c -)
  tar -xJf "$TEMP/$ARCHIVE" -C "$TEMP"
  mv -- "$TEMP/node-$NODE_VERSION-linux-$ARCH" "$RUNTIME/node"
fi
export PATH="$RUNTIME/node/bin:$PATH"
node --version
manifest="$RUNTIME/cli/lib/node_modules/@anthropic-ai/claude-code/package.json"
if [ ! -x "$RUNTIME/cli/bin/claude" ] || [ ! -f "$manifest" ] || [ "$(node -p 'require(process.argv[1]).version' "$manifest")" != "$CLAUDE_VERSION" ]; then
  npm install --global --prefix "$RUNTIME/cli" "@anthropic-ai/claude-code@$CLAUDE_VERSION"
fi
test -x "$RUNTIME/cli/bin/claude"
test "$(node -p 'require(process.argv[1]).version' "$manifest")" = "$CLAUDE_VERSION"
# Check the installed bytes even when reusing a same-version installation.
release=https://downloads.claude.ai/claude-code-releases/$CLAUDE_VERSION
mkdir -m 700 "$TEMP/gnupg"
for file in manifest.json manifest.json.sig; do
  curl --connect-timeout 20 --max-time 60 -fsSL "$release/$file" -o "$TEMP/$file"
done
curl --connect-timeout 20 --max-time 60 -fsSL https://downloads.claude.ai/keys/claude-code.asc -o "$TEMP/key.asc"
gpg --batch --homedir "$TEMP/gnupg" --dearmor --output "$TEMP/key.gpg" "$TEMP/key.asc"
gpgv --homedir "$TEMP/gnupg" --keyring "$TEMP/key.gpg" --status-fd 1 \
  "$TEMP/manifest.json.sig" "$TEMP/manifest.json" > "$TEMP/signature"
awk -v key=31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE \
  '$1 == "[GNUPG:]" && $2 == "VALIDSIG" && ($3 == key || $NF == key) { valid=1 } END { exit !valid }' "$TEMP/signature"
checksum=$(node -e '
  const [path, version, arch] = process.argv.slice(1);
  const manifest = require(path);
  const hash = manifest.platforms["linux-" + arch]?.checksum;
  if (manifest.version !== version || !/^[a-f0-9]{64}$/.test(hash)) process.exit(1);
  console.log(hash);' "$TEMP/manifest.json" "$CLAUDE_VERSION" "$ARCH")
printf '%s  cli/bin/claude\n' "$checksum" > "$TEMP/claude.sha256"
(cd "$RUNTIME" && sha256sum -c "$TEMP/claude.sha256")
install -m 644 "$TEMP/claude.sha256" "$RUNTIME/claude.sha256"
printf 'Runtime installed for user %s at %s\n' "$(id -un)" "$RUNTIME"
printf 'No account login or model call has been performed.\n'
