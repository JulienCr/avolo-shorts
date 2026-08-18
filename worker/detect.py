#!/usr/bin/env python3
"""Les corps et les frontières de plans, sur le proxy 960x540.

Ce que produit ce script est ce que le cadrage automatique consomme : où sont
les gens, et où sont les coupes. Rien d'autre. Le choix du ratio, la position du
crop et le percentile 90 sont des fonctions pures et vivent dans
``src/core/framing.ts`` et ``src/core/shots.ts``.

**On détecte des corps, pas des visages**, et ce n'est pas un détail
d'implémentation. La spec §2 l'a mesuré sur trois émissions : les comédiens
jouent debout, face à face, **de profil**, et un détecteur de visages rate le
profil — d'où les 5 à 30 % d'images sans aucune détection que MediaPipe rendait.
YOLO classe *person* tient le profil, le dos, et les corps partiellement cachés.

**Deux passes, un seul fichier.** Les frontières de plans et les boîtes décrivent
le même proxy et atterrissent dans le même ``analysis.json`` : les séparer
donnerait deux flux d'avancement et une fusion dont personne n'est propriétaire.
La première passe est du pur ffmpeg et ne touche pas au GPU ; elle passe donc
**avant** le chargement du modèle, ce qui raccourcit d'une minute le temps
pendant lequel la VRAM est occupée.

**Les frontières viennent du score de scène de ffmpeg**, pas d'une bibliothèque
de plus : le binaire est déjà installé et éprouvé par ``setup.sh``.

Le patron est celui de ``worker/transcribe.py``, et il est suivi de près :

- un script en ligne de commande, pas un service ;
- l'avancement sur **stderr**, en ``[n/4]``, lu par ``avancementWorker()``
  (``src/core/pipeline.ts``) ;
- les imports lourds **dans** ``main()``, pour qu'un ``--help`` réponde tout de
  suite au lieu de payer dix secondes de torch ;
- l'environnement du sous-processus construit par Node depuis une liste blanche,
  jamais hérité (voir ``src/server/steps/analysis.ts``).

Sortie : la forme fixée par le contrat de l'itération 1, en **fractions** de la
largeur et de la hauteur — jamais en pixels. La détection tourne sur le proxy et
le rendu croppe l'original ; des pixels obligeraient chaque appelant à savoir de
quelle image ils viennent.
"""

import argparse
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import time

# La classe *person* du jeu COCO, sur lequel tous les modèles YOLO livrés sont
# entraînés. C'est la seule qui nous intéresse, et la passer à `predict` évite
# de payer la suppression des non-maxima sur les 79 autres.
CLASSE_PERSONNE = 0


def journal(message: str) -> None:
    """Sur stderr, jamais stdout.

    Node lit stderr pour son journal et pour l'avancement ; stdout est réservé au
    cas où une version ultérieure y écrirait le résultat.
    """
    print(message, file=sys.stderr, flush=True)


def taille(valeur: str) -> tuple[int, int]:
    """``960x540`` → ``(960, 540)``. Le format que Node écrit."""
    m = re.fullmatch(r"(\d+)x(\d+)", valeur.strip())
    if m is None:
        raise argparse.ArgumentTypeError(f"attendu LARGEURxHAUTEUR, reçu {valeur!r}")
    return int(m.group(1)), int(m.group(2))


def arrondi_vers_le_bas(valeur: float, décimales: int) -> float:
    """Tronque vers le bas, jamais vers le haut.

    **Un arrondi au plus proche fait franchir un seuil inclusif.**
    ``src/core/framing.ts`` ne garde que les boîtes dont le score atteint 0,5 ;
    une détection à 0,4996 ressortait à ``0.5`` et passait le filtre, alors
    qu'elle était dessous. Le seuil ne valait plus ce qu'il annonçait, et rien ne
    pouvait le montrer : ni le fichier, où 0,5 est un score parfaitement ordinaire,
    ni le cadrage, ni l'image.

    L'arrondi lui-même n'est pas en cause — il tient la taille du fichier, trente
    mille boîtes sur une émission, et sa lisibilité. C'est son **sens** qui
    l'était. Vers le bas, la valeur écrite minore la vraie : un seuil inclusif
    posé sur un multiple du millième dit alors exactement ce qu'il dit, et le
    format ne bouge pas d'une virgule — un ``analysis.json`` déjà sur le disque
    se relit sans rien savoir de ce changement.

    Le résidu est un *ulp*, pas un millième : sur les 1001 multiples du millième,
    quinze ont un voisin inférieur que ``valeur * 1000`` remonte à l'entier, d'au
    plus 1,1e-16. Aucun n'est 0,5, et aucun écart de cet ordre ne ressemble à la
    panne qu'on ferme, qui valait 4e-4.
    """
    facteur = 10**décimales
    return math.floor(valeur * facteur) / facteur


