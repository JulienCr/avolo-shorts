import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { DEFAULT_CAPTION_STYLE, renderAss, type CaptionStyle } from '@/core/captions/ass'
import { splitIntoCards } from '@/core/captions/cards'
import { retimeWords } from '@/core/captions/retime'
import { clipDuration, type Clip, type ClipStatus, type Ratio, type Segment } from '@/core/edl'
import { blurredVariantArgs, renderArgs } from '@/core/ffmpeg/args'
import type { EncoderName } from '@/core/ffmpeg/encoder'
import { cropRect, outputSize, resolveRatio } from '@/core/framing'
import type { Word } from '@/core/transcript'
import { getClip, getDb, getProject, putClip } from '@/server/db'
import {
  cheminTemporaire,
  encoderName,
  produireArtefact,
  type Avancement,
} from '@/server/ffmpeg'
import { probe } from '@/server/ffprobe'
import { placeSidecar, rendersDir, stagedPath } from '@/server/paths'
import { lireTranscript } from '@/server/steps/candidates'

/**
 * L'export : d'une EDL en base au MP4 que Julien publie.
 *
 * C'est l'étape qui referme la chaîne, et **le piège y est un seul** (spec §11) :
 * après les coupes internes, les horodatages du transcript ne désignent plus rien
 * de ce que le spectateur voit. Un mot prononcé à 2874,1 s dans l'émission
 * apparaît à 15,7 s dans un clip dont le premier segment dure 15,7 s. Tout ce
 * fichier se contente d'enchaîner des fonctions déjà écrites ailleurs — sauf ce
 * point-là, qui ne lève aucune erreur quand on le rate, ne casse aucun test de
 * durée, et ne se voit qu'à l'œil sur un rendu.
 *
 * Le partage des rôles est le même que partout dans `src/server/steps/` : les
 * argv viennent de `core/ffmpeg/args.ts`, la géométrie de `core/framing.ts`, les
 * sous-titres de `core/captions/`. Ici on lit le disque, on choisit l'encodeur,
 * on lance, et on écrit.
 */

/** Les deux sorties possibles, pour distinguer l'avancement de l'une et de l'autre. */
export type SortieRendu = 'natif' | '9x16'

export type AvancementRendu = Avancement & { sortie: SortieRendu }

/** Ce que `renderClip` rend à son appelant — la route d'export, en itération 0. */
export type RenderResult = {
  /** Le rendu au ratio du clip. Toujours produit. */
  mp4: string
  /**
   * La variante 9:16 sur fond flouté, ou `null` quand le clip est **déjà** en
   * 9:16 et qu'elle serait une copie du fichier précédent.
   */
  variant9x16: string | null
  /** Le `.txt` : titre, description, mots-dièse. */
  texts: string
  /** Vrai si toutes les sorties étaient déjà là et que `force` ne les visait pas. */
  skipped: boolean
}

export type OptionsRendu = {
  db?: Database.Database
  /** Refaire même si les sorties sont là. */
  force?: boolean
  /**
   * Le preset de sous-titres. **Un preset personnalisé doit passer entier** :
   * `renderAss` ne lit ni `maxChars` ni `maxDuration`, c'est `splitIntoCards`
   * qui les applique, et cette fonction les lui passe depuis ce même objet.
   */
  style?: CaptionStyle
  /** L'encodeur, si on ne veut pas celui que l'environnement désigne. */
  encoder?: EncoderName
  onProgress?: (avancement: AvancementRendu) => void
  /** Le dossier des marques. Les tests en passent un jetable. */
  brandDir?: string
  /** Le dossier des polices embarquées. Idem. */
  fontsDir?: string
}

/**
 * Les quatre chemins d'un clip. `variant9x16` vaut `null` quand le clip est déjà
 * en 9:16 : la variante à fond flouté n'existe que pour porter un 4:5 ou un 1:1
 * sur TikTok et Shorts : sur un clip déjà en 9:16, elle serait le même cadre
 * rendu une seconde fois (spec §11).
 *
 * Le `.ass` est un **intermédiaire** : il est réécrit à chaque passage et ne
 * compte pas dans la décision de saut. Il reste sur le disque exprès — c'est le
 * seul moyen de relire ce que libass a incrusté quand un sous-titre surprend.
 */
export type CheminsRendu = {
  mp4: string
  variant9x16: string | null
  texts: string
  ass: string
}

/**
 * Le garde-fou de traversée de répertoire sur l'identifiant de clip.
 *
 * `projectId` en a déjà un — `vérifierId`, privé à `paths.ts` — et `clipId` n'en
 * avait aucun : il entrait tel quel dans quatre `path.join`. Or il arrive du
 * réseau, `POST /api/clips/:id/export` le prend dans l'URL, et `putClip` ne
 * valide ni son format ni son contenu. Un `../` y suffisait à faire écrire le
 * MP4, l'ASS et le TXT hors du dossier du projet — `écrireFichier` créant au
 * passage les dossiers intermédiaires. (relevé par Aristarque)
 *
 * **C'est délibérément une copie de `vérifierId` et non son partage.** Ce dernier
 * est privé à `paths.ts`, qui appartient à une autre tâche en cours d'écriture ;
 * l'exporter depuis ici ferait toucher deux agents au même fichier pour une
 * fonction de six lignes. La règle, elle, est la même, et elle est volontairement
 * permissive sur les caractères — les noms de replays portent accents et
 * espaces — et stricte sur la seule chose qui compte.
 */
function vérifierClipId(clipId: string): string {
  const refusé =
    clipId === '' ||
    clipId === '.' ||
    clipId === '..' ||
    clipId.includes('/') ||
    clipId.includes('\\') ||
    clipId.includes('\0')
  if (refusé) {
    throw new Error(`Identifiant de clip invalide : ${JSON.stringify(clipId)}`)
  }
  return clipId
}

