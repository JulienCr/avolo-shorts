#!/usr/bin/env python3
"""L'extraction brute pour la première arme du spike : qui parle, dans un plan à
deux personnes ?

Le pari : la bouche qui bouge **en synchronie avec le son** est celle qui
parle. Le mouvement seul ne discrimine pas — un rire, un hochement de tête, une
mastication bougent la bouche sans qu'elle parle. Ce script ne tranche rien :
il extrait la matière (patchs de bouche, points de pose, enveloppe audio) et
l'écrit brute dans un ``.npz``. La décision — comparer le mouvement à l'audio,
choisir qui parle — vivra ailleurs, en TypeScript. C'est la même discipline que
``worker/detect.py``, dont la sortie reste brute pour que les filtres puissent
vivre dans ``src/core/framing.ts`` et se défaire sans heures de GPU : lire son
en-tête pour le détail de ce choix, il vaut aussi ici.

**Le décodage n'est pas celui de ``flux_images``, et c'est délibéré.**
``flux_images`` (``worker/detect.py``) décode depuis le tout début du proxy,
ce qui convient à ``detect.py`` puisqu'il traite le fichier entier. Ici, la
fenêtre demandée (``--start``/``--end``) tombe n'importe où dans un proxy de
plusieurs heures — 7154 s dans la vérification ci-dessous — et décoder depuis 0
pour atteindre 7154 s reviendrait à payer deux heures de décodage pour 45
secondes utiles. ``decode_window`` ci-dessous reprend exactement la même
technique défensive que ``flux_images`` (stderr dans un fichier temporaire, pas
un tube — interblocage à 64 Ko ; vérification que le reste de la division par
``largeur * hauteur * 3`` est nul), mais avec ``-ss`` **avant** ``-i`` pour la
recherche rapide et ``-t`` pour borner la durée décodée. ``flatten_keypoints``,
lui, s'importe tel quel : rien dans le passage aux fractions ou la troncature
de confiance ne dépend d'où commence le décodage.

**Le piège du filtre ``fps=``, déjà payé ailleurs dans ce dépôt.** Le filtre
affecte chaque image d'entrée à l'emplacement de sortie **le plus proche**,
donc le contenu de l'image étiquetée ``t`` peut en réalité venir d'un instant
postérieur, jusqu'à ``1 / (2 * fps)`` plus tard. À 30 im/s, ça fait 17 ms —
absorbé sans peine par la recherche de décalage entre bouche et son que ce
script prépare. Mais il faut que ce soit écrit : à 2 im/s, le même effet a fait
rater 22 bascules de composition sur 58 dans ``worker/detect.py`` (voir
``refine_switch``), pour la même raison — une étiquette de temps qui n'est pas
tout à fait celle du contenu qu'elle porte.

**Le rang d'une personne (rang 0 = la plus à gauche de l'image, par abscisse du
centre de sa boîte) n'est pas un suivi.** Il se recalcule à chaque image, sans
aucune mémoire de l'image précédente. C'est une identité fragile qui casse dès
que deux personnes se croisent à l'écran — choix assumé pour un plateau à deux
fauteuils, où les deux comédiens ne changent pas de côté en cours de plan. Voir
``rank_detections``.

**La région de bouche n'est jamais devinée.** Si le nez n'est pas assez
confiant pour situer un visage, la personne n'a pas de région de bouche à
cette image, point : ni centre approximatif, ni dernière position connue. Une
bouche cherchée au mauvais endroit produit un signal qui ressemble à du
signal — c'est plus dangereux qu'une case vide. Voir ``mouth_roi``.

**La géométrie de la région se construit entièrement en pixels, jamais en
mélangeant des fractions de largeur et de hauteur.** Deux versions écartées
avant celle-ci, chacune vue fausse sur les PNG de contrôle, pas au chiffre.
La première calculait un carré nez-centré, dimensionné sur l'étendue des
points de tête : centré sur le nez, il place la région du mauvais côté du
visage dès que le nez n'est plus au milieu (trois quarts, profil), et sa
taille — celle de la tête entière — n'a aucune raison de coïncider avec celle
d'une bouche. La seconde remplaçait ça par le vecteur **œil → nez**, gardé
comme centre *et* direction ; sa **norme** est une bonne échelle de visage,
mais sa **direction** ne l'est pas — de profil, ce vecteur pointe presque à
l'horizontale, et prolonger le long de lui pousse hors du visage plutôt que
vers la bouche. La construction actuelle garde cette norme comme échelle mais
en sépare la direction : vers le bas de l'image par défaut, rattrapée par la
perpendiculaire à l'axe des deux yeux quand il est mesurable (roulis de la
tête). Voir ``mouth_roi`` pour le détail et les deux cas qui ont fait
tomber les versions précédentes.

**``present`` et ``mouth`` sont deux absences différentes, pas une seule.**
Une personne détectée dont le nez n'est pas assez confiant *est là* — sa boîte
et ses points de pose sont réels et utiles au rang, à l'orientation — mais
n'a *pas* de région de bouche fiable à cette image. Ecrire les deux sous un
seul indicateur aurait forcé un choix entre deux lectures fausses : soit
NaN-er une boîte parfaitement valide (perdre de l'information réelle), soit
laisser `mouth` hériter de `present` (fabriquer une région là où aucune
n'est fiable). CLAUDE.md le nomme « Distinguer l'absence d'information de son
ambiguïté » : un défaut prudent choisi pour l'une des deux devient un choix
actif, et faux, dans l'autre. `present` dit « ce rang est occupé » ; `mouth`
dit « et j'ai pu viser sa bouche » ; `mouth` implique `present`, jamais
l'inverse.

**Les PNG de contrôle ne sont pas un agrément.** La géométrie de la région de
bouche (``mouth_roi``) vient d'une estimation à l'œil sur une poignée d'images ;
personne ne sait encore si elle tombe sur la bouche ou sur la joue — la
première version de cette géométrie est tombée sur le fauteuil et sur le fond,
vue à l'image, pas au chiffre. Ce dépôt compte cinq fois où une lecture
d'image a renversé une conclusion chiffrée (voir CLAUDE.md, « Distinguer
l'absence d'information de son ambiguïté »). D'où la seconde exigence sur ces
PNG : montrer, à côté du rectangle visé, le **patch tel qu'il sera stocké** —
le rectangle dit où on a visé, le patch dit ce qu'on a attrapé, et un
décalage de dix pixels ne se voit que sur le second.

Sortie : un seul ``.npz`` compressé — ``t``, ``present``, ``mouth``, ``patch``,
``roi``, ``box``, ``k``, ``audio_env``, ``meta``. Le détail des formes et des
types est dans la spécification du chantier ; ``meta`` porte assez
d'information (proxy, bornes, réglages, version) pour qu'un fichier se relise
sans son invocation.
"""