# ---------------------------------------------------------------------------
# Les frontières de plans
# ---------------------------------------------------------------------------

# Ce que `metadata=print` écrit, deux lignes par image retenue :
#
#     frame:0    pts:1224192 pts_time:79.7
#     lavfi.scene_score=0.529416
#
# On lit le couple, pas la ligne : le nom de la clé change selon le filtre qui
# l'a posée, et l'horodatage est sur la ligne d'avant.
COUPLE_SCÈNE = re.compile(r"pts_time:([0-9.]+)\s*\nlavfi\.scene_score=([0-9.]+)")


def scores_de_scène(ffmpeg: str, proxy: str, plancher: float) -> list[tuple[float, float]]:
    """Les images dont le score de scène dépasse ``plancher``, avec leur score.

    Le filtre ``select`` compare chaque image à **celle qui la précède en
    entrée**, pas à la précédente retenue : le plancher ne fausse donc pas les
    scores, il ne fait que taire les images sans intérêt. On le pose bas et on
    décide du vrai seuil en Python, ce qui laisse la distribution mesurable sans
    repasser sur deux heures de vidéo.

    ``-f null -`` jette les images ; seul le ``metadata=print:file=-`` écrit, et
    il écrit sur stdout.
    """
    args = [
        ffmpeg,
        "-hide_banner",
        "-nostdin",
        "-loglevel", "error",
        "-i", proxy,
        # Ni son ni sous-titres : le muxeur null les accepterait, les décoder
        # serait du travail pour rien.
        "-an", "-sn",
        "-vf", f"select='gt(scene,{plancher})',metadata=print:file=-",
        "-f", "null", "-",
    ]
    terminé = subprocess.run(args, capture_output=True, text=True, check=False)
    if terminé.returncode != 0:
        queue = "\n".join(terminé.stderr.strip().splitlines()[-20:])
        raise RuntimeError(
            f"ffmpeg a échoué sur la détection de plans (code {terminé.returncode}).\n"
            f"Commande : {' '.join(args)}\n"
            f"Dernières lignes :\n{queue or '(stderr vide)'}"
        )
    return [(float(t), float(s)) for t, s in COUPLE_SCÈNE.findall(terminé.stdout)]


def plans(
    évènements: list[tuple[float, float]], durée: float, seuil: float, plan_min: float
) -> list[dict[str, float]]:
    """Découpe ``[0, durée]`` aux instants dont le score dépasse ``seuil``.

    Deux garde-fous, et le second est le seul qui ait coûté quelque chose :

    - une frontière hors de l'intervalle est ignorée. Le score de la toute
      première image se compare à rien ;
    - **deux frontières trop rapprochées n'en font qu'une.** Un éclair de lumière
      produit deux images de score élevé à une image d'intervalle, donc un
      « plan » de 33 millisecondes dans lequel le cadrage n'a rien à calculer.

    **Les deux bouts comptent comme des frontières.** ``plan_min`` se mesure
    depuis 0 pour la première et jusqu'à ``durée`` pour la dernière : sans cela
    une coupe à une demi-seconde du début, ou de la fin, produit un plan plus
    court que le minimum annoncé — le cas exact que le garde-fou est censé
    fermer, à l'endroit où il ne regardait pas.

    Rend toujours au moins un plan : une émission sans aucune coupe est un plan
    unique, pas une liste vide, et le cadrage n'a pas à distinguer les deux cas.
    """
    frontières: list[float] = []
    for t, score in sorted(évènements):
        if score < seuil or t <= 0 or t >= durée:
            continue
        # 0 quand la liste est vide : le début de la vidéo est une frontière
        # comme une autre du point de vue de la durée d'un plan.
        précédente = frontières[-1] if frontières else 0.0
        if t - précédente < plan_min:
            continue
        frontières.append(t)

    # Un seul retrait suffit : la frontière qui devient dernière est à au moins
    # ``plan_min`` de celle qu'on vient d'ôter, donc à plus de ``plan_min`` de la
    # fin.
    if frontières and durée - frontières[-1] < plan_min:
        frontières.pop()

    bornes = [0.0, *frontières, durée]
    return [
        {"start": round(a, 3), "end": round(b, 3)} for a, b in zip(bornes, bornes[1:])
    ]