/**
 * Le nom de la variante, **due ou non**.
 *
 * Séparé de `cheminsRendu` parce qu'il sert aussi à effacer celle d'un ratio
 * abandonné : un clip repassé de 1:1 à 9:16 n'a plus de variante à produire, et
 * l'ancienne resterait sur le disque à ressembler à une livraison à jour.
 * (relevé par Copilot)
 */
function cheminVariante(projectId: string, clipId: string): string {
  return path.join(rendersDir(projectId), `${vérifierClipId(clipId)}-9x16.mp4`)
}

export function cheminsRendu(projectId: string, clipId: string, ratio: Ratio): CheminsRendu {
  const dossier = rendersDir(projectId)
  const nom = vérifierClipId(clipId)
  return {
    mp4: path.join(dossier, `${nom}.mp4`),
    variant9x16: ratio === '9:16' ? null : cheminVariante(projectId, nom),
    texts: path.join(dossier, `${nom}.txt`),
    ass: path.join(dossier, `${nom}.ass`),
  }
}

/**
 * La décision de saut, isolée et pure — `existe` est passé en argument, donc elle
 * se teste sans toucher au disque.
 *
 * **Les trois sorties comptent, pas seulement le MP4.** Un rendu interrompu juste
 * après l'encodage laisse le MP4 en place sans son `.txt` ni sa variante ; ne
 * regarder que le premier fichier ferait passer ce clip pour exporté et Julien
 * publierait sans description. Le graphe de l'itération 0 décide sur la présence
 * du fichier (spec §4), donc la présence doit couvrir tout ce que l'étape promet.
 */
export function sauterLeRendu(
  chemins: CheminsRendu,
  existe: (chemin: string) => boolean,
  force = false,
): boolean {
  if (force) return false
  return [chemins.mp4, chemins.variant9x16, chemins.texts].every(
    (chemin) => chemin === null || existe(chemin),
  )
}

/**
 * Faut-il rallumer ffmpeg — et si oui, **pour les deux sorties, jamais une
 * seule**.
 *
 * Pure comme `sauterLeRendu`, et elle répond à la question d'après : la première
 * dit si l'appel a encore quelque chose à faire, celle-ci si ce quelque chose est
 * un encodage. Les deux se séparent sur un seul cas, celui du `.txt` perdu ou
 * retouché alors que les MP4 sont là : il se réécrit sans réencoder une image.
 *
 * **Refaire une seule des deux sorties n'est jamais bon**, et c'est le corollaire
 * du correctif de #22 : la variante ne dérive plus du MP4 natif, elle se rend
 * depuis la source avec l'instantané du clip qu'on lui donne. La refaire seule —
 * natif en place, variante perdue par un encodage interrompu — la tirerait donc
 * du montage d'aujourd'hui pendant que le natif porte celui d'avant-hier, dès
 * lors que le clip a été retouché entre les deux passages. Rien ne le
 * rattraperait : `écarterRenduPérimé` compare le montage à celui du **début de ce
 * passage-ci**, pas à celui du précédent, et les deux fichiers partiraient chez
 * Julien en montrant deux cadres différents, sans un mot.
 * (relevé par Codex et Copilot)
 *
 * Ce que ça coûte le jour où le cas se présente : réencoder un natif qui était
 * là, mesuré à 3,85 s sur un clip de 43 s (`docs/environnement.md`). Ce que ça
 * garantit : les deux fichiers d'un clip sortent toujours du même montage.
 */
export function refaireLesSorties(
  chemins: CheminsRendu,
  existe: (chemin: string) => boolean,
  force = false,
): boolean {
  if (force) return true
  return !existe(chemins.mp4) || (chemins.variant9x16 !== null && !existe(chemins.variant9x16))
}

/**
 * Le haut de la bande de marque, en fraction de la hauteur du clip.
 *
 * **C'est le bord SUPÉRIEUR, jamais le centre**, et c'est toute la doctrine
 * reprise de `branding.py:63-70` d'openshorts (spec §15). La hauteur de la bande
 * dépend du rapport d'aspect du logo, que l'opérateur choisit : ancrer le centre
 * laisse un lockup plus haut remonter vers le bord de l'image. Mesuré là-bas, à
 * 0,13 un logo 3:1 ancré par son centre remettait son bord supérieur à 0,109,
 * c'est-à-dire sous la barre d'onglets de TikTok.
 *
 * La contrainte est en haut, donc c'est le haut qu'on épingle.
 */
const HAUT_DE_BANDE = 0.13

/** La marge latérale, en fraction de la largeur du clip. */
const MARGE = 0.05

/**
 * Le plafond de hauteur d'une marque, en fraction de la hauteur du clip, et
 * **appliqué par marque, pas à la bande entière**.
 *
 * Les largeurs sont une fraction de la LARGEUR du clip, ce qui est le bon axe
 * pour juger de la taille apparente d'une marque — mais c'est la hauteur qui
 * mange la bande, et les deux ne sont reliées que par le rapport d'aspect du
 * cadre *et* de l'image, dont aucun ne nous appartient : le ratio se choisit par
 * clip (9:16, 4:5, 1:1, 16:9) et le logo appartient à l'opérateur. Sans plafond,
 * un logo 3:1 à 22 % de largeur fait 4,1 % de la hauteur d'un 9:16 et 13 % de
 * celle d'un 16:9.
 *
 * Mise à l'échelle plutôt que refus : une marque un peu plus petite reste une
 * marque, alors qu'un refus sur un export paysage ne donnerait pas de marque du
 * tout.
 */
const PLAFOND_HAUTEUR = 0.06

/**
 * En dessous, une marque réduite cesse d'être lisible sur un téléphone. Un très
 * petit clip reçoit donc une marque proportionnellement plus grande plutôt
 * qu'illisible — et le plafond ci-dessus l'emporte quand même sur ce plancher :
 * une marque trop petite est un défaut cosmétique, une marque imprimée sous la
 * barre d'interface est un cadre raté.
 */
const LARGEUR_MINIMALE = 80

