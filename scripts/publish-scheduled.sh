#!/usr/bin/env bash
# Launcher for the Windows scheduled task. Invoked as a single path by
# wsl.exe, with no quoting gymnastics on the Windows side — see
# docs/publication-scheduler.md for why bash -lc cannot do this job.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  source "$NVM_DIR/nvm.sh" --no-use
  nvm use default >/dev/null
fi

node_bin="$(command -v node || true)"
node_version="none"
node_major=0
if [ -n "$node_bin" ]; then
  node_version="$("$node_bin" -v)"
  node_major="$(echo "$node_version" | sed -E 's/^v([0-9]+).*/\1/')"
fi

if ! [[ "$node_major" =~ ^[0-9]+$ ]] || [ "$node_major" -lt 22 ]; then
  {
    echo "publish-scheduled.sh: Node >= 22 requis, trouve $node_version ($node_bin)."
    echo "PATH=$PATH"
  } >&2
  exit 1
fi

cd "$repo_root"
exec pnpm tsx scripts/publish-scheduled.ts "$@"
