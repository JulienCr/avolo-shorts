#!/usr/bin/env python3
"""Des patchs de bouche aux scalaires : quatre mesures d'activité par image et
par personne, écrites en JSON.

``worker/spike_mouth.py`` extrait la matière — des patchs 32x32, des points de
pose, une enveloppe audio — et la range dans un ``.npz`` qui pèse. Ce fichier-là
existe pour qu'on n'ait pas à le relire : **les décisions du spike se prennent
en TypeScript et sur des scalaires**, le ``.npz`` ne sert qu'à ré-analyser sans
repasser sur le GPU. C'est la même séparation que ``detect.py`` /
``src/core/framing.ts``, d'un cran plus bas.

**Quatre mesures, parce qu'on ne sait pas laquelle marche.** Aucune n'est
privilégiée ici : les départager est le travail de
``scripts/spike/speaker-probe.ts``, sur des chiffres, pas une intuition.

============  ==============================================================
``rawDiff``   moyenne de ``|patch[f] - patch[f-1]|``, en niveaux de gris bruts
``normDiff``  la même, chaque patch centré-réduit d'abord — insensible aux
              variations d'éclairage global, qui font bouger un patch entier
              sans qu'une bouche ait remué
``centerDiff``  ``normDiff`` restreinte au tiers central vertical du patch, là
              où sont les lèvres ; le haut porte le nez, le bas le menton
``noseShift``   le déplacement du point du nez entre deux images, en pixels
============  ==============================================================

**``noseShift`` n'est pas une mesure de bouche, c'est un témoin.** Une tête qui
bouge fait bouger tout ce qui est accroché dessus, patch de bouche compris. Si
le bruit de tête prédit la parole aussi bien que ``centerDiff``, alors la mesure
de bouche ne mesure pas la bouche — elle mesure que quelqu'un qui parle remue la
tête. Le témoin doit être calculé exactement comme les autres, et sur exactement
les mêmes images, sinon la comparaison ne vaut rien.

**Une mesure vaut ``null`` quand elle ne peut pas se calculer, jamais ``0``.**
Un zéro dit « pas de mouvement » ; ``null`` dit « je ne peux pas mesurer ». Les
confondre ferait dire au détecteur qu'une personne qu'on ne voit pas se tait —
la pire des deux erreurs, puisqu'elle est indiscernable d'une observation. C'est
la distinction que ``CLAUDE.md`` pose sous « Distinguer l'absence d'information
de son ambiguïté », et ``spike_mouth.py`` la tient déjà entre ``present`` et
``mouth``. Trois causes de ``null``, toutes traitées pareil :

1. la première image de la fenêtre — il n'y a pas d'image précédente ;
2. ``mouth`` faux à l'une des deux images — pas de région de bouche fiable, donc
   pas de différence qui veuille dire quelque chose ;
3. un patch d'écart-type nul (surface parfaitement uniforme) : le centrage-
   réduction n'est pas défini, ce qui ne touche que ``normDiff`` et
   ``centerDiff``.

**Les boîtes sont recopiées dans la sortie, et ce n'est pas de la redondance
paresseuse.** ``spike_mouth.py`` garde jusqu'à quatre détections par image,
rangées de gauche à droite, sans aucun suivi ; savoir *laquelle* est la personne
qui nous intéresse suppose les filtres de ``src/core/framing.ts``
(``minScore``, ``isForeground``), qui sont des réglages et vivent en TypeScript.
Sans les boîtes dans ce JSON, l'appelant devrait rouvrir le ``.npz`` pour
choisir un rang — c'est-à-dire faire exactement ce que ce fichier existe pour
éviter.

Usage ::

    python worker/spike_activity.py --npz <fichier.npz> --out <fichier.json> \\
        --proxy-size 960x540

``--proxy-size`` est obligatoire : les points de pose du ``.npz`` sont en
fractions du proxy, ``noseShift`` se rend en pixels, et le ``.npz`` ne porte pas
les dimensions. Les deviner depuis le chemin du proxy inscrit dans ``meta``
marcherait aujourd'hui et se romprait le jour où le fichier bouge ;
``analysis.json`` porte déjà ``proxy: {w, h}``, l'appelant n'a qu'à le passer.
"""

import argparse
import json
import math
import os
import sys

import numpy as np

SCRIPT_VERSION = 1

# En deçà de cet écart-type (en niveaux de gris), un patch est trop uniforme
# pour être centré-réduit : la division amplifierait du bruit de quantification
# en un signal de plusieurs unités.
MIN_PATCH_STD = 1e-3

# Le nombre de décimales gardées dans le JSON. Les quatre mesures vivent dans
# des unités différentes (niveaux de gris, écarts-types, pixels), et quatre
# décimales sont sans effet sur un rang comme sur une corrélation tout en
# divisant la taille du fichier par deux.
DECIMALS = 4


