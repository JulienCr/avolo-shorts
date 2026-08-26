#!/usr/bin/env bash
# Lanceur de la tâche planifiée Windows. Invoqué comme un chemin unique par
# wsl.exe, sans acrobatie de guillemets côté Windows — voir
# docs/publication-scheduler.md pour pourquoi bash -lc ne fait pas l'affaire.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"

# /TR de schtasks lance ce script sans interpréteur de commandes : une
# redirection posée là finirait en argument nu dans "$@". La poser ici
# est donc la seule façon de la faire tenir.
log_file="$repo_root/projects/publish-scheduled.log"
mkdir -p "$(dirname "$log_file")"
exec >>"$log_file" 2>&1

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
    echo "publish-scheduled.sh: Node >= 22 requis, trouvé $node_version ($node_bin)."
    echo "PATH=$PATH"
  } >&2
  exit 1
fi

cd "$repo_root"
exec pnpm tsx scripts/publish-scheduled.ts "$@"
