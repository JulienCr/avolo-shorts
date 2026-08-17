#!/usr/bin/env bash
#
# Installe un ffmpeg qui sait parler à la carte : NVENC pour encoder, CUDA pour
# décoder, libass pour incruster les sous-titres.
#
# Le paquet ffmpeg d'Ubuntu embarque libass mais n'est pas compilé avec NVENC.
# Le build statique de BtbN embarque les trois. Voir docs/environnement.md pour
# les mesures qui justifient l'opération.
#
# Le script est idempotent : relancé, il ne retélécharge rien tant que le binaire
# en place expose les trois capacités. `--force` passe outre.

set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="${FFMPEG_PREFIX:-$HOME/.local/opt}"
DEST="$PREFIX/ffmpeg-nvenc"
FFMPEG="$DEST/bin/ffmpeg"
FFPROBE="$DEST/bin/ffprobe"
URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz"

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    -h|--help)
      cat <<'EOF'
Usage : ./setup.sh [--force]

  --force   réinstalle même si le binaire en place convient.

Variables :
  FFMPEG_PREFIX   dossier d'installation (défaut : ~/.local/opt)
EOF
      exit 0
      ;;
    *) echo "Option inconnue : $arg (voir --help)" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
ok()  { printf '    \033[32mok\033[0m   %s\n' "$*"; }
bad() { printf '    \033[31mko\033[0m   %s\n' "$*" >&2; }

# --- les trois capacités requises --------------------------------------------
# Elles vont ensemble. Un build qui a NVENC mais pas libass ne convient pas :
# les sous-titres sont incrustés par le filtre `ass`, pas ajoutés en piste.

# Deux précautions dans ces trois fonctions, chacune payée d'un faux négatif :
#
#   - pas de `grep -q`. Il sort dès la première correspondance, ffmpeg prend un
#     SIGPIPE en écrivant la suite de sa liste, et `set -o pipefail` transforme
#     ça en échec. La capacité est là, la fonction répond non — et seulement une
#     fois sur deux, selon qui gagne la course. On lit tout, on regarde après.
#   - le nombre de colonnes de drapeaux n'est pas stable : le ffmpeg d'Ubuntu
#     écrit « ... ass », le build BtbN « .. ass ». D'où `+` et non `{3}`.

grep_output() {
  # Isole le motif du bruit : renvoie les lignes trouvées, rien si aucune.
  grep -E "$1" || true
}

has_nvenc() {
  local hit
  hit="$("$1" -hide_banner -encoders 2>/dev/null | grep_output '(^|[[:space:]])h264_nvenc([[:space:]]|$)')"
  [ -n "$hit" ]
}

has_cuda() {
  local hit
  hit="$("$1" -hide_banner -hwaccels 2>/dev/null | grep_output '^[[:space:]]*cuda[[:space:]]*$')"
  [ -n "$hit" ]
}

has_ass() {
  local hit
  hit="$("$1" -hide_banner -filters 2>/dev/null | grep_output '^[[:space:]]*[TSC.]+[[:space:]]+ass[[:space:]]')"
  [ -n "$hit" ]
}

lists_all_three() {
  local ff="$1"
  [ -x "$ff" ] || return 1
  has_nvenc "$ff" && has_cuda "$ff" && has_ass "$ff"
}

# Encodage réel de quelques images de synthèse : la seule preuve que la carte
# répond. Un encodeur peut être compilé dans le binaire et échouer au premier
# appel (pilote absent, GPU saturé).
nvenc_encodes() {
  "$1" -hide_banner -nostdin -loglevel error \
    -f lavfi -i 'color=c=black:s=256x256:d=0.1:r=10' \
    -c:v h264_nvenc -f null - >/dev/null 2>&1
}

# --- étape 1 : installer ------------------------------------------------------

if [ "$FORCE" -eq 0 ] && lists_all_three "$FFMPEG"; then
  say "ffmpeg déjà en place dans $DEST — rien à télécharger."