# ---------------------------------------------------------------------------
# Les corps
# ---------------------------------------------------------------------------


def flux_images(ffmpeg: str, proxy: str, fps: float, largeur: int, hauteur: int):
    """Décode le proxy à ``fps`` images par seconde, en BGR brut sur un tube.

    ffmpeg plutôt qu'OpenCV pour lire la vidéo : le binaire est déjà là, et un
    ``VideoCapture`` qui saute d'image en image paie un ``seek`` par image, ce
    qui est plus lent que de tout décoder une fois.

    **BGR et non RGB** : ultralytics suit la convention d'OpenCV pour les
    tableaux numpy. Une inversion des canaux ne fait pas échouer la détection,
    elle la dégrade — le pire des symptômes, parce qu'il ressemble à un mauvais
    modèle.

    Le filtre ``fps`` rééchantillonne à cadence constante depuis le début, si
    bien que l'image *i* est à ``i / fps`` seconde dans la source. Le proxy n'est
    ni découpé ni décalé par rapport à l'original (voir ``proxyArgs``), donc
    c'est aussi l'instant dans la source.
    """
    import numpy as np  # noqa: PLC0415

    octets = largeur * hauteur * 3
    args = [
        ffmpeg,
        "-hide_banner",
        "-nostdin",
        "-loglevel", "error",
        "-i", proxy,
        "-an", "-sn",
        "-vf", f"fps={fps}",
        "-f", "rawvideo",
        "-pix_fmt", "bgr24",
        "-",
    ]
    # **stderr dans un fichier, pas dans un tube**, et c'est le seul point de ce
    # décodage qui puisse bloquer pour de bon. Un tube a une capacité de 64 ko :
    # un ffmpeg qui la remplit — il faut une erreur par image, mais ça existe —
    # se bloque en écriture, cesse donc d'écrire sur stdout, pendant que le
    # parent se bloque dans `read()` en attendant précisément ces octets. Deux
    # processus qui s'attendent, sans un mot et sans fin. Vider stderr dans le
    # `finally` ne l'évite pas : on n'y arrive jamais. Un fichier temporaire n'a
    # pas de capacité, donc pas d'interblocage, et se relit après la sortie.
    # `TemporaryFile` n'a pas de nom sur le disque et s'efface à la fermeture.
    # `with` sur le fichier, et non un `close()` dans le `finally` : un
    # `Popen` qui échoue — binaire absent, plus de processus — laisserait sinon
    # un descripteur ouvert dans une trame que la trace d'erreur maintient en vie.
    with tempfile.TemporaryFile() as journal_erreur:
        proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=journal_erreur)
        try:
            while True:
                brut = proc.stdout.read(octets)
                if len(brut) < octets:
                    # **Un reste non nul dit que la géométrie annoncée est
                    # fausse.** Node lit les dimensions du proxy avec ffprobe et
                    # les passe ici ; si elles ne correspondaient pas, chaque
                    # image serait cisaillée et la détection rendrait des boîtes
                    # plausibles mais décalées. Un décalage silencieux vaut moins
                    # qu'un échec.
                    if brut:
                        raise RuntimeError(
                            f"Flux tronqué : {len(brut)} octets de reste pour des images de "
                            f"{octets} ({largeur}x{hauteur}x3). Les dimensions passées ne sont "
                            f"pas celles du proxy."
                        )
                    break
                # `copy()` : `frombuffer` rend un tableau en lecture seule, et
                # ultralytics écrit dans celui qu'on lui donne quand il
                # redimensionne sur place.
                yield np.frombuffer(brut, dtype=np.uint8).reshape(hauteur, largeur, 3).copy()
        finally:
            # Fermer le tube fait recevoir un SIGPIPE à ffmpeg s'il écrit encore :
            # c'est ce qui met fin au décodage quand on sort de la boucle en avance.
            if proc.stdout is not None:
                proc.stdout.close()
            code = proc.wait()
            # Après `wait()` : le fichier est complet, et personne n'écrit plus
            # dedans.
            journal_erreur.seek(0)
            erreur = journal_erreur.read().decode("utf-8", "replace")
            # Le code 0 est le cas nominal ; un tube fermé en avance donne 141
            # (128 + SIGPIPE), qui n'est pas une erreur de décodage.
            if code not in (0, 141, -13):
                queue = "\n".join(erreur.strip().splitlines()[-20:])
                raise RuntimeError(
                    f"ffmpeg a échoué en décodant le proxy (code {code}).\n"
                    f"Commande : {' '.join(args)}\n"
                    f"Dernières lignes :\n{queue or '(stderr vide)'}"
                )