import argparse
import json
import math
import os
import subprocess
import sys
import tempfile
import time
import wave

import cv2
import numpy as np

from detect import flatten_keypoints as flatten_pose_points

SCRIPT_VERSION = 1

# La classe *person* du jeu COCO — la seule qui nous intéresse, comme dans
# `worker/detect.py` (`CLASSE_PERSONNE`). Redéfinie ici plutôt qu'importée :
# c'est un entier littéral, pas une logique à dupliquer, et l'importer
# introduirait un identifiant français dans un fichier qui n'en porte aucun.
PERSON_CLASS = 0

# Nez, œil gauche, œil droit, oreille gauche, oreille droite — dans cet ordre
# précis dans le squelette COCO à 17 points (voir `POINT` dans
# `src/core/shots.ts`).
HEAD_POINT_INDICES = (0, 1, 2, 3, 4)

# La confiance minimale d'un point de tête pour qu'il compte dans la région de
# bouche — spec §4.
MIN_HEAD_POINT_CONF = 0.5

# En dessous de cette norme (en pixels) du vecteur oeil -> nez, le visage est
# trop petit ou les points trop dégénérés pour fonder une échelle dessus.
MOUTH_MIN_EYE_NOSE_NORM = 4.0

# Les deux coefficients de la région de bouche, mesurés à la main sur deux
# personnes réelles (voir `mouth_roi`) : le centre glisse aux 3/4 du vecteur
# oeil -> nez au-delà du nez, la région fait 2,4 fois cette norme en largeur
# et 1,8 fois en hauteur — une bouche est plus large que haute.
MOUTH_CENTER_FACTOR = 0.75
MOUTH_WIDTH_FACTOR = 2.4
MOUTH_HEIGHT_FACTOR = 1.8

# En dessous de cette part de la norme oeil -> nez, l'axe des deux yeux est
# trop raccourci par la perspective (visage presque de profil) pour qu'on lui
# fasse dire quoi que ce soit sur le roulis de la tete — voir `mouth_roi`.
MOUTH_MIN_EYE_SEPARATION = 0.4

# Le WAV que produit l'étape audio du pipeline (`src/server/steps/audio.ts`) :
# 16 kHz, mono, PCM 16 bits. On le vérifie, on ne le suppose jamais.
AUDIO_EXPECTED_RATE = 16000
AUDIO_SAMPLE_WIDTH = 2  # octets, PCM s16
AUDIO_CHANNELS = 1

# Fenêtres de 10 ms à 16 kHz : 160 échantillons, soit 100 Hz en sortie.
AUDIO_WINDOW_SAMPLES = 160

# Images par lot GPU — fixé par la spec, pas un réglage exposé en ligne de
# commande.
MODEL_BATCH_SIZE = 32


def journal(message: str) -> None:
    """Sur stderr, jamais stdout — même discipline que `worker/detect.py`."""
    print(message, file=sys.stderr, flush=True)


def floor_to(value: float, decimals: int) -> float:
    """Tronque vers le bas, jamais au plus proche.

    Même règle et même raison que `arrondi_vers_le_bas` dans
    `worker/detect.py` : `score` sera un jour comparé à un seuil inclusif
    ailleurs dans ce dépôt (CLAUDE.md le documente comme une règle générale,
    pas locale à un seul champ), et un arrondi au plus proche ferait
    franchir ce seuil à une valeur qui ne l'a pas atteint.
    """
    factor = 10**decimals
    return math.floor(value * factor) / factor


# ---------------------------------------------------------------------------
# Le décodage de la fenêtre
# ---------------------------------------------------------------------------


def decode_window(
    ffmpeg: str, proxy: str, start: float, end: float, fps: float, width: int, height: int
):
    """Décode ``[start, end]`` du proxy à ``fps`` images par seconde, en BGR brut.

    ``-ss`` avant ``-i`` pour la recherche rapide (ffmpeg cherche la
    keyframe la plus proche puis décode jusqu'au point exact demandé, plutôt
    que de tout décoder depuis 0) ; ``-t`` borne la durée décodée après ce
    point. L'image de rang ``i`` porte ``t = start + i / fps`` — voir la
    mise en garde sur le filtre ``fps=`` dans l'en-tête du fichier.

    Reprend la technique de `flux_images` (`worker/detect.py`), pas son
    code : stderr dans un `TemporaryFile` et non un tube, pour éviter
    l'interblocage à 64 Ko qu'un tube plein provoquerait entre un ffmpeg
    bloqué en écriture et un parent bloqué en lecture ; et un reste non nul
    dans la division par `largeur * hauteur * 3` lève, parce qu'une
    géométrie fausse cisaillerait chaque image en silence.
    """
    frame_bytes = width * height * 3
    args = [
        ffmpeg,
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-ss",
        f"{start:.6f}",
        "-i",
        proxy,
        "-t",
        f"{end - start:.6f}",
        "-an",
        "-sn",
        "-vf",
        f"fps={fps}",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "bgr24",
        "-",
    ]
    with tempfile.TemporaryFile() as error_log:
        proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=error_log)
        try:
            while True:
                raw = proc.stdout.read(frame_bytes)
                if len(raw) < frame_bytes:
                    if raw:
                        raise RuntimeError(
                            f"Flux tronqué : {len(raw)} octets de reste pour des images de "
                            f"{frame_bytes} ({width}x{height}x3). Les dimensions du proxy "
                            "relevées ne correspondent pas au flux décodé."
                        )
                    break
                # `.copy()` : `frombuffer` rend un tableau en lecture seule, et
                # ultralytics écrit dans celui qu'on lui donne quand il
                # redimensionne sur place (même mise en garde que dans
                # `flux_images`).
                yield np.frombuffer(raw, dtype=np.uint8).reshape(height, width, 3).copy()
        finally:
            if proc.stdout is not None:
                proc.stdout.close()
            code = proc.wait()
            error_log.seek(0)
            error_text = error_log.read().decode("utf-8", "replace")
            # 0 est le cas nominal ; un tube fermé en avance donne 141
            # (128 + SIGPIPE), qui n'est pas une erreur de décodage.
            if code not in (0, 141, -13):
                tail = "\n".join(error_text.strip().splitlines()[-20:])
                raise RuntimeError(
                    f"ffmpeg a échoué en décodant la fenêtre [{start}, {end}] (code {code}).\n"
                    f"Commande : {' '.join(args)}\n"
                    f"Dernières lignes :\n{tail or '(stderr vide)'}"
                )