else
  for tool in curl tar; do
    command -v "$tool" >/dev/null 2>&1 || { bad "$tool est requis"; exit 1; }
  done

  # L'archive visée est un binaire x86-64. Sur une autre architecture elle
  # s'installerait sans broncher et échouerait au premier appel, avec un message
  # qui ne dirait pas pourquoi.
  arch="$(uname -m)"
  if [ "$arch" != "x86_64" ]; then
    bad "architecture $arch non prise en charge : le build BtbN visé est linux64 (x86-64)"
    exit 1
  fi

  mkdir -p "$PREFIX"

  # Le dossier de travail est dans $PREFIX et non /tmp : le déplacement final
  # reste alors un simple renommage sur le même système de fichiers.
  tmp="$(mktemp -d "$PREFIX/.ffmpeg-install.XXXXXX")"
  trap 'rm -rf "$tmp"' EXIT

  # Pas de vérification de somme de contrôle, faute de somme à vérifier : la
  # release `latest` de BtbN est une étiquette mobile, réécrite à chaque build,
  # et elle ne publie pas de .sha256 (404 au 18 août 2026). L'intégrité repose
  # donc sur HTTPS vers github.com. Corollaire : deux exécutions à un mois
  # d'écart n'installent pas le même binaire. `setup.sh` affiche la version
  # obtenue, et docs/environnement.md consigne celle sur laquelle les mesures
  # ont été faites.
  say "Téléchargement du build statique BtbN"
  curl -fL --retry 3 --retry-delay 2 -o "$tmp/ffmpeg-gpl.tar.xz" "$URL"

  say "Extraction"
  tar -xf "$tmp/ffmpeg-gpl.tar.xz" -C "$tmp"

  # Le dossier de l'archive porte un nom qui change à chaque build : on prend le
  # seul dossier de premier niveau au lieu de coder son nom en dur.
  extracted="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d -print -quit)"
  if [ -z "$extracted" ] || [ ! -x "$extracted/bin/ffmpeg" ]; then
    bad "l'archive ne contient pas bin/ffmpeg — installation abandonnée"
    exit 1
  fi

  say "Installation dans $DEST"
  rm -rf "$DEST.old"
  if [ -e "$DEST" ]; then
    mv "$DEST" "$DEST.old"
  fi
  mv "$extracted" "$DEST"
  rm -rf "$DEST.old"
fi

# --- étape 2 : vérifier -------------------------------------------------------

say "Vérification"
status=0

if [ -x "$FFMPEG" ]; then
  # `sed -n 1p` et non `head -1` : head sort tôt, et le SIGPIPE qui s'ensuit
  # ferait échouer la substitution sous pipefail.
  ok "binaire : $FFMPEG ($("$FFMPEG" -version 2>/dev/null | sed -n '1p' | cut -d' ' -f1-3))"
else
  bad "binaire absent : $FFMPEG"
  exit 1
fi

if has_nvenc "$FFMPEG"; then ok "h264_nvenc compilé"; else bad "h264_nvenc absent"; status=1; fi
if has_cuda  "$FFMPEG"; then ok "-hwaccel cuda disponible"; else bad "-hwaccel cuda absent"; status=1; fi
if has_ass   "$FFMPEG"; then
  ok "filtre ass (libass) présent"
else
  bad "filtre ass absent — ce build ne convient pas : les sous-titres sont incrustés par libass"
  status=1
fi

if [ -x "$FFPROBE" ]; then ok "ffprobe : $FFPROBE"; else bad "ffprobe absent : $FFPROBE"; status=1; fi

if nvenc_encodes "$FFMPEG"; then
  ok "encodage NVENC réel : la carte répond"
else
  bad "NVENC est compilé mais l'encodage échoue (pilote ? GPU saturé ?)"
  status=1
fi

if [ "$status" -ne 0 ]; then
  bad "vérification en échec — relancer avec --force, ou lire docs/environnement.md"
  exit 1
fi

# --- étape 3 : rappeler la configuration --------------------------------------

if [ ! -f "$REPO_DIR/.env" ] && [ -f "$REPO_DIR/.env.example" ]; then
  say "Créer .env : cp .env.example .env, puis vérifier FFMPEG_BIN et FFPROBE_BIN"
fi

say "Prêt. FFMPEG_BIN=$FFMPEG"