def boîtes_du_lot(résultats, indice_départ: int, fps: float, largeur: int, hauteur: int):
    """Les boîtes d'un lot d'images, **en fractions** de largeur et de hauteur.

    Les fractions plutôt que les pixels sont la décision qui compte : la
    détection tourne sur le proxy 960x540 et le rendu croppe l'original
    1920x1080. Des pixels obligeraient chaque consommateur à savoir de quelle
    image ils viennent, et la première conversion oubliée passerait une boîte à
    la moitié de sa taille sans que rien ne le signale.

    Quatre décimales suffisent : au 1/10000 d'une largeur de 1920, l'erreur vaut
    un cinquième de pixel sur l'original.
    """
    sorties = []
    for décalage, résultat in enumerate(résultats):
        instant = round((indice_départ + décalage) / fps, 3)
        boîtes = résultat.boxes
        if boîtes is None:
            continue
        # `.tolist()` une fois par lot plutôt qu'un accès par boîte : chaque
        # lecture d'un tenseur CUDA est une synchronisation avec le GPU.
        coordonnées = boîtes.xyxy.tolist()
        confiances = boîtes.conf.tolist()
        for (x0, y0, x1, y1), score in zip(coordonnées, confiances):
            # Les coordonnées sont bornées à l'image : YOLO rend volontiers une
            # boîte qui déborde de quelques pixels quand le sujet est coupé par
            # le bord, et une fraction hors de [0, 1] ferait sortir le crop du
            # cadre.
            fx0 = round(min(max(x0 / largeur, 0.0), 1.0), 4)
            fx1 = round(min(max(x1 / largeur, 0.0), 1.0), 4)
            fy0 = round(min(max(y0 / hauteur, 0.0), 1.0), 4)
            fy1 = round(min(max(y1 / hauteur, 0.0), 1.0), 4)
            # **Une boîte d'aire nulle ne se transmet pas.** Le bornage ci-dessus
            # écrase sur un même bord une boîte entièrement hors cadre, et
            # l'arrondi au dix-millième en écrase une plus fine qu'un cinquième
            # de pixel. Ce qui en sort a la forme d'une détection et n'a plus de
            # sujet : le percentile 90 du cadrage la compterait comme une
            # personne de largeur nulle et refermerait le crop d'autant.
            if fx1 <= fx0 or fy1 <= fy0:
                continue
            sorties.append(
                {
                    "t": instant,
                    "x0": fx0,
                    "x1": fx1,
                    "y0": fy0,
                    "y1": fy1,
                    # Vers le bas et non au plus proche : le seuil de
                    # `framing.ts` est inclusif, et 0,4996 y devenait 0,5.
                    "score": arrondi_vers_le_bas(score, 3),
                }
            )
    return sorties


# ---------------------------------------------------------------------------
# Ce qu'on refuse avant de commencer
# ---------------------------------------------------------------------------


