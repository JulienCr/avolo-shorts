#!/usr/bin/env bash
#
# Monte les deux dépendances natives du projet.
#
# 1. **Un ffmpeg qui sait parler à la carte** : NVENC pour encoder, CUDA pour
#    décoder, libass pour incruster les sous-titres. Le paquet d'Ubuntu embarque
#    libass mais n'est pas compilé avec NVENC ; le build statique de BtbN
#    embarque les trois. Voir docs/environnement.md pour les mesures.
# 2. **Le venv de la détection**, `worker/venv`, avec torch CUDA, ultralytics et
#    les poids YOLO. C'est ce que `worker/detect.py` fait tourner.
#
# Le script est idempotent : relancé, il ne retélécharge rien tant que ce qui est
# en place convient. `--force` passe outre. `--skip-detect` saute la seconde
# partie, qui pèse sept gigaoctets.
#
# Les deux moitiés vérifient leurs capacités **par un vrai essai** plutôt que par
# la présence d'un fichier — `nvenc_encodes()` encode quelques images, et
# `cuda_infers()` fait tourner une inférence YOLO sur le GPU. Un encodeur compilé
# peut échouer au premier appel si le pilote ne suit pas, et un `import torch`
# réussit très bien sur une roue processeur qui ne verra jamais la carte.

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

# Le venv de la détection, **dans le dépôt et pas ailleurs**. `WHISPER_PYTHON`
# pointe celui du diariseur de ~/dev/rythmo-impro, qui appartient à un autre
# dépôt et porte son propre correctif cuDNN : on n'y installe rien.
VENV="$REPO_DIR/worker/venv"
VENV_PY="$VENV/bin/python"
MODELS_DIR="$REPO_DIR/worker/models"

# Les poids YOLO, épinglés sur une release d'ultralytics/assets pour la même
# raison que le build ffmpeg : une étiquette mobile rendrait l'installation non
# reproductible. `yolo11m` est le modèle mesuré (docs de la PR d'itération 1) ;
# `yolo11x` détecte un peu plus mais coûte 40 % de temps en plus.
YOLO_RELEASE="${YOLO_RELEASE:-v8.3.0}"
YOLO_MODEL="${YOLO_MODEL:-yolo11m.pt}"
YOLO_URL="https://github.com/ultralytics/assets/releases/download/$YOLO_RELEASE/$YOLO_MODEL"
# La somme du fichier réellement installé le 18 août 2026. ultralytics/assets ne
# publie pas de `checksums.sha256`, donc elle est écrite ici plutôt que lue.
# Vide, ou un autre modèle demandé, et le contrôle est sauté avec un mot.
#
# `${VAR-défaut}` et non `${VAR:-défaut}` : la seconde forme remplace aussi une
# valeur **vide**, donc `YOLO_SHA256= ./setup.sh` — la façon documentée de ne pas
# vérifier — reprendrait la somme de `yolo11m` et ferait échouer l'installation
# de tout autre modèle. Ne pas vérifier doit rester possible.
YOLO_SHA256="${YOLO_SHA256-d5ffc1a674953a08e11a8d21e022781b1b23a19b730afc309290bd9fb5305b95}"

FORCE=0
SKIP_DETECT=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --skip-detect) SKIP_DETECT=1 ;;
    -h|--help)
      cat <<'EOF'
Usage : ./setup.sh [--force] [--skip-detect]

  --force         réinstalle même si ce qui est en place convient.
  --skip-detect   n'installe pas worker/venv (torch CUDA + ultralytics, 7 Go).

Variables :
  FFMPEG_PREFIX    dossier d'installation de ffmpeg (défaut : ~/.local/opt)
  FFMPEG_RELEASE   release BtbN à installer (défaut : le build mesuré).
                   `latest` prend le dernier build nocturne.
  YOLO_RELEASE     release ultralytics/assets des poids (défaut : v8.3.0)
  YOLO_MODEL       le fichier de poids (défaut : yolo11m.pt)
  YOLO_SHA256      sa somme attendue ; vide pour ne pas vérifier
  PYTHON           l'interpréteur qui crée worker/venv (défaut : python3)
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

# --- le venv de la détection --------------------------------------------------
#
# `worker/detect.py` a besoin de torch **avec CUDA** et d'ultralytics. Il ne peut
# pas emprunter le venv du diariseur : celui-ci appartient à ~/dev/rythmo-impro,
# et faire résoudre à pip les contraintes de WhisperX et celles d'ultralytics
# dans le même arbre ferait casser la transcription d'un dépôt par la mise à jour
# d'un autre. Les sept gigaoctets en double sont le prix de cette isolation.

# La preuve que la carte répond depuis ce venv, l'équivalent de `nvenc_encodes`
# pour le GPU : une inférence réelle sur un tenseur, pas un `import torch`. Une
# roue processeur s'importe très bien, ne voit jamais la carte, et ferait tourner
# la détection des heures au lieu de cinq minutes — sans un mot.
cuda_infers() {
  "$1" - <<'PY' >/dev/null 2>&1
import sys
import torch
if not torch.cuda.is_available():
    sys.exit(1)
# Une multiplication réelle : `is_available()` répond oui sur un pilote qui
# refusera d'allouer, et l'échec tomberait alors au milieu d'une analyse.
(torch.zeros(64, 64, device="cuda") @ torch.zeros(64, 64, device="cuda")).sum().item()
from ultralytics import YOLO  # noqa: E402
PY
}

