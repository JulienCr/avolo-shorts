import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { DEFAULT_CAPTION_STYLE, renderAss, type CaptionStyle } from '@/core/captions/ass'
import { splitIntoCards } from '@/core/captions/cards'
import { retimeWords } from '@/core/captions/retime'
import { clipDuration, type Clip, type Ratio } from '@/core/edl'
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
 * sur TikTok et Shorts, et la produire depuis un 9:16 rendrait le même cadre
 * réencodé une seconde fois (spec §11).
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

export function cheminsRendu(projectId: string, clipId: string, ratio: Ratio): CheminsRendu {
  const dossier = rendersDir(projectId)
  return {
    mp4: path.join(dossier, `${clipId}.mp4`),
    variant9x16: ratio === '9:16' ? null : path.join(dossier, `${clipId}-9x16.mp4`),
    texts: path.join(dossier, `${clipId}.txt`),
    ass: path.join(dossier, `${clipId}.ass`),
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
 * **Un dossier vide n'est pas une erreur** : on rend sans marque. C'est le cas
 * d'un dépôt fraîchement cloné — `assets/brand/` est ignoré par git — et il ne
 * doit pas faire échouer un export de trois minutes.
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
 * La publication est hors périmètre (spec §3) — l'outil produit des fichiers et
 * des textes, Julien publie avec ses outils. Ce fichier est donc fait pour être
 * **copié**, pas analysé : trois sections nommées, dans l'ordre où on les colle.
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
 * Les dimensions de la source. **Pas de 1920x1080 supposé** : `cropRect` en
 * dépend entièrement, et sur une source 4K un crop calculé pour du 1080p
 * découperait un rectangle du coin supérieur gauche — une erreur qui ne lève rien
 * et se voit seulement à l'image.
 *
 * Le repli sur 1920x1080 ne sert que le cas où ffprobe ne sait rien dire, et il
 * le dit.
 */
async function dimensionsSource(src: string): Promise<{ w: number; h: number }> {
  const { width, height } = await probe(src)
  if (width === null || height === null) {
    console.warn(`ffprobe n'a pas su dire les dimensions de la source ; on suppose 1920x1080.`)
    return { w: 1920, h: 1080 }
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

  // **Le saut se décide avant de toucher au transcript.** Le sidecar vit sur le
  // Drive partagé, monté en 9p, lent et sujet au décrochage : un clip déjà rendu
  // ne doit pas payer un aller-retour dessus pour s'entendre dire qu'il n'y a
  // rien à faire.
  if (sauterLeRendu(chemins, (c) => fs.existsSync(c), options.force)) {
    return {
      mp4: chemins.mp4,
      variant9x16: chemins.variant9x16,
      texts: chemins.texts,
      skipped: true,
    }
  }

  const durée = clipDuration(clip.segments)
  if (durée <= 0) {
    throw new Error(
      `Le clip ${clipId} ne porte aucun segment à rendre. Un clip est une liste de segments, et une liste vide n'a pas de durée.`,
    )
  }

  // **L'encodeur se résout à l'appel, dans la fonction paresseuse.** `encoderName`
  // lève sur un `FFMPEG_ENCODER` inconnu — refus voulu, jamais un repli silencieux
  // — et le résoudre ici le ferait lever aussi sur un clip dont le MP4 est déjà
  // là. C'est la leçon relevée sur `buildProxy` : un artefact présent doit revenir
  // tout de suite, quoi que porte l'environnement.
  const encodeur = (): EncoderName => options.encoder ?? encoderName()

  // **On ne prépare que ce que le rendu va vraiment consommer.** Un passage
  // interrompu juste après l'encodage laisse le MP4 sans son `.txt` : cette
  // reprise-là n'a rien à faire du transcript, qui vit sur le Drive et coûte un
  // aller-retour en 9p, ni des trois sondages ffprobe.
  if (options.force === true || !fs.existsSync(chemins.mp4)) {
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

    const style = options.style ?? DEFAULT_CAPTION_STYLE
    const assPath = clip.captions
      ? await écrireSousTitres(clip, chemins.ass, projet, style)
      : undefined
    // Le dossier de polices n'a de sens qu'avec un `.ass` à incruster : le
    // chercher sans cela ferait avertir sur un clip qui n'a pas de sous-titres.
    const fontsDir = assPath === undefined ? undefined : dossierDesPolicesUtilisable(options.fontsDir)

    const taille = await dimensionsSource(src)
    const crop = cropRect(ratio, clip.cropX, taille.w, taille.h)
    const out = outputSize(ratio)

    const logos = clip.branding
      ? planifierMarques(out.w, out.h, await collecterMarques(options.brandDir))
      : []

    await produireArtefact({
      dst: chemins.mp4,
      force: options.force,
      durationSec: durée,
      onProgress: (a) => options.onProgress?.({ ...a, sortie: 'natif' }),
      quoi: `rendu ${ratio} du clip ${clipId}`,
      args: (destination) =>
        renderArgs({
          src,
          dst: destination,
          segments: clip.segments,
          crop,
          out,
          assPath,
          fontsDir,
          logos,
          encoder: encodeur(),
        }),
    })
  }

  // La variante part du rendu natif et non de la source : le contenu y est déjà
  // cropé, sous-titré et marqué, et son son est déjà passé au `loudnorm` — d'où
  // le `-c:a copy` de `blurredVariantArgs`, qui évite de le comprimer deux fois.
  if (chemins.variant9x16 !== null) {
    await produireArtefact({
      dst: chemins.variant9x16,
      force: options.force,
      durationSec: durée,
      onProgress: (a) => options.onProgress?.({ ...a, sortie: '9x16' }),
      quoi: `variante 9:16 du clip ${clipId}`,
      args: (destination) =>
        blurredVariantArgs({ src: chemins.mp4, dst: destination, encoder: encodeur() }),
    })
  }

  await écrireFichier(chemins.texts, texteDePublication(clip))

  // **Le statut ne bouge qu'une fois les fichiers sur le disque.** `exported` est
  // un statut humain au sens de `mergeCandidates` : il fait survivre le clip à
  // une nouvelle passe de repérage. Le poser avant l'encodage protégerait un clip
  // qui n'existe pas.
  if (clip.status !== 'exported') putClip(db, { ...clip, status: 'exported' })

  return {
    mp4: chemins.mp4,
    variant9x16: chemins.variant9x16,
    texts: chemins.texts,
    skipped: false,
  }
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
 * Écrit le `.ass` du clip et rend son chemin, ou `undefined` s'il n'y a rien à
 * incruster.
 *
 * **Les trois lignes qui comptent, dans l'ordre :**
 *
 * 1. `retimeWords(mots, clip.segments)` — le recalage sur la timeline du clip.
 *    Sans lui, un karaoké calé sur l'émission entière n'affiche rien du tout, et
 *    avec une seule coupe interne il dérive à partir de la coupe.
 * 2. `splitIntoCards(mots, style.maxChars, style.maxDuration)` — et les deux
 *    réglages sont passés **explicitement**. `renderAss` ne les lit pas : ils
 *    décrivent un découpage déjà fait quand le rendu commence. Les omettre marche
 *    tant que le preset vaut `DEFAULT_CAPTION_STYLE`, et cesse de marcher en
 *    silence dès qu'un preset personnalisé arrive — le carton garde alors la
 *    longueur par défaut pendant que tout le reste du style change.
 * 3. `renderAss` — dont la sortie commence par un BOM UTF-8 et s'écrit telle
 *    quelle.
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

  const recalés = retimeWords(mots, clip.segments)
  const cartons = splitIntoCards(recalés, style.maxChars, style.maxDuration)
  if (cartons.length === 0) {
    console.warn(`Clip ${clip.id} : aucun mot dans les segments retenus, rendu sans sous-titres.`)
    return undefined
  }

  await écrireFichier(chemin, renderAss(cartons, style))
  return chemin
}