def refus_du_seuil_de_scène(seuil: float, plancher: float) -> str | None:
    """Ce qui cloche dans le couple seuil/plancher, ou ``None`` si rien.

    Les frontières se décident en deux temps : ffmpeg ne rapporte que les images
    au-dessus du **plancher de collecte**, et ``plans()`` applique ensuite le
    **seuil** demandé. Un seuil sous le plancher portait donc sur des candidates
    qui n'avaient jamais été collectées : l'argument était accepté, et il ne
    faisait rien. Personne ne le rencontre au seuil retenu — 0,4, huit fois le
    plancher —, et tout le monde le rencontrera le jour où l'on cherchera des
    coupes plus discrètes, c'est-à-dire en itérant sur ce détecteur.

    **Un refus et non un ``min()`` qui abaisserait le plancher tout seul.** Le
    ``min()`` reproduirait le défaut un cran plus bas : à plancher nul,
    ``gt(scene, 0)`` retient à peu près chaque image d'une émission de deux
    heures, et ``scores_de_scène`` ramasse cette sortie en mémoire d'un seul
    tenant. Le refus nomme les deux valeurs et laisse le choix — baisser le
    plancher aussi — à qui sait ce qu'il cherche.

    **Les deux nombres sont jugés, pas seulement le seuil.** Valider l'un et pas
    l'autre laissait le danger accessible par la porte d'à côté : c'est
    ``--scene-floor 0`` qui déclenche la collecte totale invoquée ci-dessus.
    Et ``NaN`` passe *toutes* les comparaisons, donc passait ce refus — puis
    ``plans()``, qui n'écarte que ``score < seuil`` : chaque candidate collectée
    serait devenue une frontière. ``argparse`` prend ``nan`` et ``inf`` sans
    broncher. (relevé par Copilot sur la PR #44)

    **L'égalité est refusée, contrairement à ce que cette docstring affirmait.**
    La collecte est stricte — ``gt(scene, plancher)`` — et la rétention est
    inclusive — ``plans()`` garde ``score >= seuil``. À valeurs égales, une image
    dont le score vaut exactement le plancher serait gardée par la seconde et
    n'est jamais rapportée par la première : elle disparaît sans un mot, ce qui
    est le défaut même qu'on ferme ici. Strictement au-dessus, l'inclusion est
    vraie : ``score >= seuil > plancher`` implique ``score > plancher``.
    (relevé par Copilot et par Codex sur la PR #44)
    """
    for nom, valeur in (("--scene-threshold", seuil), ("--scene-floor", plancher)):
        # `math.isfinite` et non `!= valeur` : il attrape `nan` et les deux
        # infinis d'un seul contrôle, et il se lit.
        if not math.isfinite(valeur):
            return (
                f"{nom} vaut {valeur}, qui n'est pas un nombre fini. NaN passe toutes les "
                "comparaisons sans en satisfaire aucune : le seuil ne serait jamais appliqué, "
                "et chaque candidate collectée deviendrait une frontière."
            )
        if valeur <= 0:
            return (
                f"{nom} vaut {valeur}, et ni zéro ni un négatif ne veulent dire quelque chose "
                "ici : le score de scène de ffmpeg vit dans [0, 1]. À zéro, la collecte retient "
                "à peu près chaque image d'une émission de deux heures, ramassée en mémoire "
                "d'un seul tenant. 0,4 sur un plancher de 0,05 sont les valeurs mesurées."
            )
    if seuil <= plancher:
        return (
            f"--scene-threshold ({seuil}) n'est pas strictement au-dessus de --scene-floor "
            f"({plancher}) : la collecte est stricte, donc aucune image de score inférieur ou "
            f"égal à {plancher} n'est rapportée, et ce seuil-là ne serait jamais appliqué "
            "entièrement. Baisser --scene-floor si des coupes plus discrètes sont recherchées "
            "— au prix d'une passe ffmpeg plus bavarde."
        )
    return None


# ---------------------------------------------------------------------------


