#!/bin/sh
# ⑥ Cost of the frontend's retained-assets volume, measured inside the
# production nginx image (BusyBox sh/cp/flock) on a Docker named volume.
#
# On the host, with three production builds (oldest first):
#
#   sh tools/perf-baselines/assetRetention.measure.sh /tmp/b1 /tmp/b2 /tmp/b3
#
# The host side creates its own uniquely named, labelled volume, refuses a name
# that already exists, and removes only that volume afterwards. Inside the
# container the store must be empty: nothing here deletes from a volume. A
# fourth release reuses the third build's files under a new version id.
set -u

if [ "${1:-}" != --in-container ]; then
  [ $# -eq 3 ] || { echo "usage: $0 <build1> <build2> <build3>" >&2; exit 64; }
  repo=$(cd "$(dirname "$0")/../.." && pwd)
  for dir in "$@"; do [ -f "$dir/index.html" ] && [ -d "$dir/assets" ] || { echo "not a production build: $dir" >&2; exit 64; }; done
  volume="rainver-retain-measure-$(date +%s)-$$"
  if docker volume inspect "$volume" >/dev/null 2>&1; then echo "volume $volume already exists; refusing to use it" >&2; exit 65; fi
  docker volume create --label rainver.measure=temporary "$volume" >/dev/null || exit 1
  trap 'docker volume rm "$volume" >/dev/null' EXIT INT TERM
  # --mount, not -v: a host path may contain ':'.
  bind() { printf 'type=bind,src=%s,dst=%s,readonly' "$1" "$2"; }
  docker run --rm \
    --mount "$(bind "$repo/apps/web/docker/retain-previous-assets.sh" /retain.sh)" \
    --mount "$(bind "$(cd "$1" && pwd)" /b/1)" --mount "$(bind "$(cd "$2" && pwd)" /b/2)" --mount "$(bind "$(cd "$3" && pwd)" /b/3)" \
    --mount "$(bind "$repo/tools/perf-baselines/assetRetention.measure.sh" /measure.sh)" \
    --mount "type=volume,src=$volume,dst=/store" nginx:1.27-alpine sh /measure.sh --in-container
  exit $?
fi

store=/store
if [ -n "$(ls -A "$store" 2>/dev/null)" ]; then
  echo "$store is not empty; measure only on a new, dedicated volume" >&2
  exit 65
fi
for n in 1 2 3; do mkdir -p "/html/$n"; cp -R "/b/$n/." "/html/$n/"; done
mkdir -p /html/4; cp -R /b/3/. /html/4/
sed -i 's/"id":"[^"]*"/"id":"fourth-release"/' /html/4/version.json

ms() { awk '{ printf "%d", $1 * 1000 }' /proc/uptime; }  # 10 ms resolution
run() { # label html
  t0=$(ms)
  RAINVER_WEB_ROOT=$2 RAINVER_WEB_ASSET_STORE=$store RAINVER_WEB_PREVIOUS_LINK=/run/m/previous sh /retain.sh 2>/tmp/log
  t1=$(ms)
  echo "$1 ms=$((t1 - t0)) store_kib=$(du -sk "$store" | cut -f1) releases=$(ls "$store/releases" | wc -l) log=\"$(tail -n 1 /tmp/log)\""
}
echo "assets_files=$(find /html/3/assets -type f | wc -l) assets_kib=$(du -sk /html/3/assets | cut -f1)"
run first-start /html/1
run restart-same-build /html/1
run second-release /html/2
run third-release /html/3
run fourth-release-prunes-oldest /html/4
for hold in 0.05 0.3 1.2; do
  ( flock "$store/.lock" sleep "$hold" ) &
  sleep 0.02
  run "restart-while-lock-held-${hold}s" /html/4
  wait
done
# Two containers starting together on one volume.
t0=$(ms)
run concurrent-a /html/3 & run concurrent-b /html/4 & wait
echo "concurrent-pair-wall ms=$(( $(ms) - t0 ))"