def probe_size(proxy: str) -> tuple[int, int]:
    """Les dimensions du proxy, lues une seule fois — pas via ffprobe (pas de
    binaire dédié dans les arguments de ce script), via OpenCV, déjà présent
    pour le redimensionnement des patchs et sans coût de démarrage notable
    (une centaine de millisecondes, mesuré)."""
    capture = cv2.VideoCapture(proxy)
    if not capture.isOpened():
        raise RuntimeError(f"Impossible d'ouvrir {proxy} pour en lire les dimensions.")
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    capture.release()
    if width <= 0 or height <= 0:
        raise RuntimeError(f"Dimensions illisibles pour {proxy} : {width}x{height}.")
    return width, height


# ---------------------------------------------------------------------------
# Le rang des personnes et la région de bouche
# ---------------------------------------------------------------------------


def rank_detections(
    xyxy: list[tuple[float, float, float, float]],
    scores: list[float],
    poses: list | None,
    max_people: int,
) -> list[dict]:
    """Classe les détections d'une image : au plus ``max_people``, celles de
    plus haut score, puis triées par abscisse du centre de boîte croissante —
    rang 0 est la personne la plus à gauche.

    **Aucun suivi inter-images.** Le rang se recalcule à chaque image sans
    mémoire de la précédente : une identité fragile qui casse si deux
    personnes se croisent à l'écran, un choix assumé pour un plateau à deux
    fauteuils où les comédiens ne changent pas de côté en cours de plan.
    """
    detections = []
    for index, ((x0, y0, x1, y1), score) in enumerate(zip(xyxy, scores)):
        points = poses[index] if poses is not None and index < len(poses) else None
        detections.append({"box": (x0, y0, x1, y1), "score": score, "points": points})
    kept = sorted(detections, key=lambda d: d["score"], reverse=True)[:max_people]
    return sorted(kept, key=lambda d: (d["box"][0] + d["box"][2]) / 2.0)


def mouth_roi(
    points: list[tuple[float, float, float]] | None,
) -> tuple[float, float, float, float] | None:
    """Le rectangle ``(x0, y0, x1, y1)`` en pixels de la région de bouche, ou
    ``None`` si aucune région fiable ne peut s'y fonder.

    **Tout se calcule en pixels, jamais en fractions.** Une fraction de
    largeur (``x / w``) et une fraction de hauteur (``y / h``) ne sont pas la
    même unité : un carré construit en mélangeant les deux devient, une fois
    reconverti en pixels, un rectangle dans le rapport largeur/hauteur de
    l'image (960/540 = 1,78 sur ce corpus) — plausible à l'œil sur une seule
    image, mais faux, et c'est précisément le genre d'erreur qui ne se signale
    pas. `points` (issu de `keypoints.data` d'ultralytics) est déjà en pixels
    de l'image passée au modèle ; rien ici ne le reconvertit avant le retour.

    **Le vecteur œil → nez, pas un carré nez-centré.** La version précédente
    centrait un carré sur le nez, dimensionné sur l'étendue des cinq points de
    tête. Deux défauts, vus sur les PNG de contrôle et pas au chiffre : sur un
    visage de trois quarts ou de profil, le nez est **au bord** du visage, donc
    un carré centré dessus déborde du côté opposé à la bouche — jusqu'à
    tomber entièrement hors du visage ; et la taille d'une tête entière n'a
    aucune raison de coïncider avec celle d'une bouche. Le vecteur allant du
    repère des yeux au nez pointe vers le bas du visage quel que soit le lacet
    de la tête, et sa norme est une échelle de visage peu sensible à cet
    angle — c'est elle qui remplace `head_w`/`head_h` d'avant. Vérifié à la
    main sur deux personnes réelles de ce corpus : la construction place le
    centre à quelques pixels de la bouche pour une région large de ~37 px
    contre une bouche mesurée à ~25 px — l'ancienne faisait 123 px de côté sur
    les mêmes images.

    **Le repère des yeux** est leur milieu si les deux sont confiants, l'œil
    confiant seul si un seul l'est, et il n'y a pas de région si aucun ne
    l'est — même refus de deviner que pour le nez, qui doit rester confiant
    comme avant. Si la norme du vecteur œil → nez tombe sous
    `MOUTH_MIN_EYE_NOSE_NORM` (visage minuscule ou points quasi confondus),
    pas de région non plus : une échelle mesurée sur quelques pixels est du
    bruit, pas une échelle.

    **La norme du vecteur œil → nez est une bonne échelle, sa direction ne
    l'est pas — trouvé sur `00270_t7163.30.png`.** Rang #0, tête baissée et
    tournée : le rectangle atterrissait entièrement à droite du visage, sur le
    fond, et l'incrustation ne montrait qu'un bord de menton pâle sur du noir.
    Sur un visage de profil, l'œil est loin du nez **latéralement** et à peine
    au-dessus : le vecteur œil → nez pointe presque à l'horizontale. Prolonger
    dans cette direction pousse vers l'avant du visage et le dépasse, au lieu
    de descendre vers la bouche.

    **La direction retenue est donc « vers le bas », pas « le long du
    vecteur ».** Par défaut, le bas de l'image (``(0, 1)``) : les têtes de ce
    corpus sont quasi droites, l'approximation tient dans l'immense majorité
    des cas. Quand les deux yeux sont confiants **et** que leur écartement
    reste une fraction substantielle de l'échelle du visage
    (``MOUTH_MIN_EYE_SEPARATION`` de la norme œil → nez — sous ce seuil, la
    perspective a trop raccourci l'axe des yeux pour qu'il dise quoi que ce
    soit du roulis), la perpendiculaire à l'axe des deux yeux remplace la
    verticale : elle suit le roulis de la tête (une tête penchée sur le côté)
    sans jamais suivre le lacet (une tête tournée), qui est justement ce qui
    faisait dériver l'ancienne construction. Une perpendiculaire à deux points
    a deux sens opposés ; celui qu'on garde est celui dont le produit
    scalaire avec le vecteur œil → nez est positif — c'est mécaniquement celui
    qui va des yeux vers le bas du visage, jamais vers le haut.
    """
    if points is None:
        return None
    nose_x, nose_y, nose_conf = points[0]
    if nose_conf < MIN_HEAD_POINT_CONF:
        return None
    left_eye_x, left_eye_y, left_eye_conf = points[1]
    right_eye_x, right_eye_y, right_eye_conf = points[2]
    left_ok = left_eye_conf >= MIN_HEAD_POINT_CONF
    right_ok = right_eye_conf >= MIN_HEAD_POINT_CONF
    both_ok = left_ok and right_ok
    if both_ok:
        eye_x = (left_eye_x + right_eye_x) / 2.0
        eye_y = (left_eye_y + right_eye_y) / 2.0
    elif left_ok:
        eye_x, eye_y = left_eye_x, left_eye_y
    elif right_ok:
        eye_x, eye_y = right_eye_x, right_eye_y
    else:
        return None

    vec_x = nose_x - eye_x
    vec_y = nose_y - eye_y
    norm = math.hypot(vec_x, vec_y)
    if not math.isfinite(norm) or norm < MOUTH_MIN_EYE_NOSE_NORM:
        return None

    # « Vers le bas », pas « le long du vecteur œil -> nez » : voir la
    # docstring. La verticale image est le défaut ; l'axe des deux yeux ne la
    # remplace que lorsqu'il est mesurable (les deux yeux confiants) et assez
    # long pour être fiable (pas raccourci par la perspective).
    down_x, down_y = 0.0, 1.0
    if both_ok:
        line_x = right_eye_x - left_eye_x
        line_y = right_eye_y - left_eye_y
        eye_separation = math.hypot(line_x, line_y)
        if eye_separation >= MOUTH_MIN_EYE_SEPARATION * norm:
            # Les deux perpendiculaires à l'axe des yeux ; celle qui va vers
            # le nez (produit scalaire positif avec le vecteur oeil -> nez)
            # est celle qui pointe vers le bas du visage.
            candidate = (-line_y, line_x)
            if candidate[0] * vec_x + candidate[1] * vec_y < 0:
                candidate = (-candidate[0], -candidate[1])
            # `candidate` a la même norme que `line` (une rotation ne change
            # pas la longueur) ; `eye_separation` est donc déjà cette norme,
            # positive puisque vérifiée ci-dessus.
            down_x, down_y = candidate[0] / eye_separation, candidate[1] / eye_separation

    center_x = nose_x + MOUTH_CENTER_FACTOR * norm * down_x
    center_y = nose_y + MOUTH_CENTER_FACTOR * norm * down_y
    half_w = (MOUTH_WIDTH_FACTOR * norm) / 2.0
    half_h = (MOUTH_HEIGHT_FACTOR * norm) / 2.0
    return (center_x - half_w, center_y - half_h, center_x + half_w, center_y + half_h)