def journal(message: str) -> None:
    """Sur stderr, jamais stdout — même discipline que `worker/detect.py`."""
    print(message, file=sys.stderr, flush=True)


def parse_size(text: str) -> tuple[int, int]:
    """`960x540` en `(960, 540)`. Lève sur tout le reste."""
    parts = text.lower().split("x")
    if len(parts) != 2:
        raise ValueError(f"--proxy-size attend la forme LARGEURxHAUTEUR, reçu {text!r}.")
    width, height = int(parts[0]), int(parts[1])
    if width <= 0 or height <= 0:
        raise ValueError(f"--proxy-size doit être strictement positif, reçu {text!r}.")
    return width, height


def rounded(value: float) -> float | None:
    """`DECIMALS` décimales, ou `None` si la valeur n'est pas finie.

    Un `NaN` qui traverserait `json.dump` sortirait en `NaN` nu, que JSON
    n'admet pas et qu'aucun analyseur TypeScript ne relira. Il n'y a de toute
    façon qu'une seule façon honnête d'écrire « pas de valeur » ici.
    """
    if not math.isfinite(value):
        return None
    return round(float(value), DECIMALS)


def mean_abs_diff(current: np.ndarray, previous: np.ndarray) -> float:
    """La moyenne des écarts absolus entre deux tableaux de même forme."""
    return float(np.mean(np.abs(current - previous)))


def activity_of_rank(
    patch: np.ndarray,
    mouth: np.ndarray,
    points: np.ndarray,
    proxy_w: int,
    proxy_h: int,
) -> dict[str, list[float | None]]:
    """Les quatre mesures d'un rang, sur toute la fenêtre.

    ``patch`` est ``(frames, size, size)`` en uint8, ``mouth`` ``(frames,)`` en
    booléens, ``points`` ``(frames, 51)`` — les dix-sept points COCO en
    fractions, ``x, y, confiance`` mis bout à bout, tels que
    ``flatten_keypoints`` les écrit.

    **Le centrage-réduction se fait sur le patch entier, y compris pour
    ``centerDiff``.** Réduire d'abord au tiers central puis normaliser
    donnerait une mesure qui dépend du contraste *du tiers*, donc qui monte
    quand la bouche s'ouvre sur du noir — un artefact qui ressemblerait
    exactement au signal cherché. La restriction porte sur les pixels comparés,
    pas sur la statistique qui les met à l'échelle.
    """
    frames, size = patch.shape[0], patch.shape[1]
    flat = patch.reshape(frames, -1).astype(np.float32)
    mean = flat.mean(axis=1, keepdims=True)
    std = flat.std(axis=1, keepdims=True)
    normalizable = std[:, 0] > MIN_PATCH_STD
    # `np.where` sur le diviseur plutôt qu'un masque : les lignes non
    # normalisables sont écartées par `normalizable` juste après, et diviser par
    # 1 leur évite d'empoisonner le tableau d'infinis au passage.
    normalized = (flat - mean) / np.where(std > MIN_PATCH_STD, std, 1.0)
    normalized = normalized.reshape(frames, size, size)

    # Le tiers central vertical : `size // 3` lignes écartées en haut, autant en
    # bas. Sur 32, ça garde les lignes 10 à 21 incluses, soit douze lignes.
    band = size // 3
    low, high = band, size - band

    nose_x = points[:, 0] * proxy_w
    nose_y = points[:, 1] * proxy_h

    raw_diff: list[float | None] = [None] * frames
    norm_diff: list[float | None] = [None] * frames
    center_diff: list[float | None] = [None] * frames
    nose_shift: list[float | None] = [None] * frames

    for f in range(1, frames):
        # La première des trois causes de `null` est déjà couverte par le `range`
        # qui part de 1 ; voici la deuxième.
        if not (mouth[f] and mouth[f - 1]):
            continue
        raw_diff[f] = rounded(mean_abs_diff(flat[f], flat[f - 1]))
        shift = math.hypot(nose_x[f] - nose_x[f - 1], nose_y[f] - nose_y[f - 1])
        nose_shift[f] = rounded(shift)
        # La troisième cause de `null`, qui ne touche que les deux mesures
        # normalisées : `rawDiff` et `noseShift` ci-dessus restent mesurables sur
        # un patch uniforme.
        if not (normalizable[f] and normalizable[f - 1]):
            continue
        norm_diff[f] = rounded(mean_abs_diff(normalized[f], normalized[f - 1]))
        center_diff[f] = rounded(
            mean_abs_diff(normalized[f, low:high, :], normalized[f - 1, low:high, :])
        )

    return {
        "rawDiff": raw_diff,
        "normDiff": norm_diff,
        "centerDiff": center_diff,
        "noseShift": nose_shift,
    }


