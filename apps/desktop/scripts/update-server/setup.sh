#!/usr/bin/env bash
# MarioCode update server — one-time (idempotent) setup on the 亿联云 host.
#
# Runs a pinned nginx:alpine container that serves $ROOT/public read-only on
# host port $PORT. Uploads land in $ROOT/incoming first (outside the served
# root) and are moved into public/ only after their sha512 is verified, so a
# half-uploaded file is never downloadable.
#
# Invoked remotely by `publish.mjs --setup`, which first uploads nginx.conf to
# $ROOT/conf/default.conf. Re-running recreates only the mariocode-updates
# container; it never touches other containers or existing files in public/.
set -euo pipefail

PORT="${PORT:-3458}"
ROOT="${ROOT:-/opt/mariocode-updates}"
IMAGE="${IMAGE:-nginx:1.27-alpine}"
NAME="mariocode-updates"

mkdir -p "$ROOT/public" "$ROOT/incoming" "$ROOT/conf"
chmod 755 "$ROOT" "$ROOT/public"
test -f "$ROOT/conf/default.conf" || { echo "missing $ROOT/conf/default.conf" >&2; exit 1; }

# Refuse to grab a port some other service already listens on (a re-run of
# this script is fine: our own container is removed below before rebinding).
if ss -tln | awk '{print $4}' | grep -qE "[:.]$PORT\$"; then
  if ! docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
    echo "port $PORT is already in use by another service" >&2
    exit 1
  fi
fi

docker pull "$IMAGE"

if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
  docker rm -f "$NAME" >/dev/null
fi

docker run -d --name "$NAME" --restart unless-stopped \
  -p "$PORT:80" \
  -v "$ROOT/public:/usr/share/nginx/html:ro" \
  -v "$ROOT/conf/default.conf:/etc/nginx/conf.d/default.conf:ro" \
  --memory 128m \
  "$IMAGE" >/dev/null

# Docker-published ports bypass ufw's INPUT chain anyway; the explicit rule
# keeps `ufw status` an honest list of what is exposed.
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow "$PORT/tcp" comment "MarioCode update server" >/dev/null
fi

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
    echo "update server up on :$PORT (root $ROOT/public)"
    exit 0
  fi
  sleep 1
done
echo "container started but http://127.0.0.1:$PORT/ did not answer" >&2
docker logs --tail 20 "$NAME" >&2 || true
exit 1