def crop_mouth_patch(frame_bgr: np.ndarray, roi: tuple[float, float, float, float], size: int) -> np.ndarray:
    """Découpe le rectangle ``roi`` (en pixels, pas nécessairement carré —
    voir `mouth_roi`) dans ``frame_bgr``, complète de noir ce qui déborde du
    cadre — jamais en décalant la fenêtre, ce qui introduirait un mouvement
    qui n'est pas celui de la bouche —, convertit en niveaux de gris et
    redimensionne en ``size`` x ``size``.
    """
    height, width = frame_bgr.shape[:2]
    x0, y0, x1, y1 = roi
    ix0, iy0 = int(math.floor(x0)), int(math.floor(y0))
    ix1, iy1 = int(math.ceil(x1)), int(math.ceil(y1))
    roi_w = max(ix1 - ix0, 1)
    roi_h = max(iy1 - iy0, 1)
    canvas = np.zeros((roi_h, roi_w, 3), dtype=np.uint8)
    src_x0, src_y0 = max(ix0, 0), max(iy0, 0)
    src_x1, src_y1 = min(ix1, width), min(iy1, height)
    if src_x1 > src_x0 and src_y1 > src_y0:
        dst_x0, dst_y0 = src_x0 - ix0, src_y0 - iy0
        canvas[dst_y0 : dst_y0 + (src_y1 - src_y0), dst_x0 : dst_x0 + (src_x1 - src_x0)] = (
            frame_bgr[src_y0:src_y1, src_x0:src_x1]
        )
    gray = cv2.cvtColor(canvas, cv2.COLOR_BGR2GRAY)
    return cv2.resize(gray, (size, size), interpolation=cv2.INTER_AREA)


# ---------------------------------------------------------------------------
# L'audio
# ---------------------------------------------------------------------------


