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

**Et depuis le 19 août 2026, on détecte aussi la pose.** Les variantes ``-pose``
de la même famille rendent dix-sept points COCO par personne en plus de la boîte,
et ce script les écrit tels quels quand le modèle chargé en produit. C'est ce qui
permet à ``src/core/framing.ts`` de savoir où est la tête : une boîte est un
rectangle dont la largeur est la même à toutes les hauteurs, donc rien à
l'intérieur ne distingue une tête d'une cheville, et le cadrage se retrouvait
décidé par des jambes tendues (issue #69). Le surcoût est nul à la mesure —
145 im/s contre 147, trois passes chacun sur le même proxy. Ce script ne choisit
rien : il accepte les deux familles de poids, et ``keypoints`` dit dans le
résultat ce qu'il a trouvé.

**Deux passes, un seul fichier.** Les frontières de plans et les boîtes décrivent
le même proxy et atterrissent dans le même ``analysis.json`` : les séparer
donnerait deux flux d'avancement et une fusion dont personne n'est propriétaire.
La première passe est du pur ffmpeg et ne touche pas au GPU ; elle passe donc
**avant** le chargement du modèle, ce qui raccourcit d'une minute le temps
pendant lequel la VRAM est occupée.

**Les frontières viennent du score de scène de ffmpeg**, pas d'une bibliothèque
de plus : le binaire est déjà installé et éprouvé par ``setup.sh``.

**Et depuis le chantier des bascules de composition, d'un second détecteur,
croisé avec le premier.** Le score de scène compare des histogrammes, qu'une
composition qui translate la scène en bloc à l'intérieur d'un même plan
préserve — mesuré à 41 % du temps monté sur une émission. Les boîtes de
personnes, déjà collectées pour le cadrage, disent qu'une bascule a lieu et la
situent à ±1/fps près ; les scores de scène, déjà collectés à l'étape 1 et
jusqu'ici jetés une fois le seuil appliqué, donnent l'image exacte dans cette
fenêtre. Ni passe ffmpeg de plus, ni passage GPU de plus — voir la section
« Les bascules de composition » plus bas. **Le crop reste fixe à l'intérieur
d'un plan** : ce détecteur ajoute des frontières là où une coupe réelle
existait sans être vue, il n'introduit ni lissage ni suivi de caméra.

Le patron est celui de ``worker/transcribe.py``, et il est suivi de près :

- un script en ligne de commande, pas un service ;
- l'avancement sur **stderr**, en ``[n/5]``, lu par ``avancementWorker()``
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


def parse_scene_scores(text: str) -> list[tuple[float, float]]:
    """Les couples ``(instant, score)`` que ``metadata=print`` a écrits.

    Pure — ni ffmpeg ni disque — pour que ``scores_de_scène`` (la sortie d'un
    sous-processus) et le mode ``--replay`` (le contenu d'un fichier capturé
    une fois, voir ``--scene-scores``) partagent la même lecture sans que l'un
    des deux devienne le cas particulier de l'autre.
    """
    return [(float(t), float(s)) for t, s in COUPLE_SCÈNE.findall(text)]


def scene_filter(floor: float) -> str:
    """Le filtre ``-vf`` qui collecte les candidates de coupe, pur pour être testé
    sans lancer ffmpeg.

    **``gte`` et non ``gt``, depuis le chantier des bascules de composition.**
    ``plans()`` — devenu ``scene_boundaries`` — retenait déjà les scores par
    ``score >= seuil``, inclusif ; la collecte, elle, restait stricte. L'écart ne
    mordait que sur l'égalité pile, refusée par ``refus_du_seuil_de_scène``
    plutôt que corrigée : la fenêtre de collecte est désormais elle-même
    inclusive, ce qui vide ce refus de sa première raison d'être — il en garde
    une autre, voir cette fonction. Le binaire de ``setup.sh`` porte ``gte``
    (N-126188), et le diff mesuré sur 600 s est nul : 128 évènements dans les
    deux cas, aucune image dont le score tombe exactement sur un multiple du
    millième du plancher ou du seuil sur l'échantillon mesuré.
    """
    return f"select='gte(scene,{floor})',metadata=print:file=-"


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
        "-vf", scene_filter(plancher),
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
    return parse_scene_scores(terminé.stdout)


def _spaced_boundaries(candidates: list[float], duration: float, min_shot: float) -> list[float]:
    """Aligne une liste de temps candidats, gardés à ``min_shot`` les uns des
    autres — les deux bouts de ``[0, duration]`` comptant comme des frontières.

    **Partagée entre deux sources.** ``scene_boundaries`` l'appelle avec les
    seuls candidats qui franchissent le seuil de scène ; le croisement avec les
    bascules de composition l'appelle sur l'union des deux — scène et bascules
    raffinées — parce que le plancher d'un plan est un seul réglage
    (``--min-shot``), pas un par détecteur. Une bascule qui tomberait à moins
    d'une seconde d'une coupe de scène déjà retenue n'ajoute donc rien.

    Deux garde-fous, et le second est le seul qui ait coûté quelque chose :

    - une frontière hors de l'intervalle est ignorée. Le score de la toute
      première image se compare à rien ;
    - **deux frontières trop rapprochées n'en font qu'une.** Un éclair de lumière
      produit deux images de score élevé à une image d'intervalle, donc un
      « plan » de 33 millisecondes dans lequel le cadrage n'a rien à calculer.

    **Les deux bouts comptent comme des frontières.** ``min_shot`` se mesure
    depuis 0 pour la première et jusqu'à ``duration`` pour la dernière : sans
    cela une coupe à une demi-seconde du début, ou de la fin, produit un plan
    plus court que le minimum annoncé — le cas exact que le garde-fou est
    censé fermer, à l'endroit où il ne regardait pas.
    """
    boundaries: list[float] = []
    for t in sorted(candidates):
        if t <= 0 or t >= duration:
            continue
        # 0 quand la liste est vide : le début de la vidéo est une frontière
        # comme une autre du point de vue de la durée d'un plan.
        previous = boundaries[-1] if boundaries else 0.0
        if t - previous < min_shot:
            continue
        boundaries.append(t)

    # Un seul retrait suffit : la frontière qui devient dernière est à au moins
    # ``min_shot`` de celle qu'on vient d'ôter, donc à plus de ``min_shot`` de
    # la fin.
    if boundaries and duration - boundaries[-1] < min_shot:
        boundaries.pop()
    return boundaries


def scene_boundaries(
    events: list[tuple[float, float]], duration: float, threshold: float, min_shot: float
) -> list[float]:
    """Les instants où le score de scène franchit ``threshold``, espacés d'au
    moins ``min_shot``.

    Anciennement la première moitié de ``plans()``, dont la signature change :
    cette fonction-ci ne rend que les frontières, ``shots_from_boundaries``
    fait le découpage.

    **Ne sert pas au croisement avec les bascules de composition** —
    l'espacement qu'elle applique n'est pas associatif, voir la docstring de
    ``_scene_candidates``. Ses seuls appelants sont les tests et quiconque
    veut les frontières de scène seules, sans bascules.
    """
    return _spaced_boundaries(_scene_candidates(events, threshold), duration, min_shot)


def _scene_candidates(events: list[tuple[float, float]], threshold: float) -> list[float]:
    """Les instants où le score de scène franchit ``threshold``, **non
    espacés**.

    Distincte de ``scene_boundaries``, qui espace déjà son résultat :
    l'espacement n'est pas associatif, donc espacer les frontières de scène
    seules puis réespacer leur union avec les bascules de composition peut
    perdre une frontière valide que l'union brute, espacée une seule fois à
    la fin, aurait gardée. Exemple mesuré : des scores de scène à 5,0 et
    5,5 s, une bascule à 4,5 s, ``min_shot=1``. Espacer d'abord les seules
    frontières de scène élimine 5,5 (à 0,5 s de 5,0) : il ne reste que 5,0.
    Unir ce reste à la bascule et réespacer élimine ensuite 5,0 (à 0,5 s de
    4,5) : il ne reste que 4,5, et la frontière à 5,5 s a disparu — alors que
    l'union brute ``[4.5, 5.0, 5.5]`` espacée une seule fois retient 4,5 et
    5,5. (relevé par Copilot sur la PR #101)
    """
    return [t for t, score in events if score >= threshold]


def shots_from_boundaries(boundaries: list[float], duration: float) -> list[dict[str, float]]:
    """Découpe ``[0, duration]`` aux ``boundaries`` données, déjà triées et
    espacées — la seconde moitié de l'ancienne ``plans()``.

    Rend toujours au moins un plan : une liste de frontières vide est un plan
    unique, pas une liste vide, et le cadrage n'a pas à distinguer les deux cas.
    """
    edges = [0.0, *boundaries, duration]
    return [{"start": round(a, 3), "end": round(b, 3)} for a, b in zip(edges, edges[1:])]


# ---------------------------------------------------------------------------
# Les corps
# ---------------------------------------------------------------------------


def args_flux_images(ffmpeg: str, proxy: str, duration: float, fps: float) -> list[str]:
    """La commande ffmpeg de ``flux_images``, isolée pour être assertable sans décoder.

    ``-t`` en aval de ``-vf fps=`` borne le flux rééchantillonné, pas la
    source : le décodage s'arrête à ``duration`` au lieu de courir jusqu'à la
    fin du proxy. Vérifié avec ``testsrc`` avant d'écrire ce code — voir la PR.
    """
    return [
        ffmpeg,
        "-hide_banner",
        "-nostdin",
        "-loglevel", "error",
        "-i", proxy,
        "-an", "-sn",
        "-vf", f"fps={fps}",
        "-t", str(duration),
        "-f", "rawvideo",
        "-pix_fmt", "bgr24",
        "-",
    ]


def flux_images(ffmpeg: str, proxy: str, duration: float, fps: float, largeur: int, hauteur: int):
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
    args = args_flux_images(ffmpeg, proxy, duration, fps)
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

    **Les points de pose partent avec la boîte quand le modèle en rend**, dans
    ``k`` : dix-sept triplets ``x, y, confiance`` mis bout à bout, dans l'ordre
    COCO. Un tableau plat plutôt que dix-sept objets nommés — les noms
    coûteraient six fois la place des nombres qu'ils désignent, sur le champ le
    plus volumineux du fichier.

    **Les dix-sept sont écrits, pas le tronc.** Le tronc est une *définition*, et
    `src/core/framing.ts` doit pouvoir en changer sans relancer le GPU : c'est le
    même arbitrage que pour le filtre du premier plan et pour le seuil de
    confiance, tous deux laissés au lecteur pour la même raison.
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
        # `None` sur un modèle de détection ; un tenseur (n, 17, 3) sur un modèle
        # de pose. Les deux restent lisibles par le même script, et c'est ce qui
        # permet de comparer les deux familles sans deux chemins de code.
        keypoints = getattr(résultat, "keypoints", None)
        poses = None if keypoints is None else keypoints.data.tolist()
        for index, ((x0, y0, x1, y1), score) in enumerate(zip(coordonnées, confiances)):
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
            out = {
                "t": instant,
                "x0": fx0,
                "x1": fx1,
                "y0": fy0,
                "y1": fy1,
                # Vers le bas et non au plus proche : le seuil de
                # `framing.ts` est inclusif, et 0,4996 y devenait 0,5.
                "score": arrondi_vers_le_bas(score, 3),
            }
            # `poses[index]` et non un `zip` de plus : une boîte d'aire nulle
            # sort de la boucle par le `continue` ci-dessus, et un itérateur
            # parallèle décalerait alors tous les squelettes suivants d'un cran
            # — chaque personne héritant des points de sa voisine, sans que rien
            # ne le signale.
            if poses is not None and index < len(poses):
                out["k"] = flatten_keypoints(poses[index], largeur, hauteur)
            sorties.append(out)
    return sorties


def flatten_keypoints(keypoints, width: int, height: int) -> list[float]:
    """Dix-sept triplets ``x, y, confiance`` mis bout à bout, en fractions.

    **Les coordonnées ne sont pas bornées à [0, 1] comme celles des boîtes**, et
    c'est délibéré : un point hors cadre est une information — une épaule que le
    bord de l'image coupe — alors qu'une boîte hors cadre est un rectangle qui ne
    désigne plus rien. Ce qui lit ces points borne lui-même son résultat, comme
    `cropRect` le fait déjà pour la position du crop.

    **La confiance est tronquée vers le bas**, pour la raison exacte du ``score``
    d'une boîte : ``FramingOptions.torsoMinScore`` la lit avec un seuil
    **inclusif**, donc un arrondi au plus proche remonterait 0,496 à 0,50 et
    ferait entrer dans le tronc un point que le réseau n'a pas vu. Deux décimales
    suffisent — le chiffre ne sert qu'à ce seuil, et trois ajouteraient un
    dixième au poids du fichier. (relevé par Copilot)

    **Un point non fini sort à confiance nulle**, position comprise. Ultralytics
    ne promet rien sur ce point, et ce n'est pas le genre de promesse dont on
    dépend : un seul ``NaN`` ferait écrire à ``json.dump`` un littéral que
    ``JSON.parse`` refuse, donc une analyse entière — trois minutes de GPU —
    illisible sans que rien n'ait échoué au moment de l'écrire. À confiance
    nulle, le point est simplement « non vu », ce que tout ce qui le lit sait
    déjà traiter. (relevé par Aristarque)
    """
    flat: list[float] = []
    for x, y, confidence in keypoints:
        if not (math.isfinite(x) and math.isfinite(y) and math.isfinite(confidence)):
            flat.extend((0.0, 0.0, 0.0))
            continue
        flat.append(round(x / width, 4))
        flat.append(round(y / height, 4))
        # Bornée en plus d'être tronquée : le schéma de `analysis.ts` exige une
        # confiance dans [0, 1], et un modèle tiers n'est pas tenu de la rendre
        # ainsi.
        flat.append(min(max(arrondi_vers_le_bas(confidence, 2), 0.0), 1.0))
    return flat


# ---------------------------------------------------------------------------
# Les bascules de composition
# ---------------------------------------------------------------------------
#
# Mesuré le 19 août 2026 sur `2026-22-02-entre-nous` : à l'intérieur d'un plan
# détecté par le score de scène, la composition OBS translate parfois la scène
# entière en bloc — mêmes comédiens, mêmes largeurs de boîte, mêmes points de
# pose, glissés horizontalement de 0,14 à 0,285 de la largeur source, en une
# seule image, et rebascule 7 à 14 fois par plan. Le filtre `scene` de ffmpeg
# compare des histogrammes, qu'une translation préserve : la coupe la mieux
# mesurée du corpus est notée 0,366 pour un seuil de rétention à 0,40.
#
# **Un second détecteur de frontière, orthogonal au premier.** Les boîtes
# disent qu'une bascule a lieu et la situent à ±1/fps près (`composition_switches`) ;
# les scores de scène — déjà collectés à l'étape 1, jusqu'ici jetés — donnent
# l'image exacte, dans la fenêtre que la bascule désigne (`refine_switch`).
# Aucune passe ffmpeg de plus, aucun passage GPU en plus.
#
# **« Le crop est fixe à l'intérieur d'un plan » ne bouge pas.** Rien ici ne
# lisse, n'interpole ni ne suit une caméra : une bascule détectée devient une
# frontière de plus, au même titre qu'une coupe de scène — un plan qui portait
# trois cadrages devient trois plans d'un cadrage chacun.
#
# **Une bascule dont le raffinement échoue est rejetée, pas posée au milieu de
# sa fenêtre.** Le détecteur exige deux signaux indépendants ; n'en avoir qu'un
# ne prouve rien, surtout quand le second — le score de scène — dit que rien de
# visible ne change. Voir `refine_switch` pour les deux faux positifs qui l'ont
# montré à l'image sur `cqlp`.


def person_anchor(box: dict, min_point_score: float) -> float:
    """L'abscisse qui représente une personne, pour mesurer un déplacement
    collectif — pas une définition de tronc, `framing.ts` reste seul à en
    donner une.

    **Médiane des points de pose dont la confiance atteint ``min_point_score``**,
    pas leur moyenne : un bras tendu vers l'avant a une confiance aussi haute
    que l'épaule qui le porte, et sa position pèserait deux fois dans une
    moyenne alors qu'il ne bouge pas au même rythme que le buste. **Repli sur le
    centre de la boîte**, ``(x0 + x1) / 2``, quand aucun point n'atteint le
    seuil — une analyse de version 1 n'a pas de points, un ``DETECT_MODEL``
    sans ``-pose`` non plus, une personne de dos n'a pas de torsion lisible.
    Même repli que ``personBounds`` côté cadrage, même raison.

    **Volontairement non bornée à [0, 1].** Les points de pose eux-mêmes ne le
    sont pas (voir ``flatten_keypoints``) : un point hors cadre est une
    information — une épaule que le bord de l'image coupe —, et borner
    l'ancrage d'un seul côté fabriquerait un déplacement qui n'existe pas,
    des deux côtés effacerait celui d'une personne qui sort réellement du
    cadre. C'est le bornage à sens unique qui a déjà coûté une largeur
    négative en trois exemplaires ailleurs dans ce dépôt ; ici la décision est
    l'inverse, et elle est délibérée.
    """
    points = box.get("k")
    if points:
        xs = sorted(
            points[i] for i in range(0, len(points), 3) if points[i + 2] >= min_point_score
        )
        if xs:
            n = len(xs)
            mid = n // 2
            return xs[mid] if n % 2 == 1 else (xs[mid - 1] + xs[mid]) / 2
    return (box["x0"] + box["x1"]) / 2


def _median(values: list[float]) -> float:
    """La médiane d'une liste non vide, sans dépendance à ``statistics``."""
    ordered = sorted(values)
    n = len(ordered)
    mid = n // 2
    return ordered[mid] if n % 2 == 1 else (ordered[mid - 1] + ordered[mid]) / 2


def collective_shift(
    a: list[float], b: list[float], tolerance: float
) -> tuple[float | None, int]:
    """Le déplacement collectif entre deux images d'ancrages, en abscisse —
    ``(médiane de toutes les différences de rang, nombre de personnes
    appariées)`` quand ``len(a) == len(b)`` — le second terme compte les
    différences retenues, le premier reste la médiane de l'ensemble, pas
    seulement des retenues, voir plus bas —, ou ``(médiane des paires
    appariées, nombre de personnes appariées)`` sinon. ``(None, 0)`` si l'une
    des deux images n'a personne, ou si aucune
    différence ne fait consensus.

    **Deux méthodes d'appariement, selon que l'effectif est stable ou non.**
    Une translation ne change pas l'ordre gauche-droite des personnes : quand
    ``len(a) == len(b)``, apparier les ancres **triées, rang par rang**, est
    structurellement immunisé contre l'appariement croisé — une paire qui
    associerait la position d'avant d'une personne à la position d'après
    d'une autre, sans aucune réalité physique.

    **Pourquoi ce n'était pas déjà le cas.** La version précédente votait sur
    *toutes* les paires ``(a[i], b[j])``, y compris les croisées, et
    départageait les égalités de voix par le plus petit ``|d|`` — juste
    quand l'égalité veut dire « rien n'a bougé », faux quand elle veut dire
    « je n'arrive pas à apparier ». À deux personnes qui glissent chacune
    d'environ 0,3 mais s'écartent de plus de ``tolerance`` l'une de l'autre,
    les deux vraies paires ne se votaient pas entre elles, la croisée
    tombait par hasard près de zéro, et le départage la choisissait — un
    ``shift`` proche de zéro rendu avec l'aplomb d'un résultat, sur une
    bascule réelle. (relevé le 19 août 2026, sur `2026-22-02-entre-nous`
    autour de 3 241 s et 3 248 s : les deux vraies différences, dans les deux
    cas, valaient à peu près 0,29 et 0,33, à 0,04 et 0,05 l'une de l'autre —
    juste au-dessus de la tolérance mesurée pour les bascules déjà vues.)

    **Une fois l'appariement sûr, la question change.** Elle n'est plus « quelles
    paires sont réelles » — l'ordre le garantit —, mais « le groupe est-il
    d'accord sur une valeur commune ». Chaque différence de rang est comparée
    à la **médiane de toutes les différences de rang**, elle-même robuste à un
    déplacement individuel isolé ; ``matched`` compte celles qui tombent à
    ``tolerance`` de cette médiane. Une seule personne qui bouge beaucoup
    pendant que l'autre ne bouge pas donne une médiane à mi-chemin des deux, et
    aucune des deux ne retombe dedans : ``matched`` peut tomber à 0, ce que
    l'ancien vote ne pouvait pas exprimer — il rendait toujours un ``shift``,
    juste ou non.

    **Limite documentée, pas résolue ici** : l'ordre n'est fiable que si
    l'effectif est stable *et* que les personnes ne se croisent pas entre les
    deux images. Une entrée et une sortie simultanées, qui laissent
    ``len(a) == len(b)`` inchangé, ou deux comédiens qui échangent leurs places
    à l'écran au même instant qu'une bascule, restent hors de portée — aucune
    méthode sans suivi d'identité ne les distingue, et ce n'est pas l'objet de
    ce correctif.

    **Un modèle affine (``x' = a·x + b``) a été mesuré et écarté** pour ce cas :
    à deux points, la résolution est toujours exacte, résidu nul — vérifié à la
    machine, `(0.1,0.4)→(0.31,0.59)` et `(0.1,0.4)→(0.9,0.05)` donnent chacun un
    système sans reste. Un modèle qui s'ajuste toujours n'a aucun pouvoir de
    réfutation à l'effectif le plus fréquent de ce corpus (deux personnes), donc
    ne distinguerait jamais une bascule d'un bruit de mesure.

    **Quand l'effectif diffère**, une personne est entrée ou sortie du cadre :
    l'ordre ne correspond plus à rien, et l'ancien mécanisme — vote sur toutes
    les paires, appariement glouton un-à-un, départage par le plus petit
    ``|d|`` — reste seul en mesure de proposer un appariement partiel.
    """
    if not a or not b:
        return None, 0

    if len(a) == len(b):
        # Ordre garanti par la translation : pas de paire croisée possible.
        diffs = [y - x for x, y in zip(sorted(a), sorted(b))]
        pivot = _median(diffs)
        matched = [d for d in diffs if abs(d - pivot) <= tolerance]
        if not matched:
            return None, 0
        return _median(diffs), len(matched)

    # Effectifs différents : quelqu'un est entré ou sorti du cadre, l'ordre ne
    # suffit plus à apparier. Vote sur toutes les paires, comme avant.
    candidates = [(bj - ai, i, j) for i, ai in enumerate(a) for j, bj in enumerate(b)]

    def votes(d: float) -> int:
        return sum(1 for d2, _, _ in candidates if abs(d2 - d) <= tolerance)

    best_votes = -1
    best_shift = 0.0
    for d, _, _ in candidates:
        v = votes(d)
        if v > best_votes or (v == best_votes and abs(d) < abs(best_shift)):
            best_votes = v
            best_shift = d

    used_a: set[int] = set()
    used_b: set[int] = set()
    paired: list[float] = []
    for d, i, j in sorted(candidates, key=lambda c: abs(c[0] - best_shift)):
        if abs(d - best_shift) > tolerance:
            # Trié par proximité avec `best_shift` : personne au-delà ne peut
            # plus qualifier.
            break
        if i in used_a or j in used_b:
            continue
        used_a.add(i)
        used_b.add(j)
        paired.append(d)

    if not paired:
        return None, 0
    return _median(paired), len(paired)


def composition_switches(
    boxes: list[dict],
    fps: float,
    min_point_score: float,
    tolerance: float,
    part: int,
    min_shift: float,
) -> list[tuple[float, float]]:
    """Les fenêtres ``(t1, t2)`` — deux images consécutives de la détection —
    où les boîtes disent qu'une bascule de composition a lieu.

    Rend des **fenêtres**, pas des instants : c'est ``refine_switch`` qui
    cherche l'image exacte à l'intérieur de chacune, dans les scores de scène.

    Une bascule est déclarée si les quatre tiennent, dans l'ordre où elles
    coûtent le moins cher à vérifier :

    1. ``t2 - t1`` vaut ``1/fps`` à 1 ms près — **jamais comparer par-dessus un
       trou de détection**. Une image sans détection casserait sinon
       silencieusement l'hypothèse d'un déplacement continu.
    2. Au moins deux personnes appariées — **un seul comédien qui traverse le
       cadre ne prouve rien** sur la composition.
    3. La part de personnes appariées, rapportée au plus petit effectif des
       deux images, atteint ``part`` dixièmes — **en arithmétique entière**
       (``matched * 10 >= min(n1, n2) * part``) : ``0.6 * 5`` vaut
       ``3.0000000000000004`` en flottant, et ce dépôt a déjà payé ce défaut
       dans ``choisirRatio``. Protège contre une entrée ou une sortie de cadre,
       que la composition n'a pas bougé.
    4. Le déplacement collectif, tronqué vers le bas à quatre décimales,
       atteint ``min_shift`` — **tronqué et non arrondi**, la même règle que
       pour un score comparé à un seuil inclusif (``arrondi_vers_le_bas``),
       parce que la comparaison qui suit l'est aussi.
    """
    by_time: dict[float, list[dict]] = {}
    for entry in boxes:
        by_time.setdefault(entry["t"], []).append(entry)
    times = sorted(by_time)

    step = 1.0 / fps
    candidates: list[tuple[float, float]] = []
    for t1, t2 in zip(times, times[1:]):
        if abs((t2 - t1) - step) > 1e-3:
            continue
        anchors_1 = [person_anchor(b, min_point_score) for b in by_time[t1]]
        anchors_2 = [person_anchor(b, min_point_score) for b in by_time[t2]]
        shift, matched = collective_shift(anchors_1, anchors_2, tolerance)
        if shift is None or matched < 2:
            continue
        smallest_count = min(len(anchors_1), len(anchors_2))
        if matched * 10 < smallest_count * part:
            continue
        if arrondi_vers_le_bas(abs(shift), 4) < min_shift:
            continue
        candidates.append((t1, t2))
    return candidates


def refine_switch(
    t1: float,
    t2: float,
    events: list[tuple[float, float]],
    fps: float,
    min_score: float = 0.0,
) -> tuple[float, bool]:
    """L'image exacte d'une bascule détectée entre ``t1`` et ``t2``.

    @param min_score magnitude minimale du score confirmant. À 0,0 — le défaut
        — toute fenêtre non vide confirme, le comportement d'avant.
    @returns ``(instant, confirmé)``. La fenêtre est ``(t1, t2 + 1/(2·fps)]``,
        la demi-image absorbant le décalage entre l'horloge des boîtes et celle
        des scores. Non confirmée, la bascule est **rejetée** par les deux
        appelants, jamais posée au milieu. Les mesures qui fondent la fenêtre,
        le rejet et le plancher : `docs/ratios-par-clip.md`.
    """
    upper_bound = t2 + 1.0 / (2.0 * fps)
    window = [(t, s) for t, s in events if t1 < t <= upper_bound]
    if window:
        best_t, best_score = max(window, key=lambda pair: pair[1])
        if best_score >= min_score:
            return best_t, True
    return (t1 + upper_bound) / 2, False


# Les défauts du déclencheur de rupture, lus par `argparse` **et** par
# `refus_du_seuil_de_scène` : les sept seuils voisins les écrivent deux fois
# chacun, sans rien qui lie les deux copies.
DEFAULT_RUPTURE_THRESHOLD = 0.40
DEFAULT_RUPTURE_MIN_SCORE = 0.15
DEFAULT_RUPTURE_BOX_SCORE = 0.5


def composition_ruptures(
    boxes: list[dict], fps: float, min_box_score: float, threshold: float
) -> list[tuple[float, float]]:
    """Les fenêtres ``(t1, t2)`` où l'échelle des corps ou leur assise change
    d'un coup — ce qu'une translation ne fait jamais.

    **Second déclencheur du même détecteur**, pour les coupes que
    ``composition_switches`` ne peut pas voir : à effectif variable, il n'y a
    aucun déplacement commun à mesurer et sa condition « deux personnes
    appariées » écarte la fenêtre. Rend des fenêtres, que ``refine_switch``
    confirme sur le score de scène : le principe des deux signaux indépendants
    ne change pas, seul le premier s'élargit.
    """
    # **Des médianes, jamais l'effectif.** YOLO ajoute et retire des boîtes
    # fantômes d'une image à l'autre : un changement de compte battrait avec
    # elles, une médiane ne bouge pas. Le cas mesuré : docs/ratios-par-clip.md.
    by_time: dict[float, list[dict]] = {}
    for entry in boxes:
        if entry["score"] >= min_box_score:
            by_time.setdefault(entry["t"], []).append(entry)
    profile = {
        t: (_median([b["x1"] - b["x0"] for b in kept]), _median([b["y0"] for b in kept]))
        for t, kept in by_time.items()
    }
    times = sorted(profile)

    step = 1.0 / fps
    candidates: list[tuple[float, float]] = []
    for t1, t2 in zip(times, times[1:]):
        # Jamais par-dessus un trou : une image sans corps retenu n'est pas une
        # image sans rupture, elle est une image sans information.
        if abs((t2 - t1) - step) > 1e-3:
            continue
        width_1, top_1 = profile[t1]
        width_2, top_2 = profile[t2]
        widest = max(width_1, width_2)
        scale = abs(width_2 - width_1) / widest if widest > 0 else 0.0
        # Tronqué et non arrondi, comme le déplacement de `composition_switches`
        # et pour la même raison : la comparaison qui suit est inclusive.
        if arrondi_vers_le_bas(max(scale, abs(top_2 - top_1)), 4) < threshold:
            continue
        candidates.append((t1, t2))
    return candidates


def _without(
    candidates: list[tuple[float, float]], already: list[tuple[float, float]]
) -> list[tuple[float, float]]:
    """Les fenêtres que l'autre déclencheur n'a pas déjà proposées.

    Les deux se recouvrent pour de bon — 24 fenêtres sur 57 sur
    `2026-02-08-eve-matteo-pr`, 17 sur 60 sur `2025-06-15-cqlp`. Sans ce
    retrait, une fenêtre commune serait raffinée deux fois et comptée deux fois
    dans le journal, dont le balayage lit les nombres. Les frontières, elles, ne
    changent pas : `_spaced_boundaries` écarte déjà un instant répété.
    """
    seen = set(already)
    return [window for window in candidates if window not in seen]


def confirmed_switches(
    candidates: list[tuple[float, float]],
    events: list[tuple[float, float]],
    fps: float,
    min_score: float = 0.0,
) -> tuple[list[float], int]:
    """Les instants que le score de scène confirme, et le nombre de rejets.

    Partagée par les deux déclencheurs et par les deux appelants (``main`` et
    ``run_replay``), qui écrivaient la même boucle chacun de leur côté.
    """
    times: list[float] = []
    rejected = 0
    for t1, t2 in candidates:
        refined_t, refined = refine_switch(t1, t2, events, fps, min_score)
        if refined:
            times.append(refined_t)
        else:
            rejected += 1
    return times, rejected


# ---------------------------------------------------------------------------
# Ce qu'on refuse avant de commencer
# ---------------------------------------------------------------------------


def refus_du_seuil_de_scène(
    seuil: float,
    plancher: float,
    plan_min: float = 1.0,
    switch_shift: float = 0.08,
    switch_tolerance: float = 0.03,
    switch_share: int = 8,
    switch_point_score: float = 0.3,
    rupture_threshold: float = DEFAULT_RUPTURE_THRESHOLD,
    rupture_min_score: float = DEFAULT_RUPTURE_MIN_SCORE,
    rupture_box_score: float = DEFAULT_RUPTURE_BOX_SCORE,
) -> str | None:
    """Ce qui cloche dans les seuils du détecteur, ou ``None`` si rien.

    **Deux détecteurs, un seul refus.** Les frontières de plans et les bascules
    de composition partagent ce contrôle plutôt que d'en avoir chacun un : les
    deux lisent des seuils comparés à des grandeurs du même ordre — un score, une
    fraction, une durée — et les mêmes pannes s'y répètent, comme les items
    ci-dessous le montrent.

    **Le couple seuil/plancher.** Les frontières de plans se décident en deux
    temps : ffmpeg ne rapporte que les images au-dessus du **plancher de
    collecte**, et ``scene_boundaries`` applique ensuite le **seuil** demandé. Un
    seuil sous le plancher portait donc sur des candidates qui n'avaient jamais
    été collectées : l'argument était accepté, et il ne faisait rien.

    **Un refus et non un ``min()`` qui abaisserait le plancher tout seul.** Le
    ``min()`` reproduirait le défaut un cran plus bas : à plancher nul,
    ``gte(scene, 0)`` retient à peu près chaque image d'une émission de deux
    heures, et ``scores_de_scène`` ramasse cette sortie en mémoire d'un seul
    tenant. Le refus nomme les deux valeurs et laisse le choix — baisser le
    plancher aussi — à qui sait ce qu'il cherche.

    **Les deux nombres sont jugés sur tout le domaine, pas seulement le seuil et
    pas seulement par le bas.** Valider l'un et pas l'autre laissait le danger
    accessible par la porte d'à côté : c'est ``--scene-floor 0`` qui déclenche la
    collecte totale invoquée ci-dessus. Et au-dessus de 1 — la faute de décimale
    sur 0,4 — aucune image ne dépasse jamais le seuil : l'analyse sort en un plan
    unique, valide, que le graphe par présence sert ensuite à chaque relance.
    Et ``NaN`` passe *toutes* les comparaisons, donc passait ce refus — puis
    ``scene_boundaries``, qui n'écarte que ``score < seuil`` : chaque candidate
    collectée serait devenue une frontière. ``argparse`` prend ``nan`` et ``inf``
    sans broncher. (relevé par Copilot sur la PR #44)

    **L'égalité reste refusée, et ce n'est plus pour la raison qui l'a fait
    naître.** À la version précédente de ce refus, la collecte était stricte —
    ``gt(scene, plancher)`` — et la rétention inclusive — ``score >= seuil`` —, si
    bien qu'une image dont le score valait exactement le plancher disparaissait
    sans un mot : gardée par la seconde, jamais rapportée par la première. C'est
    ce défaut-là que le refus fermait. **La collecte est désormais inclusive elle
    aussi** (``gte``, voir ``scene_filter``), donc cette asymétrie n'existe plus.
    Le refus reste, sur une raison différente : à ``seuil == plancher`` avec une
    collecte inclusive, **toute** candidate collectée — chaque image dont le
    score atteint le plancher — atteint aussi le seuil, et devient donc une
    frontière. Le plancher de collecte, pensé pour laisser la distribution
    mesurable, se retrouverait à décider des coupes à la place du seuil. Un seuil
    strictement au-dessus du plancher reste nécessaire pour que les deux gardent
    leur rôle.

    **Le plancher d'un plan, ``--min-shot``, n'était validé nulle part.**
    ``NaN`` y passe toutes les comparaisons de ``scene_boundaries`` — y compris
    celle qui écarte les frontières trop rapprochées —, qui garde alors chaque
    candidate collectée : des plans de durée quasi nulle que le schéma de
    l'analyse refuse, découverts après les trois minutes de GPU de la détection
    de corps. Jumeau exact du ``--scene-threshold nan`` fermé plus haut, un cran
    plus loin dans le fichier.

    **Les quatre seuils des bascules de composition suivent le même contrôle.**
    ``--switch-shift`` et ``--switch-tolerance`` sont des fractions de largeur
    d'image, positives et finies par construction — un déplacement ou une
    tolérance nuls ou négatifs ne veulent rien dire, et ``NaN``/``Infinity`` y
    referaient le défaut fermé plus haut. **Aucune borne haute** : contrairement
    au score de scène, une différence d'ancrages n'est pas bornée à 1 — les
    points de pose qui la fondent ne le sont pas non plus, et pour la même
    raison (voir ``person_anchor``). ``--switch-point-score`` vit dans le même
    domaine que le score de scène, ``]0, 1]``, mais avec sa propre vérification
    plus bas — un domaine hors limites n'y a pas le même effet, voir cette
    seconde vérification pour la raison : à zéro, un point neutralisé par
    ``flatten_keypoints`` — confiance nulle, position non fiable — passerait le
    seuil et fausserait l'ancrage qu'il est censé exclure. ``--switch-share``
    s'exprime en **dixièmes**, en entier, pour que la condition de rétention
    reste une comparaison d'entiers (``matched * 10 >= min(n1, n2) * part``) :
    ``0.6 * 5`` vaut ``3.0000000000000004`` en flottant, et ce dépôt a déjà payé
    ce défaut dans ``choisirRatio``. Il vit dans ``[1, 10]`` : à 0 la condition
    est toujours vraie quel que soit l'effectif, au-dessus de 10 elle ne l'est
    jamais.
    """
    for nom, valeur in (
        ("--scene-threshold", seuil),
        ("--scene-floor", plancher),
    ):
        # `math.isfinite` et non `!= valeur` : il attrape `nan` et les deux
        # infinis d'un seul contrôle, et il se lit.
        if not math.isfinite(valeur):
            return (
                f"{nom} vaut {valeur}, qui n'est pas un nombre fini : toute comparaison avec "
                "NaN est fausse, toute comparaison avec un infini est constante. Ni l'une ni "
                "l'autre ne trie quoi que ce soit, et aucune ne le dit. Le score de scène de "
                "ffmpeg vit dans ]0, 1]."
            )
        if not 0 < valeur <= 1:
            return (
                f"{nom} vaut {valeur}, hors du domaine du score de scène de ffmpeg, qui vit "
                "dans ]0, 1]. Un seuil nul déclare une coupe à chaque candidate collectée ; un "
                "plancher nul en fait collecter chaque image d'une émission de deux heures "
                "sans exception (la collecte est inclusive, gte), ramassée en mémoire d'un seul "
                "tenant ; et au-dessus de 1 — la faute de décimale sur 0,4 — plus rien ne coupe, "
                "l'analyse sort en un plan unique sans que rien n'échoue. 0,4 sur un plancher "
                "de 0,05 sont les valeurs mesurées."
            )
    # **Vérification séparée de celle ci-dessus** : `--switch-point-score` vit
    # dans le même domaine ``]0, 1]`` qu'un score de scène, mais un seuil hors
    # domaine n'y produit pas le même effet. Un seuil ou un plancher hors
    # domaine change ce que `scene_boundaries` retient ou collecte ; un
    # `--switch-point-score` hors domaine ne fait rien « sortir en un plan
    # unique » — `person_anchor` replie sur le centre de boîte et les coupes de
    # scène restent actives, seule la précision de l'ancrage change. Le
    # message générique le laissait entendre à tort. (relevé par Copilot sur
    # la PR #101)
    if not math.isfinite(switch_point_score):
        return (
            f"--switch-point-score vaut {switch_point_score}, qui n'est pas un nombre fini : "
            "toute comparaison avec NaN est fausse, toute comparaison avec un infini est "
            "constante. Un score de point de pose vit dans ]0, 1]."
        )
    if not 0 < switch_point_score <= 1:
        return (
            f"--switch-point-score vaut {switch_point_score}, hors du domaine d'un score de "
            "point de pose, qui vit dans ]0, 1]. À zéro, un point neutralisé par "
            "flatten_keypoints (confiance nulle, position non fiable) passerait le seuil et "
            "fausserait l'ancrage qu'il est censé exclure ; au-dessus de 1, aucun point ne "
            "l'atteint jamais et person_anchor replie systématiquement sur le centre de "
            "boîte — les coupes de scène restent actives, ce n'est pas un plan unique."
        )
    if seuil <= plancher:
        return (
            f"--scene-threshold ({seuil}) n'est pas strictement au-dessus de --scene-floor "
            f"({plancher}) : la collecte est inclusive, donc à valeurs égales chaque candidate "
            "collectée devient une frontière, et le plancher de collecte déciderait des coupes "
            "à la place du seuil. Baisser --scene-floor si des coupes plus discrètes sont "
            "recherchées — au prix d'une passe ffmpeg plus bavarde."
        )
    if not math.isfinite(plan_min) or plan_min <= 0:
        return (
            f"--min-shot vaut {plan_min}, qui doit être un nombre fini et strictement positif : "
            "c'est la durée minimale d'un plan, en secondes. NaN passe toutes les comparaisons "
            "qui l'utilisent — y compris celle qui écarte les frontières trop rapprochées —, "
            "et produit des plans de durée quasi nulle que le schéma de l'analyse refuse, après "
            "les trois minutes de GPU de la détection de corps."
        )
    for nom, valeur in (("--switch-shift", switch_shift), ("--switch-tolerance", switch_tolerance)):
        if not math.isfinite(valeur) or valeur <= 0:
            return (
                f"{nom} vaut {valeur}, qui doit être un nombre fini et strictement positif : "
                "c'est une fraction de la largeur de l'image, et une valeur nulle, négative, "
                "NaN ou infinie ne trie aucune bascule. Volontairement sans borne haute — voir "
                "la docstring de cette fonction."
            )
    if not isinstance(switch_share, int) or not 1 <= switch_share <= 10:
        return (
            f"--switch-share vaut {switch_share!r}, qui doit être un entier entre 1 et 10 : "
            "la part de personnes qui doit avoir bougé s'exprime en dixièmes, pour que la "
            "condition de rétention reste une comparaison d'entiers. À 0 elle serait toujours "
            "vraie, au-dessus de 10 jamais."
        )
    if not math.isfinite(rupture_threshold) or not 0 < rupture_threshold <= 1:
        return (
            f"--rupture-threshold vaut {rupture_threshold}, hors de ]0, 1]. C'est la plus "
            "grande de deux fractions — une variation d'échelle, un déplacement d'assise — "
            "toutes deux tirées de coordonnées de boîte, que le schéma de l'analyse borne à "
            "[0, 1]. **Borné en haut, contrairement à --switch-shift qui ne l'est pas** : "
            "celui-là compare des ancrages de pose, qui sortent légitimement du cadre (voir "
            "person_anchor), celui-ci ne le peut pas. À zéro chaque paire d'images devient une "
            "fenêtre et le score de scène décide seul ; à 1 le déclencheur se tait, ce qui est "
            "le témoin négatif d'un balayage."
        )
    if not math.isfinite(rupture_min_score) or not 0 <= rupture_min_score <= 1:
        return (
            f"--rupture-min-score vaut {rupture_min_score}, hors de [0, 1] où vit un score de "
            "scène. C'est la magnitude minimale du score qui confirme une rupture : à 0 une "
            "traîne au plancher de collecte suffit à confirmer, ce qui est le défaut décrit "
            "dans refine_switch ; au-dessus de 1 aucune rupture n'est jamais confirmée. "
            "**Zéro est accepté** : c'est le comportement d'avant ce déclencheur, et la ligne "
            "témoin d'un balayage."
        )
    # **Pas de refus croisé avec --scene-threshold**, quoiqu'un plancher
    # au-dessus du seuil ne rende que des frontières redondantes : c'est inutile,
    # pas cassé, et le refus bloquait un abaissement légitime du seuil de scène.
    if 0 < rupture_min_score < plancher:
        return (
            f"--rupture-min-score ({rupture_min_score}) est sous --scene-floor ({plancher}), "
            "le plancher de collecte : aucun score en dessous n'est jamais rapporté par ffmpeg, "
            "donc ce réglage se comporte exactement comme 0 sans le dire — accepté, et sans "
            "effet. Le mettre à 0 si c'est l'intention, l'amener au niveau du plancher sinon, "
            "ou baisser --scene-floor pour que l'intervalle demandé existe."
        )
    if not math.isfinite(rupture_box_score) or not 0 < rupture_box_score <= 1:
        return (
            f"--rupture-box-score vaut {rupture_box_score}, hors du domaine d'une confiance de "
            "boîte, qui vit dans ]0, 1]. C'est ce qui tient les boîtes fantômes de YOLO hors "
            "des médianes : à zéro elles y entrent toutes et le déclencheur se met à battre "
            "avec elles ; au-dessus de 1 aucune image n'a de profil et il ne propose rien."
        )
    return None


# ---------------------------------------------------------------------------
# Le rejeu, pour étalonner sans GPU ni ffmpeg
# ---------------------------------------------------------------------------


def même_fichier(chemin_a: str, chemin_b: str) -> bool:
    """Chemin identique, ou même inode (lien symbolique ou physique).

    ``samefile`` lève si l'un des deux chemins n'existe pas encore : on s'y
    rabat alors sur la comparaison de chemins, seule utilisable pour un
    ``--out`` qui n'a pas encore été écrit.
    """
    if os.path.abspath(chemin_a) == os.path.abspath(chemin_b):
        return True
    return os.path.exists(chemin_a) and os.path.exists(chemin_b) and os.path.samefile(chemin_a, chemin_b)


def run_replay(a: argparse.Namespace) -> int:
    """Recalcule les frontières d'un ``analysis.json`` existant, à partir
    d'une capture de scores de scène déjà faite — sans GPU, sans ffmpeg.

    **Le pivot de l'étalonnage.** Les quatre projets du corpus portent déjà
    toutes leurs boîtes ; il ne manque que les scores de scène, qui se
    capturent une fois (voir docs/ratios-par-clip.md pour la commande) parce
    qu'ils ne dépendent d'aucun des seuils qu'on étalonne. Balayer une grille
    de seuils devient alors une affaire de secondes, pas de minutes de GPU
    répétées.

    **Tout est recopié depuis l'analyse d'origine, sauf ``shots``** : version,
    fps, modèle, dimensions, boîtes, marqueur ``keypoints``. C'est aussi ce qui
    fait marcher le rejeu sur une analyse de version 1 — sans points de pose,
    donc sans ``keypoints`` et sans ``k`` sur ses boîtes — puisque
    ``person_anchor`` replie déjà sur le centre de boîte dans ce cas : rien
    ici n'a besoin de le savoir.

    ``fps`` vient du fichier rejoué, pas de ``--fps`` : les fenêtres de
    ``composition_switches`` et de ``refine_switch`` doivent utiliser la
    cadence qui a réellement produit les boîtes, sans quoi la condition sur
    l'écart entre deux images consécutives ne validerait plus rien.
    """
    if a.scene_scores is None:
        journal("--replay exige --scene-scores : la capture des scores de scène de cette émission.")
        return 2
    if not os.path.isfile(a.replay):
        journal(f"Analyse introuvable : {a.replay}")
        return 2
    if not os.path.isfile(a.scene_scores):
        journal(f"Capture de scores de scène introuvable : {a.scene_scores}")
        return 2
    # **``--out`` ne doit désigner ni ``--replay`` ni ``--scene-scores``.** Une
    # faute de frappe dans une commande de calibrage écraserait sinon l'un des
    # deux à l'écriture du résultat, après qu'il a servi à ce rejeu — pour
    # ``--replay``, relevé par Copilot sur #101.
    if même_fichier(a.out, a.replay):
        journal(f"--out ({a.out}) désigne le même fichier que --replay : rien à rejouer sur.")
        return 2
    if même_fichier(a.out, a.scene_scores):
        journal(f"--out ({a.out}) désigne le même fichier que --scene-scores : rien à rejouer sur.")
        return 2

    validation_error = refus_du_seuil_de_scène(
        a.scene_threshold,
        a.scene_floor,
        a.min_shot,
        a.switch_shift,
        a.switch_tolerance,
        a.switch_share,
        a.switch_point_score,
        a.rupture_threshold,
        a.rupture_min_score,
        a.rupture_box_score,
    )
    if validation_error is not None:
        journal(validation_error)
        return 2

    with open(a.replay, "r", encoding="utf-8") as f:
        analysis = json.load(f)

    shots = analysis.get("shots")
    if not shots:
        journal(f"{a.replay} ne porte aucun plan : rien à rejouer.")
        return 2
    # La durée n'est écrite nulle part dans le fichier ; le dernier plan la
    # porte, puisque `shots_from_boundaries` partitionne toujours [0, durée]
    # sans reste.
    duration = shots[-1]["end"]
    boxes = analysis.get("boxes", [])
    fps = analysis.get("fps", a.fps)

    with open(a.scene_scores, "r", encoding="utf-8") as f:
        events = parse_scene_scores(f.read())

    scene_boundary_times = _scene_candidates(events, a.scene_threshold)
    switch_candidates = composition_switches(
        boxes, fps, a.switch_point_score, a.switch_tolerance, a.switch_share, a.switch_shift
    )
    switch_boundary_times, rejected_count = confirmed_switches(switch_candidates, events, fps)
    rupture_candidates = _without(
        composition_ruptures(boxes, fps, a.rupture_box_score, a.rupture_threshold),
        switch_candidates,
    )
    rupture_boundary_times, rupture_rejected = confirmed_switches(
        rupture_candidates, events, fps, a.rupture_min_score
    )

    boundaries = _spaced_boundaries(
        [*scene_boundary_times, *switch_boundary_times, *rupture_boundary_times],
        duration,
        a.min_shot,
    )
    analysis["shots"] = shots_from_boundaries(boundaries, duration)

    rejected_rate = rejected_count / len(switch_candidates) if switch_candidates else 0.0
    journal(
        f"Rejeu : {len(analysis['shots'])} plans, {len(boundaries)} frontières "
        f"({len(scene_boundary_times)} scène sur {len(events)} candidates, "
        f"{len(switch_boundary_times)} bascules retenues sur {len(switch_candidates)} candidates, "
        f"{rejected_count} rejetées faute de score de scène ({100 * rejected_rate:.0f} %), "
        f"{len(rupture_boundary_times)} ruptures retenues sur {len(rupture_candidates)} "
        f"candidates, {rupture_rejected} rejetées)."
    )

    output_dir = os.path.dirname(a.out)
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(analysis, f, ensure_ascii=False, allow_nan=False)
    journal(f"Écrit {a.out}.")
    return 0


# ---------------------------------------------------------------------------


def main() -> int:
    p = argparse.ArgumentParser(
        description="Détecte les corps et les frontières de plans sur un proxy."
    )
    # **Non requis quand --replay est donné.** Le rejeu ne décode ni ne détecte
    # rien : il relit un `analysis.json` déjà produit et une capture de scores
    # de scène, voir plus bas. La validation qui les rend obligatoires sinon
    # est faite à la main juste après `parse_args()`, parce qu'`argparse` ne
    # sait pas conditionner un `required` sur la valeur d'un autre argument.
    p.add_argument("--proxy", help="le proxy 960x540 à 30 im/s")
    p.add_argument("--out", required=True, help="le JSON à écrire")
    p.add_argument("--ffmpeg", help="le binaire de setup.sh (FFMPEG_BIN)")
    p.add_argument("--model", help="les poids YOLO, posés par setup.sh")
    p.add_argument(
        "--proxy-size",
        type=taille,
        help="LARGEURxHAUTEUR du proxy, relevé par Node avec ffprobe",
    )
    p.add_argument(
        "--source-size",
        type=taille,
        help="LARGEURxHAUTEUR de l'original — recopié tel quel dans le résultat",
    )
    p.add_argument("--duration", type=float, help="la durée du proxy, en secondes")
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
        help="le plancher de collecte : ffmpeg ne rapporte rien strictement en dessous de ce score",
    )
    p.add_argument(
        "--min-shot", type=float, default=1.0, help="durée minimale d'un plan, en secondes"
    )
    # Les quatre seuils des bascules de composition. **Arrêtés par balayage**
    # (256 combinaisons × 4 émissions du corpus, rejeu sans GPU ni ffmpeg via
    # `--replay` — voir docs/ratios-par-clip.md pour la grille et la méthode de
    # choix). Le plus grand `--switch-shift` qui referme le gisement mesuré sur
    # `entre-nous` sans régresser `cqlp`, `caro-mdlm` ni `nabla`.
    p.add_argument(
        "--switch-shift",
        type=float,
        default=0.08,
        help="déplacement collectif minimal, en fraction de la largeur, pour déclarer une bascule",
    )
    p.add_argument(
        "--switch-tolerance",
        type=float,
        default=0.03,
        help="tolérance d'appariement entre deux ancrages, en fraction de la largeur",
    )
    p.add_argument(
        "--switch-share",
        type=int,
        default=8,
        help="part de personnes appariées qui doit avoir bougé, en dixièmes (8 = 80 %%)",
    )
    p.add_argument(
        "--switch-point-score",
        type=float,
        default=0.3,
        help="confiance minimale d'un point de pose pour entrer dans l'ancrage d'une personne",
    )
    # Les trois seuils du **second** déclencheur, celui des ruptures de
    # composition. Arrêtés par balayage `--replay` sur le corpus, même méthode
    # que les quatre ci-dessus — voir docs/ratios-par-clip.md.
    p.add_argument(
        "--rupture-threshold",
        type=float,
        default=DEFAULT_RUPTURE_THRESHOLD,
        help="variation d'échelle ou d'assise minimale, en fraction, pour déclarer une rupture",
    )
    p.add_argument(
        "--rupture-min-score",
        type=float,
        default=DEFAULT_RUPTURE_MIN_SCORE,
        help="score de scène minimal pour qu'une rupture soit confirmée",
    )
    p.add_argument(
        "--rupture-box-score",
        type=float,
        default=DEFAULT_RUPTURE_BOX_SCORE,
        help="confiance minimale d'une boîte pour entrer dans le profil d'une image",
    )
    # **L'étalonnage sans GPU ni ffmpeg.** Les boîtes sont déjà dans un
    # `analysis.json` existant ; il ne manque que les scores de scène, une
    # passe ffmpeg qui ne touche pas au GPU (voir `scores_de_scène`) et se
    # capture une fois. `--replay` recalcule alors les frontières pour
    # n'importe quel jeu de seuils, en quelques secondes au lieu de quelques
    # minutes de détection. Voir docs/ratios-par-clip.md pour la commande
    # exacte de capture.
    p.add_argument(
        "--replay",
        metavar="ANALYSIS_JSON",
        help="rejoue le calcul des frontières depuis un analysis.json existant, sans GPU ni ffmpeg",
    )
    p.add_argument(
        "--scene-scores",
        metavar="FICHIER",
        help="la sortie brute de la passe ffmpeg de collecte, capturée une fois (requis avec --replay)",
    )
    a = p.parse_args()

    if a.replay is not None:
        return run_replay(a)

    if a.proxy is None or a.ffmpeg is None or a.model is None:
        journal("--proxy, --ffmpeg et --model sont requis hors de --replay.")
        return 2
    if a.proxy_size is None or a.source_size is None or a.duration is None:
        journal("--proxy-size, --source-size et --duration sont requis hors de --replay.")
        return 2
    if not os.path.isfile(a.proxy):
        journal(f"Proxy introuvable : {a.proxy}")
        return 2
    if not os.path.isfile(a.model):
        journal(f"Poids YOLO introuvables : {a.model}. Lancer ./setup.sh.")
        return 2
    if a.duration <= 0:
        journal(f"Durée invalide : {a.duration}. Elle est relevée par ffprobe côté Node.")
        return 2
    refus = refus_du_seuil_de_scène(
        a.scene_threshold,
        a.scene_floor,
        a.min_shot,
        a.switch_shift,
        a.switch_tolerance,
        a.switch_share,
        a.switch_point_score,
        a.rupture_threshold,
        a.rupture_min_score,
        a.rupture_box_score,
    )
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

    # --- [1/5] les scores de scène, sans toucher au GPU ----------------------
    # **Collecte, pas décision.** Avant le chantier des bascules de composition,
    # cette passe décidait aussi des frontières : les deux tenaient dans une
    # seule étape parce que rien d'autre ne consommait le score de scène. Les
    # bascules le consomment une seconde fois, à l'étape 4, une fois les boîtes
    # de personnes disponibles — d'où la scission : `évènements` reste vivant
    # jusque-là au lieu d'être jeté ici.
    journal(f"[1/5] Scores de scène (collecte, plancher {a.scene_floor})…")
    t0 = time.monotonic()
    évènements = scores_de_scène(a.ffmpeg, a.proxy, a.scene_floor)
    journal(f"      {len(évènements)} candidates, en {time.monotonic() - t0:.0f} s")

    # --- [2/5] le modèle -------------------------------------------------------
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

    journal(f"[2/5] Chargement de {os.path.basename(a.model)} sur {a.device}…")
    modèle = YOLO(a.model)

    # --- [3/5] les corps -------------------------------------------------------
    attendues = max(1, int(math.ceil(a.duration * a.fps)))
    journal(
        f"[3/5] Détection des corps ({attendues} images à {a.fps} im/s, "
        f"entrée {a.imgsz}, seuil {a.conf})…"
    )
    t0 = time.monotonic()
    boîtes: list[dict[str, float]] = []
    images_vues = 0
    images_sans_personne = 0
    # **Constaté sur les résultats, pas déduit du nom du fichier de poids.** Un
    # `yolo11m-pose.pt` recopié sous un autre nom, ou l'inverse, ferait mentir le
    # champ `keypoints` du résultat — et un consommateur qui s'y fie chercherait
    # des points qui ne sont pas là.
    pose = False
    lot: list = []
    dernier_rapport = t0

    # La demi-précision profite des cœurs tenseurs de la carte sans changer une
    # détection à ce seuil de confiance. Sur le processeur elle est plus lente,
    # d'où la condition. `quantize=16` et non `half=True` : ultralytics 8.4 a
    # remplacé le second, qui marche encore mais écrit un avertissement par lot
    # — soit trois cents lignes de bruit dans le journal d'une émission.
    quantification = 16 if a.device.startswith("cuda") else None

    def vider(lot: list, indice_départ: int) -> int:
        nonlocal images_sans_personne, pose
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
            if getattr(résultat, "keypoints", None) is not None:
                pose = True
        boîtes.extend(boîtes_du_lot(résultats, indice_départ, a.fps, largeur, hauteur))
        return len(lot)

    for image in flux_images(a.ffmpeg, a.proxy, a.duration, a.fps, largeur, hauteur):
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
        f"({images_vues / max(secondes, 1e-9):.0f} im/s), {len(boîtes)} boîtes"
        f"{' avec points de pose' if pose else ''}, "
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

    # --- [4/5] les frontières (scène + bascules) --------------------------------
    # Calcul pur, sans GPU. Trois sources de candidates, unies avant un seul
    # espacement : `--min-shot` ne se décline pas par source, voir
    # `_spaced_boundaries`.
    journal(f"[4/5] Frontières (scène ≥ {a.scene_threshold}, bascules)…")
    t0 = time.monotonic()
    scene_boundary_times = _scene_candidates(évènements, a.scene_threshold)

    switch_candidates = composition_switches(
        boîtes, a.fps, a.switch_point_score, a.switch_tolerance, a.switch_share, a.switch_shift
    )
    switch_boundary_times, rejected_count = confirmed_switches(
        switch_candidates, évènements, a.fps
    )
    rupture_candidates = _without(
        composition_ruptures(boîtes, a.fps, a.rupture_box_score, a.rupture_threshold),
        switch_candidates,
    )
    rupture_boundary_times, rupture_rejected = confirmed_switches(
        rupture_candidates, évènements, a.fps, a.rupture_min_score
    )

    boundaries = _spaced_boundaries(
        [*scene_boundary_times, *switch_boundary_times, *rupture_boundary_times],
        a.duration,
        a.min_shot,
    )
    découpe = shots_from_boundaries(boundaries, a.duration)

    rejected_rate = rejected_count / len(switch_candidates) if switch_candidates else 0.0
    journal(
        f"      {len(découpe)} plans, {len(boundaries)} frontières ({len(scene_boundary_times)} "
        f"scène sur {len(évènements)} candidates ≥ {a.scene_floor}, {len(switch_boundary_times)} "
        f"bascules retenues sur {len(switch_candidates)} candidates, {rejected_count} rejetées "
        f"faute de score de scène ({100 * rejected_rate:.0f} %), "
        f"{len(rupture_boundary_times)} ruptures retenues sur {len(rupture_candidates)} "
        f"candidates, {rupture_rejected} rejetées), en "
        f"{time.monotonic() - t0:.0f} s"
    )

    # --- [5/5] l'écriture --------------------------------------------------------
    journal(f"[5/5] Écriture de {a.out}…")
    dossier = os.path.dirname(a.out)
    if dossier:
        os.makedirs(dossier, exist_ok=True)
    # **La version monte parce que la forme change**, et le lecteur refuse ce
    # qu'il ne connaît pas plutôt que d'analyser à moitié. Un fichier de version 2
    # peut porter des points de pose ; `keypoints` dit s'il en porte, et il le dit
    # au lieu de laisser chaque lecteur parcourir trente mille boîtes pour le
    # découvrir. Le modèle est écrit à côté : deux familles de poids produisent
    # désormais ce fichier, et savoir laquelle l'a écrit se paie sinon en
    # relançant le GPU pour comparer.
    analysis = {
        "version": 2,
        "fps": a.fps,
        "model": os.path.basename(a.model),
        "source": {"w": source_l, "h": source_h},
        "proxy": {"w": largeur, "h": hauteur},
        "shots": découpe,
        "boxes": boîtes,
    }
    if pose:
        analysis["keypoints"] = "coco17"
    # `allow_nan=False` : un flottant non fini écrirait un littéral `NaN` que
    # `JSON.parse` refuse, donc une analyse illisible qu'aucune étape n'aurait
    # signalée. `flatten_keypoints` neutralise déjà le cas connu ; ceci ferme
    # tous les autres, et il vaut mieux échouer ici qu'à la lecture.
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(analysis, f, ensure_ascii=False, allow_nan=False)

    journal(
        f"Écrit {a.out} : {len(découpe)} plans, {len(boîtes)} boîtes sur {images_vues} images, "
        f"en {time.monotonic() - départ:.0f} s."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
