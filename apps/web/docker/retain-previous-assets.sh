#!/bin/sh
# Keeps the previous build's hashed /assets/ files servable after a release
# switch, so a tab still running that build can lazy-load a feature chunk
# (CodeMirror, Mermaid, xterm) it had not fetched yet. nginx serves a missing
# /assets/ file through "$link" (see nginx.conf).
#
# Runs from the nginx image's /docker-entrypoint.d/ before nginx starts. That
# entrypoint runs under `set -e`, so this script always exits 0: retention is a
# grace for open tabs, and when it fails nginx still serves the current build.
#
# Shared, disposable store (a Docker volume):
#   releases/<id>/assets  complete snapshots; each appears by a single rename
#   order                 activation order, most recent last; replaced by rename
#   .lock                 flock(1): one writer at a time across containers
#   .staging.* .order.* .trash.*  in-progress or pending-delete; removed under lock
# The fallback pointer ($link) is in this container's own filesystem and is set
# once before nginx starts, from `order` as it stands under the lock right
# after this start's own record, so a later start never repoints the fallback
# of an nginx that is already serving.
#
# Coverage is bounded: the store keeps the $keep most recently activated
# distinct builds (a restart or rollback of a listed build moves it to the end
# instead of adding one). A serving container's fallback therefore survives the
# activation of one other build after it and is pruned by the second; only the
# build directly before this one is a fallback at all. Tabs on older builds, or
# a container still serving after two further activations, get 404 for chunks
# they have not fetched. A start that gives up on the lock chooses its fallback
# without it, so that choice can race a concurrent prune.
set -u

html=${RAINVER_WEB_ROOT:-/usr/share/nginx/html}
store=${RAINVER_WEB_ASSET_STORE:-/var/cache/rainver-web}
link=${RAINVER_WEB_PREVIOUS_LINK:-/run/rainver-web/previous}
lock_wait=${RAINVER_WEB_ASSET_LOCK_WAIT:-60}
keep=3
releases="$store/releases"
order="$store/order"

say() { echo "rainver-retain-assets: $*" >&2; }

valid_id() {
  case $1 in '' | *[!A-Za-z0-9_-]*) return 1 ;; esac
  [ "${#1}" -le 64 ]
}

# Prints `order`, nothing when it does not exist; fails when it exists but
# cannot be read. BusyBox grep reports a read error as "no match" (exit 1), so
# the file is read with cat, which fails on it.
read_order() {
  if [ ! -e "$order" ] && [ ! -L "$order" ]; then return 0; fi
  cat "$order" || { say "WARNING: cannot read $order"; return 1; }
}

# Called with the lock held. Every step either completes or leaves the store as
# it was: `order` names this build only after its snapshot is in place, a
# snapshot is pruned only after the new `order` no longer names it, and an
# unreadable `order` stops before anything is replaced or pruned.
record() {
  recorded=$(read_order) || return 1
  [ -d "$releases" ] || mkdir "$releases" || return 1
  for stale in "$store"/.staging.* "$store"/.order.* "$store"/.trash.*; do
    [ -e "$stale" ] || [ -L "$stale" ] || continue
    rm -rf "$stale" || return 1
  done
  # The first layout kept a shared symlink here; nothing reads it any more.
  if [ -L "$store/previous" ]; then rm -f "$store/previous" || return 1; fi

  if [ ! -d "$releases/$id" ]; then
    if [ -e "$releases/$id" ] || [ -L "$releases/$id" ]; then
      say "$releases/$id is not a directory"
      return 1
    fi
    staging=$(mktemp -d "$store/.staging.XXXXXX") || return 1
    chmod 0755 "$staging" || return 1
    cp -R "$html/assets" "$staging/assets" || return 1
    mv -T "$staging" "$releases/$id" || return 1
  fi

  kept=$(
    printf '%s\n' "$recorded" | while IFS= read -r entry; do
      [ -n "$entry" ] && [ "$entry" != "$id" ] && printf '%s\n' "$entry"
    done
    echo "$id"
  ) || return 1
  kept=$(printf '%s\n' "$kept" | tail -n "$keep") || return 1
  next=$(mktemp "$store/.order.XXXXXX") || return 1
  chmod 0644 "$next" || return 1
  printf '%s\n' "$kept" > "$next" || return 1
  mv -f -T "$next" "$order" || return 1

  # Pruning compares with the list just written, not a second read of `order`.
  for dir in "$releases"/* "$releases"/.[!.]*; do
    [ -e "$dir" ] || [ -L "$dir" ] || continue
    case "
$kept
" in *"
${dir##*/}
"*) continue ;; esac
    trash=$(mktemp -d "$store/.trash.XXXXXX") || return 1
    mv "$dir" "$trash/" || return 1
    rm -rf "$trash" || say "could not remove $trash yet; the next start retries"
  done
}

# Newest usable snapshot other than this build, by recorded order. Reads only,
# so it also works on a read-only store or after `record` failed. Called with
# the lock held whenever it was acquired, so no other start can replace
# `order` or prune the chosen snapshot between this start's `record` and the
# choice.
pick_previous() {
  listed=$(read_order) || return 0
  found=""
  while IFS= read -r candidate; do
    [ "$candidate" = "$id" ] && continue
    valid_id "$candidate" && [ -d "$releases/$candidate/assets" ] && found=$candidate
  done <<EOF
$listed
EOF
  [ -n "$found" ] && echo "$found"
  return 0
}

record_locked() {
  # BusyBox `test -w` is true for root even on a read-only mount, so opening
  # the lock file is the real writability check.
  if [ ! -w "$store" ] || ! { command exec 9>>"$store/.lock"; } 2>/dev/null; then
    say "WARNING: $store is not writable; build $id is not recorded"
    previous=$(pick_previous)
    return 0
  fi
  waited=0
  until flock -n 9; do
    if [ "$waited" -ge "$lock_wait" ]; then
      say "WARNING: another start held $store/.lock for ${lock_wait}s; build $id is not recorded"
      exec 9>&-
      previous=$(pick_previous)
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  if ! record; then
    say "WARNING: recording build $id in $store failed; the snapshots already there are kept"
  fi
  previous=$(pick_previous)
  exec 9>&-
}

main() {
  if [ ! -d "$store" ]; then
    say "no $store; previous build assets are not retained"
    return 0
  fi
  id=$(sed -n 's/.*"id":"\([A-Za-z0-9_-]\{1,64\}\)".*/\1/p' "$html/version.json" 2>/dev/null)
  if ! valid_id "$id" || [ ! -d "$html/assets" ]; then
    say "build id or assets missing; previous build assets are not retained"
    return 0
  fi

  previous=""
  record_locked
  if ! { mkdir -p "${link%/*}" && rm -f "$link"; }; then
    say "WARNING: cannot prepare $link; only build $id assets are served"
  elif [ -z "$previous" ]; then
    say "no previous build retained beside $id"
  elif ln -s "$releases/$previous" "$link"; then
    say "serving build $previous assets beside $id"
  else
    say "WARNING: cannot link $link; only build $id assets are served"
  fi
}

main
exit 0