/**
 * Ce que le dossier des marques peut porter, et à quelle largeur.
 *
 * Le logo est plus étroit que le filigrane d'openshorts (0,30) parce qu'il ne
 * cherche pas à être difficile à recadrer ; la mention Twitch l'est encore plus —
 * c'est une adresse, pas une signature. Les deux sont facultatives, et chacune se
 * rend seule.
 */
const MARQUES_ATTENDUES: readonly { fichier: string; largeurRatio: number; bord: Bord }[] = [
  { fichier: 'logo.png', largeurRatio: 0.22, bord: 'gauche' },
  { fichier: 'twitch.png', largeurRatio: 0.16, bord: 'droite' },
]

type Bord = 'gauche' | 'droite'

/** Une marque trouvée sur le disque, avec sa taille native. */
export type MarqueNative = {
  path: string
  nativeW: number
  nativeH: number
  largeurRatio: number
  bord: Bord
}

/** Une marque placée, dans la forme que `renderArgs` attend pour ses `logos`. */
export type PlacementMarque = { path: string; x: number; y: number; w: number; h: number }

/** Le pair immédiatement inférieur, jamais sous 2. */
function pair(n: number): number {
  return Math.max(2, Math.floor(n / 2) * 2)
}

/**
 * Pose les marques sur la bande. **Pure : aucune entrée-sortie**, donc testable
 * en CI sans image et sans ffmpeg.
 *
 * Les hauteurs sont calculées ici plutôt que laissées à un `scale=W:-1` de
 * ffmpeg, pour deux raisons : le plan et le graphe de filtres ne peuvent alors
 * pas diverger, et le centrage vertical ci-dessous a de toute façon besoin des
 * hauteurs.
 *
 * **La bande pend du bord supérieur** : la marque la plus haute pose son bord
 * supérieur exactement à `HAUT_DE_BANDE`, et les autres sont centrées sur elle.
 * Deux passes sont nécessaires, puisque cette ligne médiane n'est connue qu'une
 * fois toutes les hauteurs calculées. Centrer plutôt que partager un bord
 * supérieur compte dès que les rapports d'aspect diffèrent — un logo carré à côté
 * d'une mention large —, et un bord partagé rendrait la ligne visiblement
 * bancale.
 *
 * Les dimensions sortent **paires**. Le PNG arrive en RGBA et se superpose à du
 * yuv420p : la négociation de format de libavfilter peut poser un
 * sous-échantillonnage de chrominance au passage, qui ne tolère pas une dimension
 * impaire. C'est la même garde que `cropRect`, pour la même raison, et elle coûte
 * un pixel sur deux cent trente-sept.
 */
export function planifierMarques(
  clipW: number,
  clipH: number,
  marques: readonly MarqueNative[],
): PlacementMarque[] {
  if (marques.length === 0) return []

  const marge = Math.round(clipW * MARGE)
  const espace = pair(clipW - 2 * marge)
  const plafond = clipH * PLAFOND_HAUTEUR

  const dimensionnées = marques.map((m) => {
    let w = Math.max(LARGEUR_MINIMALE, Math.round(clipW * m.largeurRatio))
    // Jamais plus large que l'espace entre les marges : sur un cadre très étroit,
    // le plancher de lisibilité ferait sinon déborder la marque hors de l'image.
    w = Math.min(w, espace)
    let h = Math.max(1, Math.round((w * m.nativeH) / m.nativeW))
    // **Chaque marque est ramenée sous le plafond pour elle seule.** Mettre toute
    // la bande à l'échelle de l'excès de la plus haute a été essayé chez
    // openshorts et vaut moins : cela garde les tailles relatives, mais un logo
    // carré entraîne alors la mention avec lui — relevé là-bas à 83x19 sur un
    // 1080x1920, illisible sur un téléphone. Seule la marque qui casse la bande a
    // besoin de rétrécir.
    if (h > plafond) {
      w = Math.max(1, Math.round((w * plafond) / h))
      h = plafond
    }
    return { path: m.path, bord: m.bord, w: pair(w), h: pair(h) }
  })

  const hautDeBande = Math.round(clipH * HAUT_DE_BANDE)
  const médiane = hautDeBande + Math.max(...dimensionnées.map((d) => d.h)) / 2

  return dimensionnées.map((d) => ({
    path: d.path,
    w: d.w,
    h: d.h,
    x: Math.max(0, d.bord === 'gauche' ? marge : clipW - marge - d.w),
    y: Math.max(0, Math.round(médiane - d.h / 2)),
  }))
}

/** `assets/brand/` à la racine du dépôt. Ignoré par git : les marques sont à l'opérateur. */
function dossierDesMarques(donné?: string): string {
  return donné ?? path.join(process.cwd(), 'assets', 'brand')
}

/** `fonts/`, où vit Anton — la police du preset de sous-titres par défaut. */
function dossierDesPolices(donné?: string): string {
  return donné ?? path.join(process.cwd(), 'fonts')
}

/**
 * Les marques réellement présentes, avec leur taille native.
 *
 * **Elle constate, elle ne juge pas** : un dossier vide rend une liste vide, et
 * c'est tout. Ce qu'il faut en conclure dépend du clip — `branding` dit s'il en
 * demande —, et cette décision-là est à `refuserFauteDeMarque`, juste dessous.
 * Lui passer l'intention du clip l'obligerait à la connaître pour lire deux
 * fichiers, et le dossier vide d'un dépôt fraîchement cloné n'a de sens qu'au
 * regard de ce qu'on lui demande. (#37)
 *
 * La taille native se lit par ffprobe plutôt qu'en analysant l'en-tête du
 * fichier : le binaire est déjà là, il est déjà appelé par l'ingestion, et il
 * accepte tout ce que ffmpeg saura ensuite décoder — ce qui est exactement la
 * bonne définition de « ce fichier convient ».
 */