def resample_envelope(
    audio_env: np.ndarray, t: np.ndarray, audio_start: float, audio_rate: float, fps: float
) -> list[float | None]:
    """L'enveloppe audio, de sa cadence propre (100 Hz) à celle de la vidéo.

    **Une moyenne centrée sur l'étiquette de temps de l'image, pas la fenêtre
    la plus proche.** À 30 im/s, une image couvre 3,3 fenêtres audio : n'en
    garder qu'une jetterait les deux tiers du signal et ajouterait du bruit de
    quantification à une grandeur dont la recherche de décalage va scruter des
    déplacements d'une image. Et centrée sur ``t[f]`` plutôt que sur
    ``[t[f], t[f+1])`` : une moyenne en avant décalerait toute l'enveloppe d'une
    demi-image vers le passé, ce qui biaiserait précisément la recherche de
    décalage qu'elle sert à alimenter.

    ``None`` là où aucune fenêtre audio ne couvre l'image — la fin de
    l'intervalle, quand l'audio s'arrête avant la dernière image décodée.
    """
    half = 0.5 / fps
    total = len(audio_env)
    out: list[float | None] = []
    for value in t:
        relative = float(value) - audio_start
        first = math.floor((relative - half) * audio_rate)
        last = math.ceil((relative + half) * audio_rate)
        first = max(first, 0)
        last = min(last, total)
        if last <= first:
            out.append(None)
            continue
        out.append(rounded(float(np.mean(audio_env[first:last]))))
    return out


def main() -> int:
    p = argparse.ArgumentParser(
        description="Réduit un .npz de patchs de bouche à quatre mesures d'activité "
        "scalaires par image et par personne, en JSON."
    )
    p.add_argument("--npz", required=True, help="le .npz écrit par spike_mouth.py")
    p.add_argument("--out", required=True, help="le JSON à écrire")
    p.add_argument(
        "--proxy-size",
        required=True,
        help="LARGEURxHAUTEUR du proxy — noseShift se rend en pixels, le .npz "
        "ne porte que des fractions (analysis.json porte proxy: {w, h})",
    )
    a = p.parse_args()

    if not os.path.isfile(a.npz):
        journal(f"Fichier introuvable : {a.npz}")
        return 2
    try:
        proxy_w, proxy_h = parse_size(a.proxy_size)
    except ValueError as exc:
        journal(str(exc))
        return 2

    with np.load(a.npz) as data:
        t = data["t"]
        present = data["present"]
        mouth = data["mouth"]
        patch = data["patch"]
        box = data["box"]
        keypoints = data["k"]
        audio_env = data["audio_env"]
        meta = json.loads(str(data["meta"]))

    frames, people = mouth.shape
    fps = float(meta["fps"])
    audio_rate = float(meta["audio_rate"])
    audio_start = float(meta["audio_start"])

    persons = []
    for rank in range(people):
        activity = activity_of_rank(
            patch[:, rank], mouth[:, rank], keypoints[:, rank], proxy_w, proxy_h
        )
        # `box` porte `[x0, x1, y0, y1, score]` en fractions — l'ordre de
        # `spike_mouth.py`, qui n'est pas celui de `PersonBox` ; le JSON le
        # nomme champ par champ pour que personne n'ait à s'en souvenir.
        boxes: list[dict[str, float] | None] = []
        for f in range(frames):
            if not present[f, rank]:
                boxes.append(None)
                continue
            x0, x1, y0, y1, score = (float(v) for v in box[f, rank])
            boxes.append(
                {
                    "x0": rounded(x0),
                    "x1": rounded(x1),
                    "y0": rounded(y0),
                    "y1": rounded(y1),
                    "score": rounded(score),
                }
            )
        persons.append(
            {
                "present": [bool(v) for v in present[:, rank]],
                "mouth": [bool(v) for v in mouth[:, rank]],
                "box": boxes,
                **activity,
            }
        )

    payload = {
        "version": SCRIPT_VERSION,
        "meta": meta,
        "proxy": {"w": proxy_w, "h": proxy_h},
        "frames": int(frames),
        "people": int(people),
        "t": [rounded(float(v)) for v in t],
        "audioEnv": resample_envelope(audio_env, t, audio_start, audio_rate, fps),
        "person": persons,
    }

    output_dir = os.path.dirname(os.path.abspath(a.out))
    os.makedirs(output_dir, exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as f:
        # `allow_nan=False` : un NaN qui aurait échappé à `rounded` doit faire
        # échouer l'écriture, pas produire un JSON que personne ne relit.
        json.dump(payload, f, ensure_ascii=False, allow_nan=False, separators=(",", ":"))

    measured = sum(
        1 for person in persons for value in person["centerDiff"] if value is not None
    )
    journal(
        f"Écrit {a.out} : {frames} images x {people} rangs, {measured} mesures centerDiff "
        f"non nulles ({os.path.getsize(a.out) / 1024:.0f} Kio)."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
