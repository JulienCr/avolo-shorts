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

# Build épinglé, et non l'étiquette `latest`. BtbN réécrit `latest` à chaque
# build nocturne : s'en remettre à elle rendrait l'installation non
# reproductible, alors que la spec §5 confie précisément ce rôle à ce script.
# La valeur ci-dessous est la release qui porte le binaire sur lequel les
# mesures de docs/environnement.md ont été faites.
#
# Pour prendre sciemment un build plus récent :
#   FFMPEG_RELEASE=latest ./setup.sh --force
# puis reporter la nouvelle version et les nouvelles mesures dans la doc.
RELEASE="${FFMPEG_RELEASE:-autobuild-2026-08-17-13-05}"
BASE_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/$RELEASE"

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    -h|--help)
      cat <<'EOF'
Usage : ./setup.sh [--force]

  --force   réinstalle même si le binaire en place convient.

Variables :
  FFMPEG_PREFIX    dossier d'installation (défaut : ~/.local/opt)
  FFMPEG_RELEASE   release BtbN à installer (défaut : le build mesuré).
                   `latest` prend le dernier build nocturne.
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
#     ça en échec. La capacité est là, la fonction répond non, et seulement une
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

# Vérifie un dossier `bin` complet. Prend le dossier en argument plutôt que de
# lire $DEST : c'est ce qui permet de contrôler le build téléchargé **avant** de
# remplacer l'installation en place.
verify_build() {
  local bindir="$1"
  local ff="$bindir/ffmpeg"
  local fp="$bindir/ffprobe"
  local st=0

  if [ -x "$ff" ]; then
    # `sed -n 1p` et non `head -1` : head sort tôt, et le SIGPIPE qui s'ensuit
    # ferait échouer la substitution sous pipefail.
    ok "ffmpeg : $("$ff" -version 2>/dev/null | sed -n '1p' | cut -d' ' -f1-3)"
  else
    bad "ffmpeg absent : $ff"
    return 1
  fi

  if [ -x "$fp" ]; then ok "ffprobe présent"; else bad "ffprobe absent : $fp"; st=1; fi

  if has_nvenc "$ff"; then ok "h264_nvenc compilé"; else bad "h264_nvenc absent"; st=1; fi
  if has_cuda  "$ff"; then ok "-hwaccel cuda disponible"; else bad "-hwaccel cuda absent"; st=1; fi
  if has_ass   "$ff"; then
    ok "filtre ass (libass) présent"
  else
    bad "filtre ass absent : ce build ne convient pas, les sous-titres sont incrustés par libass"
    st=1
  fi

  if nvenc_encodes "$ff"; then
    ok "encodage NVENC réel : la carte répond"
  else
    bad "NVENC est compilé mais l'encodage échoue (pilote ? GPU saturé ?)"
    st=1
  fi

  return "$st"
}

# --- installer, ou constater que c'est déjà fait ------------------------------

if [ "$FORCE" -eq 0 ] && lists_all_three "$FFMPEG"; then
  say "ffmpeg déjà en place dans $DEST, rien à télécharger."
  say "Vérification"
  if ! verify_build "$DEST/bin"; then
    bad "vérification en échec, relancer avec --force ou lire docs/environnement.md"
    exit 1
  fi
else
  for tool in curl tar sha256sum awk; do
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

  # Le nom de l'archive change d'une release à l'autre (`latest` publie
  # `ffmpeg-master-latest-…`, une release datée `ffmpeg-N-126188-g426841da9d-…`).
  # On le lit dans le fichier de sommes plutôt que de le construire, ce qui rend
  # le script indifférent à FFMPEG_RELEASE. Le motif se termine par
  # `linux64-gpl.tar.xz`, ce qui écarte au passage les variantes `-shared`.
  say "Release $RELEASE : lecture des sommes de contrôle"
  curl -fsSL --retry 3 --retry-delay 2 -o "$tmp/checksums.sha256" "$BASE_URL/checksums.sha256"

  archive="$(awk '$2 ~ /linux64-gpl\.tar\.xz$/ { print $2; exit }' "$tmp/checksums.sha256")"
  if [ -z "$archive" ]; then
    bad "aucune archive linux64-gpl dans les sommes de la release $RELEASE"
    exit 1
  fi

  say "Téléchargement de $archive"
  curl -fL --retry 3 --retry-delay 2 -o "$tmp/$archive" "$BASE_URL/$archive"

  say "Vérification de la somme SHA-256"
  awk -v a="$archive" '$2 == a { print; exit }' "$tmp/checksums.sha256" > "$tmp/archive.sha256"
  if ! ( cd "$tmp" && sha256sum -c archive.sha256 >/dev/null 2>&1 ); then
    bad "somme SHA-256 incorrecte pour $archive : téléchargement rejeté"
    exit 1
  fi
  ok "somme conforme"

  say "Extraction"
  tar -xf "$tmp/$archive" -C "$tmp"

  # Le dossier de l'archive porte un nom qui change à chaque build : on prend le
  # seul dossier de premier niveau au lieu de coder son nom en dur.
  extracted="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d -print -quit)"
  if [ -z "$extracted" ] || [ ! -x "$extracted/bin/ffmpeg" ]; then
    bad "l'archive ne contient pas bin/ffmpeg, installation abandonnée"
    exit 1
  fi

  # On contrôle le candidat AVANT de toucher à l'installation en place. Un build
  # qui aurait perdu libass, ou qui ne parlerait plus au pilote, échoue ici et
  # laisse l'existant intact.
  say "Vérification du build téléchargé, avant de toucher à l'installation en place"
  if ! verify_build "$extracted/bin"; then
    bad "le build téléchargé ne convient pas : $DEST n'a pas été modifié"
    exit 1
  fi

  say "Installation dans $DEST"
  rm -rf "$DEST.old"
  if [ -e "$DEST" ]; then
    mv "$DEST" "$DEST.old"
  fi
  if ! mv "$extracted" "$DEST"; then
    bad "le déplacement vers $DEST a échoué"
    if [ -e "$DEST.old" ]; then
      mv "$DEST.old" "$DEST"
      bad "installation précédente restaurée"
    fi
    exit 1
  fi
  rm -rf "$DEST.old"
fi

# --- rappeler la configuration ------------------------------------------------

if [ ! -f "$REPO_DIR/.env" ] && [ -f "$REPO_DIR/.env.example" ]; then
  say "Créer .env : cp .env.example .env, puis vérifier FFMPEG_BIN et FFPROBE_BIN"
fi

say "Prêt. FFMPEG_BIN=$FFMPEG"