if [ "$SKIP_DETECT" -eq 1 ]; then
  say "worker/venv sauté (--skip-detect) : l'étape analysis ne tournera pas"
elif [ "$FORCE" -eq 0 ] && [ -x "$VENV_PY" ] && cuda_infers "$VENV_PY"; then
  say "worker/venv déjà en place, CUDA répond."
  ok "$("$VENV_PY" -c 'import torch,ultralytics;print(f"torch {torch.__version__}, ultralytics {ultralytics.__version__}")')"
else
  PYTHON="${PYTHON:-python3}"
  command -v "$PYTHON" >/dev/null 2>&1 || { bad "$PYTHON est requis pour créer worker/venv"; exit 1; }

  say "Création de worker/venv avec $PYTHON"
  # Pas de `rm -rf` : un venv existant se met à jour par un `pip install`, et
  # détruire celui qui est là ferait retélécharger sept gigaoctets pour corriger
  # un paquet manquant.
  "$PYTHON" -m venv "$VENV" || { bad "création du venv impossible (python3-venv installé ?)"; exit 1; }
  "$VENV_PY" -m pip install --quiet --upgrade pip

  say "Installation de torch CUDA et d'ultralytics (plusieurs Go)"
  # L'index PyTorch est celui des roues CUDA 12.8. Sans lui, pip prend la
  # variante processeur, qui s'importe et ne voit pas la carte.
  if ! "$VENV_PY" -m pip install \
      --extra-index-url https://download.pytorch.org/whl/cu128 \
      -r "$REPO_DIR/worker/requirements-detect.txt"; then
    bad "l'installation des dépendances de détection a échoué"
    exit 1
  fi

  say "Vérification : une inférence réelle sur le GPU"
  if cuda_infers "$VENV_PY"; then
    ok "CUDA répond depuis worker/venv"
    ok "$("$VENV_PY" -c 'import torch,ultralytics;print(f"torch {torch.__version__}, ultralytics {ultralytics.__version__}")')"
  else
    bad "torch est installé mais CUDA ne répond pas depuis worker/venv."
    bad "Cause la plus fréquente : la roue processeur a été installée. Vérifier avec"
    bad "  $VENV_PY -c 'import torch; print(torch.__version__)'  — une roue CUDA finit par +cu128."
    exit 1
  fi
fi

# Les poids, à côté du venv. Téléchargés ici plutôt que laissés à ultralytics :
# livré à lui-même il les tire au premier appel, dans le dossier de travail du
# processus, donc à la racine du dépôt et sous une version qui bouge.
if [ "$SKIP_DETECT" -eq 0 ]; then
  poids="$MODELS_DIR/$YOLO_MODEL"
  if [ "$FORCE" -eq 0 ] && [ -s "$poids" ]; then
    say "Poids $YOLO_MODEL déjà en place."
  else
    command -v curl >/dev/null 2>&1 || { bad "curl est requis"; exit 1; }
    mkdir -p "$MODELS_DIR"
    say "Téléchargement de $YOLO_MODEL ($YOLO_RELEASE)"
    # Dans un fichier temporaire : un téléchargement coupé ne doit pas laisser
    # des poids tronqués sous le nom définitif, que la relance prendrait pour un
    # fichier valable — la même règle que `produireArtefact` côté Node.
    tmp_poids="$poids.partiel.$$"
    if ! curl -fL --retry 3 --retry-delay 2 -o "$tmp_poids" "$YOLO_URL"; then
      rm -f "$tmp_poids"
      bad "téléchargement de $YOLO_URL en échec"
      exit 1
    fi
    if [ -n "$YOLO_SHA256" ]; then
      somme="$(sha256sum "$tmp_poids" | cut -d' ' -f1)"
      if [ "$somme" != "$YOLO_SHA256" ]; then
        rm -f "$tmp_poids"
        bad "somme SHA-256 inattendue pour $YOLO_MODEL : $somme"
        bad "attendue : $YOLO_SHA256 (ajuster YOLO_SHA256 pour un autre modèle)"
        exit 1
      fi
      ok "somme conforme"
    else
      say "YOLO_SHA256 vide : la somme n'est pas vérifiée"
    fi
    mv "$tmp_poids" "$poids"
    ok "poids installés dans $poids"
  fi
fi

# --- rappeler la configuration ------------------------------------------------

if [ ! -f "$REPO_DIR/.env" ] && [ -f "$REPO_DIR/.env.example" ]; then
  say "Créer .env : cp .env.example .env, puis vérifier FFMPEG_BIN et FFPROBE_BIN"
fi

say "Prêt. FFMPEG_BIN=$FFMPEG"
if [ "$SKIP_DETECT" -eq 0 ]; then
  say "       DETECT_PYTHON=$VENV_PY"
fi