export async function collecterMarques(brandDir?: string): Promise<MarqueNative[]> {
  const dossier = dossierDesMarques(brandDir)
  const trouvées: MarqueNative[] = []
  for (const attendue of MARQUES_ATTENDUES) {
    const chemin = path.join(dossier, attendue.fichier)
    if (!fs.existsSync(chemin)) continue
    const { width, height } = await probe(chemin)
    if (width === null || height === null || width <= 0 || height <= 0) {
      console.warn(`Marque illisible, ignorée : ${chemin}`)
      continue
    }
    trouvées.push({
      path: chemin,
      nativeW: width,
      nativeH: height,
      largeurRatio: attendue.largeurRatio,
      bord: attendue.bord,
    })
  }
  return trouvées
}

/**
 * Le clip demandait des marques, le dossier n'en portait aucune : on refuse.
 *
 * C'est le correctif de #37, et il tient tout entier dans le choix de **fonder
 * la règle sur une intention déjà exprimée** plutôt que sur une heuristique. Un
 * dossier vide n'est en soi ni normal ni anormal : il l'est sur un dépôt
 * fraîchement cloné, il ne l'est pas sur la machine de l'opérateur, et rien dans
 * le dossier ne permet de trancher — `assets/brand/` est toujours *présent*,
 * son `README.md` étant versionné. Le clip, lui, sait ce qu'il veut.
 *
 * **Une seule marque suffit, et c'est délibéré.** Le logo et la mention sont
 * facultatifs chacun de son côté — voir `MARQUES_ATTENDUES` et le README du
 * dossier —, si bien que rien ne distingue « l'opérateur n'a qu'un logo » de
 * « la mention a disparu ». Refuser là interdirait une installation soutenue
 * pour rattraper une dégradation indécidable. Zéro, lui, ne se confond avec
 * rien : la marque a été demandée, aucune n'est posée, et le fichier partirait
 * sur Instagram sans elle.
 */
export function refuserFauteDeMarque(
  branding: boolean,
  marques: readonly MarqueNative[],
): boolean {
  return branding && marques.length === 0
}