def main() -> int:
    p = argparse.ArgumentParser(
        description="Détecte les corps et les frontières de plans sur un proxy."
    )
    p.add_argument("--proxy", required=True, help="le proxy 960x540 à 30 im/s")
    p.add_argument("--out", required=True, help="le JSON à écrire")
    p.add_argument("--ffmpeg", required=True, help="le binaire de setup.sh (FFMPEG_BIN)")
    p.add_argument("--model", required=True, help="les poids YOLO, posés par setup.sh")
    p.add_argument(
        "--proxy-size",
        required=True,
        type=taille,
        help="LARGEURxHAUTEUR du proxy, relevé par Node avec ffprobe",
    )
    p.add_argument(
        "--source-size",
        required=True,
        type=taille,
        help="LARGEURxHAUTEUR de l'original — recopié tel quel dans le résultat",
    )
    p.add_argument("--duration", required=True, type=float, help="la durée du proxy, en secondes")
    p.add_argument("--fps", type=float, default=2.0, help="images analysées par seconde (spec §6)")
    p.add_argument("--imgsz", type=int, default=960, help="la taille d'entrée du réseau")
    # **Volontairement plus bas que le seuil du consommateur.** `src/core/framing.ts`
    # ne garde que les boîtes à 0,5 ou plus, le seuil des mesures de la spec §2.
    # Couper à 0,5 ici ferait de ce choix une propriété du fichier : le remonter
    # ou le baisser coûterait alors une analyse de plusieurs minutes, pour des
    # boîtes que le GPU avait déjà trouvées. On écrit tout ce qu'on voit, le
    # cadrage décide de ce qu'il en fait.
    p.add_argument("--conf", type=float, default=0.25, help="le seuil de confiance")
    p.add_argument("--batch", type=int, default=32, help="images par passe GPU")
    p.add_argument("--device", default="cuda")
    p.add_argument(
        "--scene-threshold",
        type=float,
        default=0.4,
        help="le score de scène au-delà duquel on déclare une coupe",
    )
    p.add_argument(
        "--scene-floor",
        type=float,
        default=0.05,
        help="le plancher de collecte : ffmpeg ne rapporte rien à ce score ni en dessous",
    )
    p.add_argument(
        "--min-shot", type=float, default=1.0, help="durée minimale d'un plan, en secondes"
    )
    a = p.parse_args()

    if not os.path.isfile(a.proxy):
        journal(f"Proxy introuvable : {a.proxy}")
        return 2
    if not os.path.isfile(a.model):
        journal(f"Poids YOLO introuvables : {a.model}. Lancer ./setup.sh.")
        return 2
    if a.duration <= 0:
        journal(f"Durée invalide : {a.duration}. Elle est relevée par ffprobe côté Node.")
        return 2
    refus = refus_du_seuil_de_scène(a.scene_threshold, a.scene_floor)
    if refus is not None:
        journal(refus)
        return 2

    largeur, hauteur = a.proxy_size
    # **Une dimension nulle ne s'arrête jamais toute seule.** `octets` vaudrait 0,
    # `read(0)` rend zéro octet sans jamais être « plus court que demandé », et le
    # décodage produirait des images vides sans fin. Node contrôle déjà ce que
    # ffprobe lui a dit ; ce refus-ci vaut pour un appel direct au worker.
    if largeur <= 0 or hauteur <= 0 or min(a.source_size) <= 0:
        journal(f"Dimensions invalides : proxy {a.proxy_size}, source {a.source_size}.")
        return 2
    source_l, source_h = a.source_size
    départ = time.monotonic()

    # --- [1/4] les plans, sans toucher au GPU --------------------------------
    journal(f"[1/4] Frontières de plans (score de scène ≥ {a.scene_threshold})…")
    t0 = time.monotonic()
    évènements = scores_de_scène(a.ffmpeg, a.proxy, a.scene_floor)
    découpe = plans(évènements, a.duration, a.scene_threshold, a.min_shot)
    journal(
        f"      {len(découpe)} plans, {len(découpe) - 1} frontières retenues sur "
        f"{len(évènements)} candidates ≥ {a.scene_floor}, en {time.monotonic() - t0:.0f} s"
    )

    # --- [2/4] le modèle -----------------------------------------------------
    # Importé ici et non en tête de fichier : ultralytics tire torch et pèse une
    # dizaine de secondes. Un `--help`, un proxy absent ou des poids manquants
    # doivent répondre tout de suite. Et la passe ffmpeg ci-dessus n'a aucune
    # raison d'attendre le chargement de CUDA.
    import torch  # noqa: PLC0415
    from ultralytics import YOLO  # noqa: PLC0415

    if a.device.startswith("cuda") and not torch.cuda.is_available():
        journal(
            "CUDA est demandé mais indisponible depuis ce venv. La détection tournerait "
            "des heures sur le processeur au lieu de cinq minutes : on refuse. "
            "Relancer ./setup.sh, qui vérifie CUDA par un vrai essai."
        )
        return 3

    journal(f"[2/4] Chargement de {os.path.basename(a.model)} sur {a.device}…")
    modèle = YOLO(a.model)

    # --- [3/4] les corps -----------------------------------------------------
    attendues = max(1, int(math.ceil(a.duration * a.fps)))
    journal(
        f"[3/4] Détection des corps ({attendues} images à {a.fps} im/s, "
        f"entrée {a.imgsz}, seuil {a.conf})…"
    )
    t0 = time.monotonic()
    boîtes: list[dict[str, float]] = []
    images_vues = 0
    images_sans_personne = 0
    lot: list = []
    dernier_rapport = t0

    # La demi-précision profite des cœurs tenseurs de la carte sans changer une
    # détection à ce seuil de confiance. Sur le processeur elle est plus lente,
    # d'où la condition. `quantize=16` et non `half=True` : ultralytics 8.4 a
    # remplacé le second, qui marche encore mais écrit un avertissement par lot
    # — soit trois cents lignes de bruit dans le journal d'une émission.
    quantification = 16 if a.device.startswith("cuda") else None

    def vider(lot: list, indice_départ: int) -> int:
        nonlocal images_sans_personne
        if not lot:
            return 0
        résultats = modèle.predict(
            lot,
            imgsz=a.imgsz,
            conf=a.conf,
            classes=[CLASSE_PERSONNE],
            device=a.device,
            quantize=quantification,
            verbose=False,
        )
        for résultat in résultats:
            if résultat.boxes is None or len(résultat.boxes) == 0:
                images_sans_personne += 1
        boîtes.extend(boîtes_du_lot(résultats, indice_départ, a.fps, largeur, hauteur))
        return len(lot)

    for image in flux_images(a.ffmpeg, a.proxy, a.fps, largeur, hauteur):
        lot.append(image)
        if len(lot) >= a.batch:
            images_vues += vider(lot, images_vues)
            lot = []
            maintenant = time.monotonic()
            # Une ligne toutes les cinq secondes, et **sans crochets** : le motif
            # `[n/m]` d'`avancementWorker` s'y accrocherait et ferait reculer la
            # barre à chaque lot.
            if maintenant - dernier_rapport >= 5.0:
                dernier_rapport = maintenant
                vitesse = images_vues / max(maintenant - t0, 1e-9)
                journal(
                    f"      {images_vues}/{attendues} images "
                    f"({100 * images_vues / attendues:.0f} %), {vitesse:.0f} im/s"
                )
    images_vues += vider(lot, images_vues)

    secondes = time.monotonic() - t0
    part_vides = images_sans_personne / images_vues if images_vues else 0.0
    journal(
        f"      {images_vues} images en {secondes:.0f} s "
        f"({images_vues / max(secondes, 1e-9):.0f} im/s), {len(boîtes)} boîtes, "
        f"{100 * part_vides:.1f} % d'images sans personne"
    )

    # Rendre la VRAM avant d'écrire. `empty_cache()` ne suffit pas à tout rendre
    # — la garantie dure est la sortie du processus, et c'est Node qui l'attend
    # —, mais rien n'oblige le modèle à rester chargé pendant l'écriture d'un
    # mégaoctet de JSON.
    del modèle
    try:
        import gc  # noqa: PLC0415

        gc.collect()
        torch.cuda.empty_cache()
    except Exception:  # noqa: BLE001 — libérer est une optimisation, pas un contrat
        pass

    # --- [4/4] l'écriture ----------------------------------------------------
    journal(f"[4/4] Écriture de {a.out}…")
    dossier = os.path.dirname(a.out)
    if dossier:
        os.makedirs(dossier, exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(
            {
                "version": 1,
                "fps": a.fps,
                "source": {"w": source_l, "h": source_h},
                "proxy": {"w": largeur, "h": hauteur},
                "shots": découpe,
                "boxes": boîtes,
            },
            f,
            ensure_ascii=False,
        )

    journal(
        f"Écrit {a.out} : {len(découpe)} plans, {len(boîtes)} boîtes sur {images_vues} images, "
        f"en {time.monotonic() - départ:.0f} s."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