def read_audio_envelope(path: str, start: float, end: float) -> np.ndarray:
    """L'enveloppe RMS de ``[start, end]``, par fenêtres de 10 ms (100 Hz).

    Lit uniquement l'intervalle utile — `setpos` puis `readframes`, jamais le
    fichier entier, qui pèse 190 à 330 Mo sur ce corpus. Vérifie le format
    (16 kHz, mono, PCM s16) plutôt que de le supposer : un fichier qui ne le
    respecte pas produirait une enveloppe silencieusement fausse — mauvaise
    échelle de temps, mauvaise amplitude — sans qu'aucune valeur ne le trahisse.
    """
    with wave.open(path, "rb") as wav:
        if (
            wav.getnchannels() != AUDIO_CHANNELS
            or wav.getsampwidth() != AUDIO_SAMPLE_WIDTH
            or wav.getframerate() != AUDIO_EXPECTED_RATE
        ):
            raise ValueError(
                f"{path} n'est pas un WAV {AUDIO_EXPECTED_RATE} Hz mono PCM s16 : trouvé "
                f"{wav.getnchannels()} canal/canaux, {wav.getsampwidth() * 8} bits, "
                f"{wav.getframerate()} Hz."
            )
        rate = wav.getframerate()
        total_frames = wav.getnframes()
        start_frame = round(start * rate)
        end_frame = round(end * rate)
        if start_frame < 0 or end_frame > total_frames:
            raise ValueError(
                f"L'intervalle audio [{start}, {end}] dépasse la durée du fichier "
                f"({total_frames / rate:.1f} s) : {path}."
            )
        wav.setpos(start_frame)
        raw = wav.readframes(end_frame - start_frame)

    samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    usable = (len(samples) // AUDIO_WINDOW_SAMPLES) * AUDIO_WINDOW_SAMPLES
    windows = samples[:usable].reshape(-1, AUDIO_WINDOW_SAMPLES)
    if windows.shape[0] == 0:
        return np.zeros((0,), dtype=np.float32)
    return np.sqrt(np.mean(windows**2, axis=1)).astype(np.float32)


# ---------------------------------------------------------------------------
# Les images de contrôle
# ---------------------------------------------------------------------------

# Une couleur BGR distincte par rang, jusqu'à quatre personnes — au-delà, les
# couleurs se répètent, ce qui reste lisible pour un contrôle visuel.
DEBUG_COLORS = [(0, 220, 0), (0, 140, 255), (255, 0, 220), (0, 220, 255)]


def dump_targets(total_frames: int, count: int) -> list[int]:
    """``count`` indices d'image répartis régulièrement sur ``[0, total_frames)``.

    Un seul indice retenu tombe au milieu plutôt qu'au début : montrer la
    première image d'un plan de 45 s renseigne moins que d'en montrer le
    centre.
    """
    if count <= 0 or total_frames <= 0:
        return []
    if count == 1:
        return [total_frames // 2]
    step = (total_frames - 1) / (count - 1)
    return sorted({round(i * step) for i in range(count)})


# Le facteur d'agrandissement de l'incrustation de patch sur les PNG de
# contrôle. Au plus proche voisin, et non lissé : c'est le patch tel qu'il est
# stocké qu'on veut voir, pixel pour pixel, pas une version adoucie de lui.
PATCH_INSET_ZOOM = 4


def inset_position(rank: int, inset_size: int, frame_w: int, frame_h: int, margin: int = 8) -> tuple[int, int]:
    """Le coin (x, y du coin haut-gauche) où poser l'incrustation de patch du
    rang ``rank`` — un coin différent par rang, jusqu'à quatre, pour que
    plusieurs personnes ne se recouvrent pas. Le coin haut-gauche est en
    dernier : l'étiquette ``frame N t=...`` y vit déjà.
    """
    corners = [
        (frame_w - inset_size - margin, margin),  # haut-droit
        (frame_w - inset_size - margin, frame_h - inset_size - margin),  # bas-droit
        (margin, frame_h - inset_size - margin),  # bas-gauche
        (margin, margin + 28),  # haut-gauche, sous l'étiquette de frame
    ]
    return corners[rank % len(corners)]


def draw_debug_frame(
    frame_bgr: np.ndarray, entries: list[dict | None], frame_index: int, t: float, patch_size: int
) -> np.ndarray:
    """L'image annotée : boîte, points de tête et rectangle de ROI de bouche
    par personne, rang écrit à côté — et, pour chaque personne dont la région
    de bouche existe (``mouth`` vrai), une incrustation du patch ``patch_size
    x patch_size`` tel qu'il sera stocké, agrandi au plus proche voisin.

    **Le rectangle dit où on a visé, l'incrustation dit ce qu'on a attrapé.**
    Un rectangle décalé de dix pixels sur une image 960x540 ne saute pas aux
    yeux ; le même décalage, sur un patch agrandi ``x4``, est la différence
    entre une bouche et un menton. C'est cette incrustation qui a permis de
    diagnostiquer la première géométrie (carré nez-centré) comme fausse — le
    rectangle seul ne l'aurait pas montré aussi vite.
    """
    image = frame_bgr.copy()
    height, width = image.shape[:2]
    inset_size = patch_size * PATCH_INSET_ZOOM
    for rank, entry in enumerate(entries):
        if entry is None:
            continue
        color = DEBUG_COLORS[rank % len(DEBUG_COLORS)]
        x0, y0, x1, y1 = entry["box"]
        cv2.rectangle(image, (int(x0), int(y0)), (int(x1), int(y1)), color, 2)
        if entry["points"] is not None:
            for i in HEAD_POINT_INDICES:
                px, py, pc = entry["points"][i]
                if pc >= MIN_HEAD_POINT_CONF:
                    cv2.circle(image, (int(px), int(py)), 3, color, -1)
        if entry["roi"] is not None:
            rx0, ry0, rx1, ry1 = entry["roi"]
            cv2.rectangle(image, (int(rx0), int(ry0)), (int(rx1), int(ry1)), color, 1)
        label_y = max(0, int(y0) - 8)
        cv2.putText(
            image, f"#{rank}", (int(x0), label_y), cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2
        )
        if entry.get("patch") is not None:
            zoomed = cv2.resize(
                entry["patch"], (inset_size, inset_size), interpolation=cv2.INTER_NEAREST
            )
            zoomed_bgr = cv2.cvtColor(zoomed, cv2.COLOR_GRAY2BGR)
            ix, iy = inset_position(rank, inset_size, width, height)
            image[iy : iy + inset_size, ix : ix + inset_size] = zoomed_bgr
            cv2.rectangle(image, (ix, iy), (ix + inset_size, iy + inset_size), color, 2)
            cv2.putText(
                image,
                f"#{rank}",
                (ix, max(14, iy - 6)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.5,
                color,
                2,
            )
    cv2.putText(
        image,
        f"frame {frame_index}  t={t:.2f}s",
        (10, 22),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.6,
        (255, 255, 255),
        2,
    )
    return image


# Réglages de la bande de contrôle temporelle (`--strip`).
STRIP_PATCH_COUNT = 60  # patchs par ligne, répartis régulièrement sur l'intervalle
STRIP_ZOOM = 3  # agrandissement au plus proche voisin, plus modéré que l'incrustation
STRIP_SEPARATOR = 1  # filet noir, en pixels, entre deux patchs consécutifs d'une ligne
STRIP_ROW_GAP = 6  # fond noir, en pixels, entre deux lignes
STRIP_LABEL_WIDTH = 300  # colonne de texte à gauche de chaque ligne
# Magenta pur, choisi pour ne coïncider avec aucune des couleurs de rang
# (`DEBUG_COLORS`) ni avec un patch en niveaux de gris : un trou de `mouth`
# doit sauter aux yeux, pas se confondre avec un patch sombre.
STRIP_ABSENT_COLOR = (255, 0, 255)


def write_strip(
    path: str, t: np.ndarray, mouth: np.ndarray, patch: np.ndarray, patch_size: int
) -> int:
    """Écrit la bande de contrôle temporelle : une ligne par personne dont
    ``mouth`` est vrai au moins une fois, ``STRIP_PATCH_COUNT`` patchs
    répartis régulièrement sur tout l'intervalle, dans l'ordre du temps.
    Rend le nombre de lignes écrites (0 si aucune, et alors rien n'est écrit).

    **Pourquoi une bande plutôt que des vues pleines.** Les PNG de
    ``--dump-frames`` répondent à « la région tombe-t-elle sur la bouche à cet
    instant ». Ils ne disent rien de la **stabilité dans le temps** — la
    région reste-t-elle sur la bouche quand la tête bouge, la bouche
    s'ouvre-t-elle et se ferme-t-elle de façon visible, les deux rangs
    bougent-ils ensemble ou en alternance — et l'incrustation, sur une vue
    pleine, est minuscule. La bande met ces questions sur une seule image.

    **Un carré magenta uni, jamais un patch noir, marque une image sans
    bouche.** Un patch réel peut être sombre (bouche ouverte, éclairage bas) ;
    un carré noir se confondrait avec lui. Le magenta ne ressemble à aucun
    contenu vidéo plausible sur ce plateau.
    """
    total_frames = len(t)
    max_people = mouth.shape[1]
    active_ranks = [rank for rank in range(max_people) if mouth[:, rank].any()]
    if not active_ranks:
        return 0

    indices = dump_targets(total_frames, STRIP_PATCH_COUNT)
    cell = patch_size * STRIP_ZOOM
    strip_w = STRIP_LABEL_WIDTH + len(indices) * cell + max(len(indices) - 1, 0) * STRIP_SEPARATOR
    strip_h = len(active_ranks) * cell + max(len(active_ranks) - 1, 0) * STRIP_ROW_GAP
    image = np.zeros((strip_h, strip_w, 3), dtype=np.uint8)

    for row, rank in enumerate(active_ranks):
        y0 = row * (cell + STRIP_ROW_GAP)
        color = DEBUG_COLORS[rank % len(DEBUG_COLORS)]
        label = f"#{rank}  {t[indices[0]]:.2f}s -> {t[indices[-1]]:.2f}s"
        cv2.putText(
            image, label, (6, y0 + cell // 2 + 6), cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2
        )
        x = STRIP_LABEL_WIDTH
        for i, idx in enumerate(indices):
            if mouth[idx, rank]:
                zoomed = cv2.resize(patch[idx, rank], (cell, cell), interpolation=cv2.INTER_NEAREST)
                cell_bgr = cv2.cvtColor(zoomed, cv2.COLOR_GRAY2BGR)
            else:
                cell_bgr = np.full((cell, cell, 3), STRIP_ABSENT_COLOR, dtype=np.uint8)
            image[y0 : y0 + cell, x : x + cell] = cell_bgr
            x += cell
            if i < len(indices) - 1:
                x += STRIP_SEPARATOR

    output_dir = os.path.dirname(os.path.abspath(path))
    os.makedirs(output_dir, exist_ok=True)
    cv2.imwrite(path, image)
    return len(active_ranks)


# ---------------------------------------------------------------------------
# Ce qu'on refuse avant de commencer
# ---------------------------------------------------------------------------


def validate_args(a: argparse.Namespace) -> str | None:
    """Ce qui cloche dans les arguments, ou ``None`` si rien.

    Refuse plutôt que de retomber sur un défaut : un fichier qui montre un
    autre réglage que celui qu'il annonce est celui dont on tire une
    conclusion fausse — la règle est énoncée trois fois dans
    `scripts/framing-thumbnails.ts`, elle vaut ici de la même façon.
    """
    if not math.isfinite(a.start) or not math.isfinite(a.end):
        return f"--start et --end doivent être des nombres finis, reçu start={a.start!r} end={a.end!r}."
    if not a.end > a.start:
        return f"--end ({a.end}) doit être strictement supérieur à --start ({a.start})."
    if not math.isfinite(a.fps) or a.fps <= 0:
        return f"--fps doit être un nombre fini strictement positif, reçu {a.fps!r}."
    if not math.isfinite(a.conf) or not (0 < a.conf <= 1):
        return f"--conf doit être dans ]0, 1], reçu {a.conf!r}."
    if a.imgsz <= 0:
        return f"--imgsz doit être un entier strictement positif, reçu {a.imgsz!r}."
    if a.max_people < 1:
        return f"--max-people doit être un entier >= 1, reçu {a.max_people!r}."
    if a.patch < 8:
        return f"--patch doit être un entier >= 8, reçu {a.patch!r}."
    if a.dump_frames < 0:
        return f"--dump-frames doit être un entier >= 0, reçu {a.dump_frames!r}."
    if a.dump_frames > 0 and not a.dump_dir:
        return "--dump-frames exige --dump-dir."
    return None


# ---------------------------------------------------------------------------


def main() -> int:
    p = argparse.ArgumentParser(
        description="Extrait les patchs de bouche, les points de pose et l'enveloppe audio "
        "d'une fenêtre du proxy — matière brute pour la détection du locuteur."
    )
    p.add_argument("--proxy", required=True, help="le proxy du projet, à n'importe quelle échelle")
    p.add_argument("--start", type=float, required=True, help="début de la fenêtre, en secondes source")
    p.add_argument("--end", type=float, required=True, help="fin de la fenêtre, en secondes source")
    p.add_argument("--out", required=True, help="le .npz à écrire")
    p.add_argument("--audio", default=None, help="défaut : <dossier du proxy>/audio.wav")
    p.add_argument("--fps", type=float, default=30.0, help="images analysées par seconde")
    p.add_argument(
        "--model",
        default=os.environ.get("DETECT_MODEL") or os.path.join("worker", "models", "yolo11m-pose.pt"),
        help="les poids YOLO pose (DETECT_MODEL, ou worker/models/yolo11m-pose.pt)",
    )
    p.add_argument(
        "--ffmpeg",
        default=os.environ.get("FFMPEG_BIN") or "ffmpeg",
        help="le binaire ffmpeg (FFMPEG_BIN, ou ffmpeg)",
    )
    p.add_argument("--imgsz", type=int, default=960, help="la taille d'entrée du réseau")
    p.add_argument("--conf", type=float, default=0.25, help="le seuil de confiance YOLO")
    p.add_argument("--max-people", type=int, default=4, help="au plus combien de personnes par image")
    p.add_argument("--patch", type=int, default=32, help="le côté, en pixels, du patch de bouche")
    p.add_argument("--dump-frames", type=int, default=0, help="nombre de PNG de contrôle à écrire")
    p.add_argument("--dump-dir", default=None, help="dossier des PNG de contrôle")
    p.add_argument(
        "--strip",
        default=None,
        help="PNG de bande de contrôle temporelle (une ligne par personne, optionnel)",
    )
    a = p.parse_args()

    invalid = validate_args(a)
    if invalid is not None:
        journal(invalid)
        return 2

    if not os.path.isfile(a.proxy):
        journal(f"Proxy introuvable : {a.proxy}")
        return 2
    if not os.path.isfile(a.model):
        journal(f"Poids YOLO introuvables : {a.model}.")
        return 2

    audio_path = a.audio or os.path.join(os.path.dirname(os.path.abspath(a.proxy)), "audio.wav")
    if not os.path.isfile(audio_path):
        journal(f"Audio introuvable : {audio_path}")
        return 2

    départ = time.monotonic()

    # --- [1/7] CUDA, avant de payer quoi que ce soit d'autre --------------------
    # Importé ici et non en tête de fichier : ultralytics tire torch et pèse
    # plusieurs secondes. Un `--help` ou des arguments faux doivent répondre
    # tout de suite.
    import torch  # noqa: PLC0415
    from ultralytics import YOLO  # noqa: PLC0415

    if not torch.cuda.is_available():
        journal(
            "CUDA est demandé mais indisponible depuis ce venv. La détection tournerait "
            "des heures sur le processeur au lieu de quelques minutes : on refuse. "
            "Relancer ./setup.sh, qui vérifie CUDA par un vrai essai."
        )
        return 3

    # --- [2/7] l'audio, sans toucher au GPU -------------------------------------
    journal(f"[2/7] Enveloppe audio ({audio_path})…")
    try:
        audio_env = read_audio_envelope(audio_path, a.start, a.end)
    except (ValueError, wave.Error) as exc:
        journal(str(exc))
        return 2
    journal(f"      {len(audio_env)} fenêtres de 10 ms")

    # --- [3/7] le modèle ----------------------------------------------------------
    journal(f"[3/7] Chargement de {os.path.basename(a.model)} sur cuda…")
    model = YOLO(a.model)

    # --- [4/7] la fenêtre : pose et régions de bouche, par lots -------------------
    width, height = probe_size(a.proxy)
    expected_frames = max(1, round((a.end - a.start) * a.fps))
    journal(
        f"[4/7] Décodage et détection ({expected_frames} images attendues à {a.fps} im/s, "
        f"proxy {width}x{height}, entrée {a.imgsz}, seuil {a.conf})…"
    )
    targets = set(dump_targets(expected_frames, a.dump_frames))
    dump_saved: dict[int, tuple[np.ndarray, list[dict | None], float]] = {}

    t_list: list[float] = []
    present_list: list[list[bool]] = []
    mouth_list: list[list[bool]] = []
    patch_list: list[np.ndarray] = []
    roi_list: list[list[list[float]]] = []
    box_list: list[list[list[float]]] = []
    k_list: list[list[list[float]]] = []

    saw_pose = False
    frame_index = 0
    model_batch: list[np.ndarray] = []
    original_batch: list[np.ndarray] = []
    t0 = time.monotonic()
    last_report = t0

    def flush(model_batch: list[np.ndarray], original_batch: list[np.ndarray], start_index: int) -> int:
        nonlocal saw_pose
        if not model_batch:
            return 0
        results = model.predict(
            model_batch,
            imgsz=a.imgsz,
            conf=a.conf,
            classes=[PERSON_CLASS],
            device="cuda",
            quantize=16,
            verbose=False,
        )
        for offset, result in enumerate(results):
            idx = start_index + offset
            t = a.start + idx / a.fps
            original = original_batch[offset]

            boxes = result.boxes
            xyxy: list[tuple[float, float, float, float]] = []
            scores: list[float] = []
            poses = None
            if boxes is not None and len(boxes) > 0:
                xyxy = boxes.xyxy.tolist()
                scores = boxes.conf.tolist()
                keypoints = getattr(result, "keypoints", None)
                if keypoints is not None:
                    poses = keypoints.data.tolist()
                    saw_pose = True
            ranked = rank_detections(xyxy, scores, poses, a.max_people)

            # Deux drapeaux, pas un : `present` dit que ce rang est occupé par
            # une détection (boîte, points s'ils existent) ; `mouth` dit
            # qu'une région de bouche a en plus pu être posée. `mouth` implique
            # `present`, jamais l'inverse — voir l'en-tête du fichier.
            present_row = [False] * a.max_people
            mouth_row = [False] * a.max_people
            roi_row = [[math.nan] * 4 for _ in range(a.max_people)]
            box_row = [[math.nan] * 5 for _ in range(a.max_people)]
            k_row = [[math.nan] * 51 for _ in range(a.max_people)]
            patch_row = np.zeros((a.max_people, a.patch, a.patch), dtype=np.uint8)
            debug_entries: list[dict | None] = [None] * a.max_people

            for rank, det in enumerate(ranked):
                x0, y0, x1, y1 = det["box"]
                score = det["score"]
                points = det["points"]

                # Occupé dès qu'il y a une détection à ce rang, que la bouche
                # soit visable ou non : `box`/`k` ne dépendent que de ceci.
                present_row[rank] = True
                fx0 = min(max(x0 / width, 0.0), 1.0)
                fx1 = min(max(x1 / width, 0.0), 1.0)
                fy0 = min(max(y0 / height, 0.0), 1.0)
                fy1 = min(max(y1 / height, 0.0), 1.0)
                box_row[rank] = [fx0, fx1, fy0, fy1, floor_to(score, 3)]
                if points is not None:
                    k_row[rank] = flatten_pose_points(points, width, height)

                roi = mouth_roi(points)
                debug_entries[rank] = {"box": det["box"], "points": points, "roi": roi, "patch": None}
                if roi is None:
                    continue
                mouth_row[rank] = True
                rx0, ry0, rx1, ry1 = roi
                roi_row[rank] = [rx0 / width, ry0 / height, rx1 / width, ry1 / height]
                patch_row[rank] = crop_mouth_patch(original, roi, a.patch)
                debug_entries[rank]["patch"] = patch_row[rank].copy()

            t_list.append(t)
            present_list.append(present_row)
            mouth_list.append(mouth_row)
            roi_list.append(roi_row)
            box_list.append(box_row)
            k_list.append(k_row)
            patch_list.append(patch_row)

            if idx in targets and idx not in dump_saved:
                dump_saved[idx] = (original.copy(), debug_entries, t)
        return len(model_batch)

    for frame in decode_window(a.ffmpeg, a.proxy, a.start, a.end, a.fps, width, height):
        # Copie séparée pour le découpage des patchs : `model.predict` peut
        # écrire dans les tableaux qu'on lui donne quand il redimensionne sur
        # place (même mise en garde que `flux_images`), et un patch découpé
        # dans un tableau muté montrerait une image qui n'est plus la bonne.
        model_batch.append(frame)
        original_batch.append(frame.copy())
        if len(model_batch) >= MODEL_BATCH_SIZE:
            frame_index += flush(model_batch, original_batch, frame_index)
            model_batch = []
            original_batch = []
            now = time.monotonic()
            if now - last_report >= 5.0:
                last_report = now
                speed = frame_index / max(now - t0, 1e-9)
                journal(
                    f"      {frame_index}/{expected_frames} images "
                    f"({100 * frame_index / expected_frames:.0f} %), {speed:.0f} im/s"
                )
    frame_index += flush(model_batch, original_batch, frame_index)

    if not saw_pose:
        journal(
            "      Avertissement : aucun point de pose reçu sur toute la fenêtre — le modèle "
            "chargé n'est probablement pas une variante -pose. `mouth` (et `k`) resteront False/NaN "
            "partout, mais `present`/`box` restent renseignés dès qu'une personne est détectée."
        )

    journal(f"      {frame_index} images en {time.monotonic() - t0:.0f} s")

    del model
    try:
        import gc  # noqa: PLC0415

        gc.collect()
        torch.cuda.empty_cache()
    except Exception:  # noqa: BLE001 — libérer est une optimisation, pas un contrat
        pass

    # Construits une seule fois, réutilisés par la bande de contrôle et par
    # l'écriture du .npz — les deux lisent exactement la même matière.
    t_arr = np.array(t_list, dtype=np.float32)
    present_arr = np.array(present_list, dtype=bool)
    mouth_arr = np.array(mouth_list, dtype=bool)
    patch_arr = np.array(patch_list, dtype=np.uint8)
    roi_arr = np.array(roi_list, dtype=np.float32)
    box_arr = np.array(box_list, dtype=np.float32)
    k_arr = np.array(k_list, dtype=np.float32)

    # --- [5/7] les images de contrôle ---------------------------------------------
    if a.dump_frames > 0:
        journal(f"[5/7] Écriture de {len(dump_saved)}/{a.dump_frames} PNG de contrôle ({a.dump_dir})…")
        os.makedirs(a.dump_dir, exist_ok=True)
        if len(dump_saved) < a.dump_frames:
            journal(
                f"      Avertissement : {a.dump_frames - len(dump_saved)} cible(s) non atteinte(s) "
                "— la fenêtre décodée était plus courte que l'estimation."
            )
        for idx in sorted(dump_saved):
            frame, entries, t = dump_saved[idx]
            annotated = draw_debug_frame(frame, entries, idx, t, a.patch)
            out_path = os.path.join(a.dump_dir, f"{idx:05d}_t{t:.2f}.png")
            cv2.imwrite(out_path, annotated)
    else:
        journal("[5/7] Pas de PNG de contrôle demandé (--dump-frames 0).")

    # --- [6/7] la bande de contrôle temporelle -------------------------------------
    if a.strip:
        journal(f"[6/7] Bande de contrôle temporelle ({a.strip})…")
        rows = write_strip(a.strip, t_arr, mouth_arr, patch_arr, a.patch)
        if rows == 0:
            journal("      Aucun rang n'a jamais de bouche sur cette fenêtre : rien écrit.")
        else:
            journal(f"      {rows} ligne(s), {min(STRIP_PATCH_COUNT, frame_index)} patchs par ligne.")
    else:
        journal("[6/7] Pas de bande de contrôle demandée (--strip absent).")

    # --- [7/7] l'écriture ----------------------------------------------------------
    journal(f"[7/7] Écriture de {a.out}…")
    output_dir = os.path.dirname(a.out)
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)

    meta = {
        "proxy": os.path.abspath(a.proxy),
        "start": a.start,
        "end": a.end,
        "fps": a.fps,
        "patch": a.patch,
        "model": os.path.basename(a.model),
        "imgsz": a.imgsz,
        "conf": a.conf,
        "audio_rate": AUDIO_EXPECTED_RATE / AUDIO_WINDOW_SAMPLES,
        "audio_start": a.start,
        "version": SCRIPT_VERSION,
    }
    # Le fichier ouvert nous-mêmes, et non le chemin passé tel quel à
    # `savez_compressed` : numpy ajoute silencieusement `.npz` à un nom qui ne
    # l'a pas déjà, et `--out` désignerait alors un fichier différent de celui
    # qu'on annonce avoir écrit.
    with open(a.out, "wb") as f:
        np.savez_compressed(
            f,
            t=t_arr,
            present=present_arr,
            mouth=mouth_arr,
            patch=patch_arr,
            roi=roi_arr,
            box=box_arr,
            k=k_arr,
            audio_env=audio_env,
            meta=json.dumps(meta, ensure_ascii=False, allow_nan=False),
        )

    journal(
        f"Écrit {a.out} : {frame_index} images, {len(audio_env)} fenêtres audio, en "
        f"{time.monotonic() - départ:.0f} s."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