/** Les mots-dièse d'un texte, dédoublonnés sans tenir compte de la casse. */
export function motsDièse(texte: string): string[] {
  const vus = new Set<string>()
  const sortie: string[] = []
  for (const trouvé of texte.matchAll(/#[\p{L}\p{N}_]+/gu)) {
    const clé = trouvé[0].toLowerCase()
    if (vus.has(clé)) continue
    vus.add(clé)
    sortie.push(trouvé[0])
  }
  return sortie
}

/**
 * Le `.txt` qui accompagne le MP4 : titre, description, mots-dièse.
 *
 * Ce fichier est fait pour être **copié**, pas analysé : trois sections nommées,
 * dans l'ordre où on les colle. Il servait à publier à la main, la publication
 * étant hors périmètre ; elle y est entrée le 18 août 2026
 * (`docs/superpowers/specs/2026-08-18-publication-reseaux-design.md`), et le
 * `.txt` reste pour les réseaux qu'on ne branche pas et pour le rattrapage quand
 * une plateforme refuse. **Il n'est pas la source des textes publiés** : ceux-ci
 * se dérivent du clip, par plateforme, et non de ce rendu-ci.
 *
 * **Les mots-dièse ne sont pas retirés de la description**, ils en sont extraits.
 * Le prompt de détail demande au modèle « une description puis 3 à 5 mots-dièse »
 * en un seul champ, et cette description est ce qui se colle tel quel dans le
 * formulaire d'Instagram ; la section du bas n'existe que pour les reprendre
 * ailleurs sans les retaper. Les amputer de la description rendrait le champ
 * principal faux pour gagner une redite.
 */
export function texteDePublication(clip: Clip): string {
  const titre = clip.title.trim()
  const description = clip.description.trim()
  const dièses = motsDièse(`${titre}\n${description}`)
  return [
    `Titre : ${titre === '' ? '(sans titre)' : titre}`,
    '',
    'Description :',
    description === '' ? '(sans description)' : description,
    '',
    `Mots-dièse : ${dièses.length === 0 ? '(aucun)' : dièses.join(' ')}`,
    '',
  ].join('\n')
}

/**
 * Écrit un fichier sous un nom temporaire puis le renomme.
 *
 * Le renommage est atomique sur un même système de fichiers : un processus tué en
 * pleine écriture ne laisse donc pas un `.txt` tronqué là où `sauterLeRendu` le
 * compterait comme une sortie faite. C'est ce que fait déjà `produireArtefact`
 * pour les MP4, et l'étape ne serait pas plus sûre que son maillon le plus
 * faible.
 */
async function écrireFichier(chemin: string, contenu: string): Promise<void> {
  await fsp.mkdir(path.dirname(chemin), { recursive: true })
  const temporaire = cheminTemporaire(chemin)
  try {
    await fsp.writeFile(temporaire, contenu, 'utf8')
    await fsp.rename(temporaire, chemin)
  } catch (cause) {
    await fsp.rm(temporaire, { force: true }).catch(() => {})
    throw cause
  }
}

/**
 * Les dimensions de la source. **Ni 1920x1080 supposé, ni repli du tout.**
 *
 * `cropRect` en dépend entièrement : sur une source 4K, un crop calculé pour du
 * 1080p découperait un rectangle du coin supérieur gauche. L'erreur ne lève rien,
 * ne se voit qu'à l'image, et coûte un export de trois minutes.
 *
 * Une première version supposait 1920x1080 quand ffprobe ne savait rien dire, ce
 * qui recréait précisément le défaut que cette fonction existe pour éviter :
 * aucun crop sûr ne se calcule sans dimensions, donc on échoue plutôt que de
 * livrer un cadrage plausible et faux. Les dimensions nulles ou négatives tombent
 * par le même chemin. (relevé par Copilot)
 */
async function dimensionsSource(src: string): Promise<{ w: number; h: number }> {
  const { width, height } = await probe(src)
  if (width === null || height === null || width <= 0 || height <= 0) {
    throw new Error(
      "ffprobe n'a pas su dire les dimensions de la copie de travail : sans elles, aucun " +
        'rectangle de crop ne peut être calculé, et en supposer suffirait à livrer un cadrage faux.',
    )
  }
  return { w: width, h: height }
}

/**
 * Rend un clip, et rend la main quand les fichiers sont sur le disque.
 *
 * L'ordre est celui de la spec §11, et deux points ne se déduisent pas de la
 * lecture du code :
 *
 * 1. **`retimeWords` avant tout découpage en cartons.** Les mots arrivent
 *    horodatés sur l'émission entière et doivent l'être sur le clip. C'est la
 *    seule ligne de cette fonction dont l'oubli ne casse rien de mesurable.
 * 2. **Le rendu part de l'original** — la copie de travail dans `stage/` —, jamais
 *    du proxy, qui est un 960x540 fait pour scruber.
 */
export async function renderClip(clipId: string, options: OptionsRendu = {}): Promise<RenderResult> {
  const db = options.db ?? getDb()
  const clip = getClip(db, clipId)
  if (clip === undefined) throw new Error(`Clip inconnu : ${clipId}`)

  const projet = getProject(db, clip.projectId)
  if (projet === undefined) {
    throw new Error(`Projet inconnu pour le clip ${clipId} : ${clip.projectId}`)
  }

  // `'auto'` n'est pas une géométrie, c'est une intention, et il ne doit jamais
  // atteindre `cropRect` : la table des ratios n'a pas cette clé. En itération 0
  // `resolveRatio` le rabat sur 9:16, et c'est le seul endroit du dépôt où cette
  // valeur par défaut est écrite.
  const ratio = resolveRatio(clip.ratio)
  const chemins = cheminsRendu(clip.projectId, clipId, ratio)

  // **L'EDL se valide avant la décision de saut**, et l'ordre compte : l'édition
  // autorise de vider un clip, et un clip vidé après un premier export a encore
  // ses fichiers. Le saut le rendrait alors `skipped: true` en le marquant
  // exporté, alors qu'il ne décrit plus rien. (relevé par Copilot)
  const durée = clipDuration(clip.segments)
  if (durée <= 0) {
    throw new Error(
      `Le clip ${clipId} ne porte aucun segment à rendre. Un clip est une liste de segments, et une liste vide n'a pas de durée.`,
    )
  }

  // **Le saut se décide avant de toucher au transcript.** Le sidecar vit sur le
  // Drive partagé, monté en 9p, lent et sujet au décrochage : un clip déjà rendu
  // ne doit pas payer un aller-retour dessus pour s'entendre dire qu'il n'y a
  // rien à faire.
  if (sauterLeRendu(chemins, (c) => fs.existsSync(c), options.force)) {
    // **Le `.txt` se réécrit même quand le rendu saute**, et c'est le seul des
    // trois à le faire. Il ne coûte rien, et c'est celui qu'on retouche le plus :
    // corriger une faute dans la description puis relancer l'export ne doit pas
    // exiger un `--force` qui réencoderait trois minutes de vidéo pour rien.
    // (relevé par Aristarque)
    await écrireFichier(chemins.texts, texteDePublication(clip))
    // La variante d'un ratio abandonné s'efface ici aussi. Le chemin non sauté le
    // fait déjà ; sans cela, un clip repassé en 9:16 dont les sorties sont
    // complètes garderait son ancienne variante alors que `RenderResult` annonce
    // qu'il n'y en a pas. (relevé par Aristarque)
    if (chemins.variant9x16 === null) {
      fs.rmSync(cheminVariante(clip.projectId, clipId), { force: true })
    }
    // **Le statut se répare ici aussi.** Un processus arrêté entre l'écriture du
    // `.txt` et la mise à jour du statut laisse toutes les sorties en place : la
    // relance sauterait, et le clip resterait en « kept » pour toujours sans que
    // rien ne puisse le rattraper. La présence des fichiers fait foi en itération
    // 0 (spec §4), donc elle vaut aussi pour le statut. (relevé par Copilot)
    marquerExporté(db, clipId, clip.status)
    return {
      mp4: chemins.mp4,
      variant9x16: chemins.variant9x16,
      texts: chemins.texts,
      skipped: true,
    }
  }

  // **L'encodeur se résout à l'appel, dans la fonction paresseuse.** `encoderName`
  // lève sur un `FFMPEG_ENCODER` inconnu — refus voulu, jamais un repli silencieux
  // — et le résoudre ici le ferait lever aussi sur un clip dont le MP4 est déjà
  // là. C'est la leçon relevée sur `buildProxy` : un artefact présent doit revenir
  // tout de suite, quoi que porte l'environnement.
  const encodeur = (): EncoderName => options.encoder ?? encoderName()

  // Vrai dès que ffmpeg a réellement produit le MP4 natif dans ce passage :
  // c'est lui qui décide du sort du `.ass` provisoire, dans le `finally`.
  let natifEncodé = false

  // **Les deux sorties se rendent depuis la source, avec les mêmes arguments, et
  // elles se refont ensemble.** La variante partait du MP4 natif ; elle en
  // héritait alors les sous-titres dans son fond flouté (#22). Elle a donc besoin
  // de tout ce que le natif consomme — le transcript, le rectangle de crop, les
  // marques — et de l'instantané du clip qui a servi au natif : voir
  // `refaireLesSorties`, qui porte le raisonnement.
  //
  // **On ne prépare que ce qu'un encodage va vraiment consommer.** Un passage
  // interrompu juste après l'encodage laisse les MP4 sans leur `.txt` : cette
  // reprise-là n'a rien à faire du transcript, qui vit sur le Drive et coûte un
  // aller-retour en 9p, ni des trois sondages ffprobe.
  if (refaireLesSorties(chemins, (c) => fs.existsSync(c), options.force)) {
    // La copie de travail, pas le Drive. Elle est transitoire par contrat — voir
    // `stagedPath` — donc son absence se répare en réingérant, et le dire vaut
    // mieux que retomber sur un montage 9p qui peut geler la boucle d'événements.
    const src = projet.stagedPath ?? stagedPath(projet.sourcePath)
    if (!fs.existsSync(src)) {
      throw new Error(
        `La copie de travail du projet ${clip.projectId} est absente. Le rendu part de l'original, ` +
          "jamais du proxy : relancer l'ingestion pour la reconstituer.",
      )
    }

    // **La porte des marques, et elle est ici pour deux raisons.** Avant tout ce
    // qui coûte : la lecture du transcript traverse le Drive en 9p, l'encodage
    // dure de dix secondes à une minute, et `POST /api/clips/:id/export` est
    // synchrone — personne n'attend une minute pour apprendre qu'il manquait un
    // PNG de quarante kilo-octets. Et après la copie de travail : sans source il
    // n'y a rien à cadrer, là où une marque absente est un défaut de la
    // livraison et non de l'entrée.
    //
    // **Rien de tout cela sur le chemin du saut**, plus haut, qui n'encode pas :
    // y refuser ferait échouer une relance qui se contente de réécrire un
    // `.txt`. Un clip exporté sans marque avant #37 saute donc pour toujours, et
    // c'est `force` qui le rattrape.
    //
    // Le dossier ne se lit que si le clip en veut : un clip sans marque n'a pas à
    // payer deux `existsSync` et deux sondages.
    const marques = clip.branding ? await collecterMarques(options.brandDir) : []
    if (refuserFauteDeMarque(clip.branding, marques)) {
      // **« Aucune exploitable » et non « aucune présente ».** `probe` ne lève
      // jamais : un PNG corrompu, comme un ffprobe absent, rend un sondage vide
      // et `collecterMarques` écarte la marque en le journalisant. Dire que le
      // dossier est vide serait alors faux, et enverrait chercher un fichier qui
      // est là.
      throw new Error(
        `Le clip ${clipId} demande des marques et aucune n'est exploitable : ni ` +
          `${MARQUES_ATTENDUES.map((m) => m.fichier).join(' ni ')} — absentes, ou illisibles et ` +
          `alors signalées au journal. L'export livrerait un MP4 sans logo sans un mot, et le rendu ` +
          `est la dernière étape avant publication. Déposer au moins l'une d'elles dans ` +
          `assets/brand/ (son README dit le format), ou passer branding à false sur ce clip.`,
      )
    }

    const style = options.style ?? DEFAULT_CAPTION_STYLE
    // **Le `.ass` s'écrit d'abord sous un nom temporaire.** Il est gardé sur le
    // disque pour relire ce que libass a incrusté, et `produireArtefact` conserve
    // l'ancien MP4 quand ffmpeg échoue : écrire directement sur le nom définitif
    // laisserait, après un rendu forcé raté, l'ASS d'une tentative qui n'a rien
    // produit à côté d'une vidéo d'avant. Le sidecar ne bouge qu'une fois le MP4
    // en place. (relevé par Copilot)
    const assProvisoire = clip.captions
      ? await écrireSousTitres(clip, cheminTemporaire(chemins.ass), projet, style)
      : undefined
    // Le dossier de polices n'a de sens qu'avec un `.ass` à incruster : le
    // chercher sans cela ferait avertir sur un clip qui n'a pas de sous-titres.
    const fontsDir =
      assProvisoire === undefined ? undefined : dossierDesPolicesUtilisable(options.fontsDir)

    try {
      const taille = await dimensionsSource(src)
      const crop = cropRect(ratio, clip.cropX, taille.w, taille.h)
      const out = outputSize(ratio)

      const logos = planifierMarques(out.w, out.h, marques)

      // Ce que les deux sorties ont en commun, c'est-à-dire tout sauf la mise
      // en page : mêmes segments, même rectangle, mêmes sous-titres, mêmes
      // marques. Les partager dans un seul objet est ce qui garantit que les
      // deux fichiers montrent le même cadre.
      const commun = {
        src,
        segments: clip.segments,
        crop,
        out,
        assPath: assProvisoire,
        fontsDir,
        logos,
      }

      // **La variante périmée s'efface avant le PREMIER encodage**, et non entre
      // les deux. Elle ne décrit déjà plus le montage qu'on est en train de
      // rendre ; la laisser le temps du natif ouvre une fenêtre où un arrêt
      // brutal — coupure, tueur de mémoire — laisse l'ancienne 9:16 à côté d'un
      // natif tout neuf, et la relance suivante, sans `force`, trouve les trois
      // sorties présentes et saute définitivement sur cette paire incohérente.
      // Effacée d'abord, n'importe quelle interruption laisse une sortie
      // manquante, donc réessayable. (relevé par Copilot)
      const variante = chemins.variant9x16
      if (variante !== null) fs.rmSync(variante, { force: true })

      await produireArtefact({
        dst: chemins.mp4,
        // `true` et non `options.force` : la décision est prise au-dessus, une
        // fois pour les deux sorties. La laisser se reprendre ici ferait sauter
        // un natif présent dont la variante manque, et la paire repartirait de
        // deux montages. (relevé par Codex et Copilot)
        force: true,
        durationSec: durée,
        onProgress: (a) => options.onProgress?.({ ...a, sortie: 'natif' }),
        quoi: `rendu ${ratio} du clip ${clipId}`,
        args: (destination) => renderArgs({ ...commun, dst: destination, encoder: encodeur() }),
      })
      // `produireArtefact` ne peut pas sauter avec `force: true` : arriver ici,
      // c'est que le MP4 natif vient d'être écrit, donc que le `.ass` provisoire
      // décrit bien la vidéo posée sur le disque.
      natifEncodé = true

      // **La variante suit le natif, toujours** : ils décrivent le même montage,
      // et un natif réencodé alors que la variante est restée en place laisserait
      // deux fichiers qui ne racontent plus la même chose — l'appel suivant, les
      // trouvant tous les deux, sauterait sans un mot. (relevé par Aristarque)
      if (variante !== null) {
        await produireArtefact({
          dst: variante,
          force: true,
          durationSec: durée,
          onProgress: (a) => options.onProgress?.({ ...a, sortie: '9x16' }),
          quoi: `variante 9:16 du clip ${clipId}`,
          args: (destination) =>
            blurredVariantArgs({ ...commun, dst: destination, encoder: encodeur() }),
        })
      }
    } finally {
      // Le sidecar définitif suit le MP4, et seulement lui : un rendu raté laisse
      // en place celui qui décrit la vidéo réellement posée sur le disque.
      if (natifEncodé) {
        if (assProvisoire === undefined) fs.rmSync(chemins.ass, { force: true })
        else await fsp.rename(assProvisoire, chemins.ass)
      } else if (assProvisoire !== undefined) {
        await fsp.rm(assProvisoire, { force: true }).catch(() => {})
      }
    }
  }

  // Un clip repassé de 1:1 à 9:16 n'a plus de variante à produire, et l'ancienne
  // resterait à côté du nouveau MP4 en ressemblant à une livraison à jour — alors
  // que `RenderResult` annonce qu'il n'y en a pas. (relevé par Copilot)
  if (chemins.variant9x16 === null) {
    fs.rmSync(cheminVariante(clip.projectId, clipId), { force: true })
  }

  // **Le titre et la description se relisent en base, pour la même raison que le
  // statut.** `clip` est l'instantané d'avant l'encodage, qui a duré des minutes :
  // écrire le `.txt` depuis lui livrerait la description que l'utilisateur vient
  // de corriger pendant ce temps. Le repli sur l'instantané ne sert qu'au clip
  // supprimé en cours de route, dont les fichiers méritent quand même leur texte.
  await écrireFichier(chemins.texts, texteDePublication(getClip(db, clipId) ?? clip))

  // **Le montage a-t-il bougé pendant l'encodage ?** Si oui, les fichiers qu'on
  // vient de produire décrivent un cadre que personne ne veut plus : on les
  // retire et on échoue franchement, plutôt que de les laisser sur le disque où
  // l'export suivant les prendrait pour bons. C'est le prix d'un modèle où la
  // présence du fichier fait foi.
  if (écarterRenduPérimé(db, clipId, chemins, clip)) {
    throw new Error(
      `Le clip ${clipId} a été modifié pendant son export : les fichiers produits décrivaient le montage d'avant et ont été écartés. Relancer l'export.`,
    )
  }

  // Le statut ne bouge qu'une fois les fichiers sur le disque : le poser avant
  // l'encodage protégerait un clip qui n'existe pas.
  marquerExporté(db, clipId, clip.status)

  return {
    mp4: chemins.mp4,
    variant9x16: chemins.variant9x16,
    texts: chemins.texts,
    skipped: false,
  }
}

/**
 * Passe le clip en `exported`, **par son identifiant et jamais par un
 * instantané**.
 *
 * `exported` est un statut humain au sens de `mergeCandidates` : il fait survivre
 * le clip à une nouvelle passe de repérage.
 *
 * La signature est le correctif, et elle mérite d'être lue comme tel. Un export
 * dure des minutes, l'interface écrit dans la même base pendant ce temps, et
 * `renderClip` tient un clip lu avant son premier `await`. Réécrire cet
 * instantané pour changer une seule colonne rendrait au clip ses segments, son
 * ratio, son cadrage et son titre d'avant l'export — un montage effacé sans un
 * mot. Prendre un `clipId` rend le défaut impossible à réintroduire par
 * distraction. (relevé par Codex)
 *
 * `statutAuRendu` est le statut lu au début de l'export, et il ne sert qu'à
 * reconnaître une décision prise depuis — voir plus bas.
 *
 * `better-sqlite3` est synchrone : rien de ce processus ne s'intercale entre la
 * relecture et l'écriture. Et un clip supprimé pendant le rendu n'est pas
 * ressuscité, puisqu'on n'écrit que ce qu'on vient de lire.
 */
export function marquerExporté(
  db: Database.Database,
  clipId: string,
  statutAuRendu: ClipStatus,
): void {
  const àJour = getClip(db, clipId)
  if (àJour === undefined) return
  if (àJour.status === 'exported') return
  // **Toute décision prise pendant l'encodage l'emporte.** L'écart de statut est
  // la seule chose à regarder, et il couvre tout ce que l'interface offre :
  // écarter le clip, ou rappuyer sur « Gardé », qui le ramène à `candidate`
  // (`src/lib/clip-status.ts`). Un export commencé et fini sous le même statut
  // passe à `exported` ; tout le reste est une main humaine qui a bougé après
  // qu'on a lu le clip, et une main humaine gagne contre un statut de machine.
  // (relevé par Copilot)
  if (àJour.status !== statutAuRendu) {
    console.warn(
      `Clip ${clipId} : passé de « ${statutAuRendu} » à « ${àJour.status} » pendant l'export. Les fichiers sont produits, la décision est conservée.`,
    )
    return
  }
  putClip(db, { ...àJour, status: 'exported' })
}

/**
 * Écarte les sorties d'un rendu que le montage a rendu caduc, et rend vrai
 * quand c'est arrivé.
 *
 * **Laisser les fichiers en place ne suffisait pas.** Refuser le statut ne fait
 * que reporter le problème d'un appel : les MP4 sont tous là, donc l'export
 * suivant passe par `sauterLeRendu`, ne compare plus rien, et annonce `exported`
 * sur des fichiers qui décrivent le montage d'avant. L'utilisateur publierait
 * l'ancien cadre sans jamais voir passer d'avertissement. La seule sortie qui
 * tienne dans un modèle « la présence du fichier fait foi » (spec §4) est de
 * retirer les fichiers qu'on sait faux : le prochain export les refait.
 * (relevé par Copilot)
 *
 * Un clip déjà `exported` redescend à `kept` du même geste — « décidé, reste à
 * exporter » —, puisque plus rien sur le disque ne justifie l'autre statut.
 */
export function écarterRenduPérimé(
  db: Database.Database,
  clipId: string,
  chemins: CheminsRendu,
  rendu: Clip,
): boolean {
  const àJour = getClip(db, clipId)
  if (àJour === undefined || !leRenduEstPérimé(rendu, àJour)) return false

  for (const chemin of [chemins.mp4, chemins.variant9x16, chemins.texts]) {
    if (chemin !== null) fs.rmSync(chemin, { force: true })
  }
  if (àJour.status === 'exported') putClip(db, { ...àJour, status: 'kept' })
  return true
}

/**
 * Vrai quand ce qui a été rendu ne décrit plus le clip.
 *
 * **Seuls les champs que l'encodage consomme comptent.** Les segments, le ratio,
 * le cadrage, les sous-titres et la marque sont dans l'image : les changer périme
 * le fichier. Le titre et la description, eux, ne vont que dans le `.txt`, qui est
 * réécrit depuis l'état à jour — les compter ici ferait perdre son statut à un
 * clip dont on a seulement corrigé une faute de frappe.
 *
 * Pure, donc testable sans base ni ffmpeg.
 */
export function leRenduEstPérimé(rendu: Clip, àJour: Clip): boolean {
  const mêmesSegments =
    rendu.segments.length === àJour.segments.length &&
    rendu.segments.every(
      (s, i) => s.start === àJour.segments[i].start && s.end === àJour.segments[i].end,
    )
  return (
    !mêmesSegments ||
    rendu.ratio !== àJour.ratio ||
    rendu.cropX !== àJour.cropX ||
    rendu.captions !== àJour.captions ||
    rendu.branding !== àJour.branding
  )
}

/**
 * Le dossier de polices, seulement s'il existe.
 *
 * `fontsdir` pointant nulle part n'est pas une erreur pour libass : il se rabat
 * sur fontconfig, ne trouve pas Anton, et incruste les sous-titres dans une autre
 * police — sans un mot. On préfère l'omettre et le dire.
 */
function dossierDesPolicesUtilisable(donné?: string): string | undefined {
  const dossier = dossierDesPolices(donné)
  if (fs.existsSync(dossier)) return dossier
  console.warn(
    `Dossier de polices introuvable (${dossier}) : les sous-titres seront incrustés dans la police que libass trouvera.`,
  )
  return undefined
}

/**
 * Le document ASS d'un clip, ou `null` quand aucun mot ne tombe dans ses
 * segments.
 *
 * **Sortie en fonction à part parce que c'est l'enchaînement qui compte**, et
 * qu'il est le seul de cette étape à pouvoir se tromper sans rien casser de
 * mesurable. Un test qui ne verrait que le chemin du saut resterait vert si la
 * première ligne disparaissait. (relevé par Copilot)
 *
 * **Les trois lignes, dans l'ordre :**
 *
 * 1. `retimeWords(mots, segments)` — le recalage sur la timeline du clip. Sans
 *    lui, un karaoké calé sur l'émission entière n'affiche rien du tout, et avec
 *    une seule coupe interne il dérive à partir de la coupe.
 * 2. `splitIntoCards(mots, style.maxChars, style.maxDuration)` — et les deux
 *    réglages sont passés **explicitement**. `renderAss` ne les lit pas : ils
 *    décrivent un découpage déjà fait quand le rendu commence. Les omettre marche
 *    tant que le preset vaut `DEFAULT_CAPTION_STYLE`, et cesse de marcher en
 *    silence dès qu'un preset personnalisé arrive — le carton garde alors la
 *    longueur par défaut pendant que tout le reste du style change.
 * 3. `renderAss` — dont la sortie commence par un BOM UTF-8 et s'écrit telle
 *    quelle.
 */
export function sousTitresDuClip(
  mots: Word[],
  segments: Segment[],
  style: CaptionStyle,
): string | null {
  const recalés = retimeWords(mots, segments)
  const cartons = splitIntoCards(recalés, style.maxChars, style.maxDuration)
  return cartons.length === 0 ? null : renderAss(cartons, style)
}

/**
 * Écrit le `.ass` du clip et rend son chemin, ou `undefined` s'il n'y a rien à
 * incruster — auquel cas un `.ass` d'un passage précédent est **effacé**. Il est
 * gardé sur le disque pour relire ce que libass a incrusté ; un fichier périmé y
 * raconterait des sous-titres que le MP4 ne porte pas. (relevé par Copilot)
 */
async function écrireSousTitres(
  clip: Clip,
  chemin: string,
  projet: { sourcePath: string },
  style: CaptionStyle,
): Promise<string | undefined> {
  // **Par `placeSidecar`, jamais par `transcriptPath`.** Le second rend le chemin
  // voulu, à côté de l'original, et ignore le repli dans le projet : un
  // transcript rangé là par une passe précédente passerait pour absent.
  //
  // `lireTranscript` vient de l'étape de repérage plutôt que d'être réécrit ici.
  // C'est la même lecture, avec la même validation et la même règle sur les mots
  // non alignés — que WhisperX émet, et qui ne doivent pas faire échouer un
  // export. Deux lectures du même fichier finiraient par ne plus dire la même
  // chose du même JSON.
  const placement = placeSidecar(projet.sourcePath, clip.projectId)
  const transcript = lireTranscript(placement.transcript)
  const mots: Word[] = transcript.segments.flatMap((s) => s.words)

  const document = sousTitresDuClip(mots, clip.segments, style)
  if (document === null) {
    console.warn(`Clip ${clip.id} : aucun mot dans les segments retenus, rendu sans sous-titres.`)
    return undefined
  }

  await écrireFichier(chemin, document)
  return chemin
}
