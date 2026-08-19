import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { z } from 'zod'
import { DEFAULT_CAPTION_STYLE, renderAss, type CaptionStyle } from '@/core/captions/ass'
import { splitIntoCards } from '@/core/captions/cards'
import { retimeWords } from '@/core/captions/retime'
import { clipDuration, type Clip, type Ratio, type Segment } from '@/core/edl'
import { splitByShot } from '@/core/shot-split'
import { blurredVariantArgs, renderArgs, type FramedSegment } from '@/core/ffmpeg/args'
import type { EncoderName } from '@/core/ffmpeg/encoder'
import { cropRect, outputSize } from '@/core/framing'
import type { Word } from '@/core/transcript'
import { clipFraming, type ResolvedFraming } from '@/server/clip-framing'
import { getClip, getDb, getProject, putClip, type Project } from '@/server/db'
import {
  pathTemporary,
  encoderName,
  produceArtifact,
  type Progress,
} from '@/server/ffmpeg'
import { probe } from '@/server/ffprobe'
import { estAAbsence } from '@/server/bytes'
import { rendersDir, resolveSource } from '@/server/paths'
import { ensureLocalCopy, holdStagedCopy, editingResponds } from '@/server/steps/ingest'
import { projectTranscript } from '@/server/views'

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
 * argv viennent de `core/ffmpeg/args.ts`, la géométrie de `core/cadrage.ts`, les
 * sous-titres de `core/captions/`. Ici on lit le disque, on choisit l'encodeur,
 * on lance, et on écrit.
 */

/**
 * Au-delà de combien de morceaux à décoder on le dit au journal.
 *
 * `renderArgs` ouvre un décodeur par entrée, et la forme est mesurée bonne
 * jusqu'à une dizaine. Ce n'est pas un refus : un clip long sur une émission
 * très découpée dépassera, et il vaut mieux qu'il sorte lentement qu'il ne
 * sorte pas.
 */
const PIECE_COUNT_WARN = 12

/** Les deux sorties possibles, pour distinguer l'avancement de l'une et de l'autre. */
export type OutputRender = 'natif' | '9x16'

export type ProgressRender = Progress & { output: OutputRender }

/** Ce que `renderClip` rend à son appelant — la route d'export. */
export type RenderResult = {
  /** Le rendu au ratio natif du clip — celui du feed. Toujours produit. */
  mp4: string
  /**
   * La variante 9:16 sur fond flouté, ou `null` quand le ratio natif est
   * **déjà** 9:16 et qu'elle serait une copie du fichier précédent.
   */
  variant9x16: string | null
  /** Le `.txt` : titre, description, mots-dièse. */
  texts: string
  /** Vrai si toutes les sorties étaient déjà là et que `force` ne les visait pas. */
  skipped: boolean
}

export type OptionsRender = {
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
  onProgress?: (progress: ProgressRender) => void
  /** Le dossier des marques. Les tests en passent un jetable. */
  brandDir?: string
  /** Le dossier des polices embarquées. Idem. */
  fontsDir?: string
}

/**
 * Les cinq chemins d'un clip. `variant9x16` vaut `null` quand le ratio natif est
 * déjà 9:16 : la variante à fond flouté n'existe que pour porter un 4:5 ou un
 * 1:1 sur TikTok et Shorts, et sur un clip déjà vertical elle serait le même
 * cadre rendu une seconde fois (spec §11).
 *
 * Le `.ass` est un **intermédiaire** : il est réécrit à chaque passage et ne
 * compte pas dans la décision de saut. Il reste sur le disque exprès — c'est le
 * seul moyen de relire ce que libass a incrusté quand un sous-titre surprend.
 */
export type PathsRender = {
  mp4: string
  variant9x16: string | null
  texts: string
  ass: string
  /**
   * L'empreinte du rendu — ce que les fichiers ci-dessus décrivent (#48).
   *
   * **Elle n'est pas une sortie** : `sortiesDuClip` ne la publie pas et
   * `sortieNommée` ne la sert pas. C'est une pièce interne, rangée à côté des
   * fichiers qu'elle décrit précisément pour disparaître avec eux.
   */
  fingerprint: string
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
function verifyClipId(clipId: string): string {
  const rejected =
    clipId === '' ||
    clipId === '.' ||
    clipId === '..' ||
    clipId.includes('/') ||
    clipId.includes('\\') ||
    clipId.includes('\0')
  if (rejected) {
    throw new Error(`Identifiant de clip invalide : ${JSON.stringify(clipId)}`)
  }
  return clipId
}

/**
 * Le nom de la variante, **due ou non**.
 *
 * Séparé de `cheminsRendu` parce qu'il sert aussi à effacer celle d'un ratio
 * abandonné : un clip dont le ratio natif retombe à 9:16 n'a plus de variante à
 * produire, et l'ancienne resterait sur le disque à ressembler à une livraison à
 * jour. (relevé par Copilot)
 */
function pathVariant(projectId: string, clipId: string): string {
  return path.join(rendersDir(projectId), `${verifyClipId(clipId)}-9x16.mp4`)
}

/**
 * **Le ratio attendu est le ratio NATIF résolu**, celui que `computeFraming`
 * choisit — le plus large des plans —, jamais `clip.ratio` : un clip en `auto`
 * n'en a pas à lui, et lire le mauvais ferait chercher une variante sous un clip
 * qui n'en a pas, ou l'inverse.
 */
export function pathsRender(projectId: string, clipId: string, ratio: Ratio): PathsRender {
  const folder = rendersDir(projectId)
  const name = verifyClipId(clipId)
  return {
    mp4: path.join(folder, `${name}.mp4`),
    variant9x16: ratio === '9:16' ? null : pathVariant(projectId, name),
    texts: path.join(folder, `${name}.txt`),
    ass: path.join(folder, `${name}.ass`),
    // **Le nom ne dépend pas du ratio**, contrairement à celui de la variante :
    // l'empreinte décrit le rendu quel que soit le ratio, et un clip dont le
    // ratio natif change doit retrouver — pour l'écarter — celle qu'il a écrite
    // avant.
    fingerprint: path.join(folder, `${name}.rendu.json`),
  }
}

/**
 * L'empreinte de rendu (#48), et le défaut qu'elle ferme.
 *
 * Le modèle de l'itération 0 fait foi sur la **présence du fichier** (spec §4).
 * Quatre endroits en déduisaient « le rendu décrit le clip » sans avoir de quoi
 * le vérifier : `marquerExporté` ne comparait que le statut, alors qu'éditer un
 * montage pendant l'encodage ne le change pas ; `sauterLeRendu` constatait trois
 * `existsSync` ; l'ordre d'écriture du `.txt` entre le `PATCH` et `renderClip`
 * n'était fixé nulle part ; et les rendus déjà sur le disque ne repassaient
 * jamais par la porte que #37 a installée.
 *
 * Le remède est un seul fichier, écrit à côté des sorties **au moment où elles
 * sont produites**, qui garde la valeur qu'avaient au rendu les champs dont le
 * rendu dépend. Un `.json` dans `renders/` plutôt qu'une colonne en base, pour
 * une raison qui décide seule : il disparaît avec les fichiers qu'il décrit. Une
 * colonne survivrait à un `rm -rf renders/` et affirmerait ensuite l'exactitude
 * de fichiers absents ; ici, effacer un rendu à la main laisse un état cohérent.
 */

/**
 * **La version de la recette de rendu**, et le seul champ de l'empreinte qui ne
 * décrive pas le clip.
 *
 * Les champs de `FormeRendue` disent ce qui a été *demandé* — et, depuis le
 * cadrage automatique, ce qui a été *décidé pour* le clip —, `marks` et
 * `captionsLook` ce qui a été *obtenu*. Reste tout ce que le code fait sans qu'on
 * le lui demande : la position de la bande de marque, le graphe de filtres, le
 * style de sous-titres par défaut. Rien de cela ne tient dans un champ, et un
 * rendu produit sous une recette qui n'est plus celle d'aujourd'hui est pourtant
 * périmé au même titre qu'un montage modifié — c'est exactement ce qui est
 * arrivé aux trois rendus du 18 août, sans marque incrustée alors que
 * `branding` valait `true` aux deux instants.
 *
 * **À incrémenter à la main, et seulement quand l'image change.** Le geste coûte
 * un réencodage de tous les rendus du disque : c'est le prix juste quand ils ne
 * montrent plus ce que la chaîne montrerait, et un prix imbécile pour un
 * renommage.
 *
 * **Passée à 2 le 18 août 2026, avec le cadrage automatique.** Un rendu à crop
 * unique ne montre pas ce qu'un rendu à crop variable montrerait, même à cadrage
 * équivalent : le rectangle saute désormais aux frontières de plans, et les
 * empreintes d'avant ne portent pas de quoi le dire.
 *
 * **Passée à 3 le 19 août 2026, avec `captionsContent` (#87).** Le texte
 * réellement incrusté n'entrait pas dans l'empreinte : une correction du
 * transcript qui ne touche aucun segment d'aucun clip laissait `sauterLeRendu`
 * reprendre un MP4 qui portait encore les anciens mots, sans un mot pour le
 * dire. Toutes les empreintes d'avant sont muettes sur ce point — il n'y a rien
 * à en déduire, donc rien à faire d'autre que les refaire.
 *
 * **Passée à 4 le 19 août 2026, avec la traduction des clés persistées
 * (issue #73).** `marques` devient `marks`, `sousTitres` devient
 * `captionsLook`, et `MarqueIncrustée` devient `EmbeddedMark` avec ses champs
 * `nom`/`contenu` en `name`/`content`. Le chemin est déjà celui qui gère un
 * changement de recette : `lireEmpreinte` compare `version` **avant** le
 * schéma et rend `null` sur un nombre différent, donc les trois rendus déjà
 * sur le disque seront simplement refaits — aucun n'a de marque incrustée à
 * ce jour (voir `ROADMAP.md`), le coût est donc nul en pratique.
 */
export const VERSION_FINGERPRINT = 4

/**
 * Le cadrage tel que l'empreinte le retient : par plan traversé, **ses bornes
 * dans la source, son ratio et sa position**.
 *
 * Les bornes en font partie parce qu'elles changent l'image : une frontière qui
 * se déplace fait sauter le cadre ailleurs, donc le fichier ne montre plus ce
 * que la chaîne montrerait. `source` n'y est pas — savoir qu'un cadre est
 * calculé ou posé à la main ne change pas un pixel.
 *
 * Les deux positions y sont, parce que les deux fichiers les consomment : le
 * natif prend `cropXNative` sous `ratio`, la variante prend `cropX` sous le
 * `ratio` de chaque plan.
 */
export type RenderedFraming = {
  /** Le ratio du fichier natif : le plus large que les plans demandent. */
  ratio: Ratio
  shots: { start: number; end: number; ratio: Ratio; cropX: number; cropXNative: number }[]
}

/**
 * Ce qu'un rendu consomme d'un clip.
 *
 * **Le `Pick` suit `Clip`** : c'est le seul endroit du dépôt où la liste des
 * champs qui comptent est écrite, et `leRenduEstPérimé` la lit.
 *
 * `ratio` et `cropX` en sont sortis quand le cadrage automatique est entré en
 * service, et ce n'est pas une simplification : ils ne décrivent plus l'image.
 * Le ratio effectif est celui que `computeFraming` choisit — un clip en `auto`
 * n'a plus de ratio à lui —, et `cropX` n'est plus consommé du tout dès que
 * l'analyse est là, puisque le crop se calcule par plan. Les garder ferait deux
 * fautes en sens contraire : épingler `16:9` sur un clip que le calcul rendait
 * déjà en 16:9 réencoderait pour rien, et une redétection des plans qui déplace
 * les crops ne périmerait rien du tout. `framing` porte les deux, mesurés sur ce
 * qui a réellement été découpé.
 *
 * Nommer ce sous-ensemble est ce qui permet de comparer une empreinte à un clip
 * par la **même** fonction que deux clips entre eux. Deux comparaisons sur la
 * même question finiraient par ne plus dire la même chose.
 */
export type ShapeRendered = Pick<Clip, 'segments' | 'captions' | 'branding'> & {
  framing: RenderedFraming
}

/**
 * Le cadrage d'un clip réduit à ce que l'empreinte en retient.
 *
 * Écrit une fois : `renderClip` et les deux comparaisons du `PATCH` doivent
 * réduire de la même façon, sans quoi un rendu se déclarerait périmé sur un
 * champ que personne n'a changé.
 */
export function renderedFraming(framing: ResolvedFraming): RenderedFraming {
  return {
    ratio: framing.ratio,
    shots: framing.shots.map((s) => ({
      start: s.shot.start,
      end: s.shot.end,
      ratio: s.ratio,
      cropX: s.cropX,
      cropXNative: s.cropXNative,
    })),
  }
}

/** Le clip et son cadrage, tels que `leRenduEstPérimé` les compare. */
export function renderedShape(clip: Pick<Clip, 'segments' | 'captions' | 'branding'>, framing: RenderedFraming): ShapeRendered {
  return {
    segments: clip.segments,
    captions: clip.captions,
    branding: clip.branding,
    framing,
  }
}

/**
 * Ce que les fichiers posés à côté d'elle décrivent.
 *
 * **Elle porte ce qui a été incrusté, pas seulement ce qui était demandé**, et
 * c'est le quatrième cas de l'issue : les trois rendus du 18 août ne portent
 * aucune marque, alors que `branding` valait `true` au rendu comme aujourd'hui.
 * Une empreinte réduite aux cinq champs ne les attraperait pas.
 */
export type FingerprintRender = ShapeRendered & {
  version: number
  /**
   * Les marques réellement incrustées, triées par nom — l'ordre de lecture d'un
   * dossier n'a rien à dire.
   *
   * **Le nom ne suffit pas, il faut le contenu.** Les deux marques portent des
   * noms fixes, `logo.png` et `twitch.png`, et la façon normale d'en changer est
   * de remplacer le fichier sous le même nom. Une empreinte réduite aux noms
   * verrait « rien n'a bougé » là où tout a changé, et l'export continuerait de
   * livrer l'ancienne image. (relevé par Codex)
   */
  marks: EmbeddedMark[]
  /**
   * `null` quand aucun document ASS n'a été incrusté ; sinon le condensat du
   * preset avec lequel il l'a été.
   *
   * **Un seul champ pour deux faits, parce qu'ils ne se séparent pas** : un
   * preset n'a de sens que s'il y a des sous-titres, et deux champs porteraient
   * un invariant à tenir entre eux. Un clip qui demande des sous-titres et dont
   * aucun mot ne tombe dans les segments se rend sans, en le journalisant :
   * `captions: true` avec `captionsLook: null` dit exactement cela.
   *
   * **Le condensat se compare, la présence non**, et l'asymétrie a une cause.
   * `OptionsRendu.style` change l'image : un rendu forcé avec un preset
   * personnalisé, puis un appel avec le preset par défaut, sautait en déclarant
   * à jour une vidéo produite avec l'autre style. (relevé par Copilot) La
   * *présence*, elle, ne peut se comparer qu'en relisant le transcript — et la
   * rendre périmante sans cette lecture ferait boucler l'export sur un clip
   * dont aucun mot ne tombe dans les segments : chaque passage referait le
   * rendu pour réécrire la même empreinte.
   *
   * **Ce champ-ci n'a donc toujours pas besoin du transcript**, mais `renderClip`
   * le lit désormais avant la décision de saut dès qu'un clip demande des
   * sous-titres — pour `captionsContent`, pas pour celui-ci. L'aller-retour sur
   * le Drive en 9p que ce paragraphe décrivait comme évité ne l'est donc plus
   * dans ce cas : #87 en a fait le prix nécessaire pour voir un transcript
   * corrigé sans qu'aucun segment ne bouge.
   */
  captionsLook: string | null
  /**
   * Le condensat de ce que les sous-titres ont **réellement porté** (#87) —
   * le document ASS produit par `sousTitresDuClip`, pas le transcript entier.
   * `null` par la même règle que `captionsLook` : aucun document n'a été
   * incrusté, que le clip n'en demande pas ou qu'aucun mot ne tombe dans ses
   * segments.
   *
   * **C'est le champ qui manquait avant #87.** Le transcript ne pouvait pas
   * changer sans que le graphe refasse ce qui en dépend — jusqu'à ce qu'une
   * correction manuelle réécrive des mots sans toucher à aucun segment de
   * clip. `captionsLook` (le look) ne voit rien de ce cas : deux presets
   * identiques appliqués à deux transcripts différents produisent le même
   * condensat de style. Il fallait un champ sur le contenu, pas sur la forme.
   *
   * **Sur le document entier, pas sur les seuls mots.** `sousTitresDuClip`
   * recale les horodatages et découpe en cartons avant `renderAss` ; deux
   * documents identiques mot pour mot mais recalés différemment ne montrent
   * pas la même chose à l'image. Prendre le document, comme `contenuDuFichier`
   * le fait pour une marque, évite de réinventer cette chaîne côté empreinte.
   */
  captionsContent: string | null
}

/** Une marque incrustée : son nom de fichier, et de quoi voir qu'elle a changé. */
export type EmbeddedMark = { name: string; content: string }

/**
 * Ce qui décide de l'allure des sous-titres à l'image — **le preset et les
 * polices réellement là**, et pas seulement le premier.
 *
 * `fontsDir` est une entrée du rendu : quand `fonts/` manque, libass se rabat sur
 * fontconfig, ne trouve pas Anton et incruste dans une autre police, sans un mot
 * (voir `dossierDesPolicesUtilisable`). Un condensat qui ne porterait que le
 * preset serait identique avant et après le retour d'Anton, et l'export
 * sauterait indéfiniment sur la vidéo rendue dans la mauvaise police.
 * (relevé par Copilot)
 *
 * **Le contenu du dossier, pas sa seule existence.** Remplacer
 * `Anton-Regular.ttf` en laissant `fonts/` en place est la forme normale d'une
 * mise à jour de police, et un booléen de présence n'y verrait rien.
 * (relevé par Codex) `polices` porte donc le condensat de ce que le dossier
 * contient — voir `condensatDesPolices`.
 */
export type CaptionsLook = { style: CaptionStyle; fonts: string }

/**
 * Le schéma de lecture. **Non strict, et volontairement** : une version
 * ultérieure ajoutera des champs, et c'est `version` qui doit trancher, pas un
 * refus d'analyse qui dirait « illisible » d'un fichier parfaitement formé.
 */
const SCHEMA_FINGERPRINT = z.object({
  version: z.number().int(),
  segments: z.array(z.object({ start: z.number().finite(), end: z.number().finite() })),
  captions: z.boolean(),
  branding: z.boolean(),
  /**
   * **Requis, et une empreinte de la version d'avant ne le porte pas.** Elle est
   * écartée bien avant d'arriver ici, sur son numéro de version — voir
   * `lireEmpreinte` : ce qui se lit mal doit se dire au bon nom, et « produite
   * par une recette antérieure » n'est pas « illisible ».
   */
  framing: z.object({
    ratio: z.enum(['9:16', '4:5', '1:1', '16:9']),
    shots: z.array(
      z.object({
        start: z.number().finite(),
        end: z.number().finite(),
        ratio: z.enum(['9:16', '4:5', '1:1', '16:9']),
        cropX: z.number().finite(),
        cropXNative: z.number().finite(),
      }),
    ),
  }),
  marks: z.array(z.object({ name: z.string(), content: z.string() })),
  captionsLook: z.string().nullable(),
  captionsContent: z.string().nullable(),
})

/**
 * L'identité du contenu d'un fichier — une marque, une police.
 *
 * SHA-256 plutôt que la taille et la date : une copie change la date sans
 * changer le fichier, et le rendu serait déclaré périmé pour rien à chaque
 * synchronisation de dossier. Le condensat ne bouge que si le contenu bouge.
 *
 * Le coût est la lecture de quelques dizaines de kilo-octets, sur un chemin qui
 * lance déjà un ffprobe par marque.
 */
function fileContent(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

/**
 * Le condensat du look des sous-titres.
 *
 * **Clés triées avant sérialisation.** `JSON.stringify` suit l'ordre
 * d'insertion : sans ce tri, réordonner le littéral de `DEFAULT_CAPTION_STYLE`
 * — un geste qui ne change pas une image — périmerait tous les rendus du
 * disque.
 */
function lookDigest(look: CaptionsLook): string {
  const stable = Object.entries(look.style).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return createHash('sha256').update(JSON.stringify([stable, look.fonts])).digest('hex')
}

/**
 * Le condensat de ce qu'un document ASS porte réellement, ou `null` s'il n'y en
 * a pas — `null` se propage tel quel, jamais vers le digest de la chaîne vide,
 * pour ne pas confondre « rien incrusté » avec « un document vide ».
 */
function digestOfCaptionsText(document: string | null): string | null {
  return document === null ? null : createHash('sha256').update(document, 'utf8').digest('hex')
}

/** Ce que libass sait charger depuis un `fontsdir`. */
const FONT_EXTENSIONS = ['.ttf', '.otf', '.ttc']

/**
 * Le condensat du dossier de polices : ce que libass y trouvera.
 *
 * **Le contenu de chaque fichier, pas seulement leur liste.** Une police mise à
 * jour garde son nom, et c'est même la forme normale de la mise à jour : sans
 * lire les octets, un rendu incrusté avec l'ancienne version sauterait
 * indéfiniment. Anton pèse 167 ko, sur un chemin qui lance déjà deux ffprobe.
 * (relevé par Codex)
 *
 * Un dossier absent ou illisible rend le condensat de la liste vide, qui est
 * différent de celui de n'importe quel dossier peuplé : c'est exactement ce
 * qu'il faut, puisque libass se rabat alors sur fontconfig.
 *
 * Un fichier qu'on ne sait pas lire entre dans le condensat par son nom et un
 * marqueur, plutôt que d'être ignoré : le rendu qui suivra n'aura pas la même
 * police, et l'empreinte doit le voir.
 */
export function fontsDigest(folder: string): string {
  let names: string[]
  try {
    names = fs.readdirSync(folder).filter((name) =>
      FONT_EXTENSIONS.includes(path.extname(name).toLowerCase()),
    )
  } catch {
    names = []
  }
  const entries = names.sort().map((name): [string, string] => {
    try {
      return [name, fileContent(path.join(folder, name))]
    } catch {
      return [name, 'illisible']
    }
  })
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex')
}

/** Une liste de marques dans un ordre stable, quelle que soit sa provenance. */
function sortedByName(markers: readonly EmbeddedMark[]): EmbeddedMark[] {
  return [...markers].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** Les marques telles que l'empreinte les note : nom et contenu, triés par nom. */
function markersIdentities(markers: readonly MarkerNative[]): EmbeddedMark[] {
  return sortedByName(markers.map((m) => ({ name: path.basename(m.path), content: m.content })))
}

/**
 * L'empreinte que ce passage vient de produire. Pure.
 *
 * `style` n'est lu que si un document a été incrusté : le preset d'un clip sans
 * sous-titres ne décrit rien de son image, et l'y noter périmerait ce clip au
 * premier réglage de police.
 */
export function renderFingerprint(
  clip: ShapeRendered,
  markers: readonly MarkerNative[],
  underTitles: { burnedIn: boolean; look: CaptionsLook; text: string | null },
): FingerprintRender {
  return {
    version: VERSION_FINGERPRINT,
    // Recopiés champ par champ : `clip.segments` est le tableau que porte le
    // clip, et le sérialiser tel quel embarquerait ce qu'une évolution du type
    // y ajouterait sans qu'on l'ait décidé.
    segments: clip.segments.map((s) => ({ start: s.start, end: s.end })),
    // Recopié champ par champ pour la même raison que les segments : ce que le
    // fichier porte est décidé ici, pas par ce qu'un type voisin gagnerait.
    framing: {
      ratio: clip.framing.ratio,
      shots: clip.framing.shots.map((p) => ({
        start: p.start,
        end: p.end,
        ratio: p.ratio,
        cropX: p.cropX,
        cropXNative: p.cropXNative,
      })),
    },
    captions: clip.captions,
    branding: clip.branding,
    marks: markersIdentities(markers),
    captionsLook: underTitles.burnedIn ? lookDigest(underTitles.look) : null,
    captionsContent: underTitles.burnedIn ? digestOfCaptionsText(underTitles.text) : null,
  }
}

/**
 * L'empreinte posée à ce chemin, ou `null` — **absente et illisible se
 * confondent**, et c'est voulu : les deux veulent dire « rien ici ne certifie ce
 * que les fichiers décrivent », donc les deux mènent au même remède, refaire le
 * rendu. Distinguer ferait une branche de plus sans une décision de plus.
 *
 * Ce qui ne se confond pas, c'est le **journal** : une absence est le cas normal
 * d'un clip jamais rendu et ne dit rien ; tout le reste se dit.
 *
 * Le message ne porte que le nom du fichier. Le chemin absolu porte
 * l'arborescence de la machine, et cette fonction est appelée depuis un `GET`.
 */
export function lireFingerprint(filePath: string): FingerprintRender | null {
  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    if (!estAAbsence(error)) {
      console.warn(
        `Empreinte de rendu inaccessible (${path.basename(filePath)}) : ` +
          `${error instanceof Error ? error.name : 'erreur inconnue'}. Le rendu sera refait.`,
      )
    }
    return null
  }
  try {
    const raw: unknown = JSON.parse(content)
    // **La version se lit avant le schéma, et c'est le seul ordre honnête.** Une
    // empreinte d'une recette antérieure n'a pas les champs d'aujourd'hui : la
    // passer au schéma la ferait refuser, et le journal dirait « illisible »
    // d'un fichier parfaitement formé. Le remède est le même — refaire le rendu
    // — mais le message enverrait chercher une corruption qui n'existe pas.
    // C'est `version` qui tranche, comme le dit la note du schéma.
    const version = (raw as { version?: unknown } | null)?.version
    if (typeof version === 'number' && version !== VERSION_FINGERPRINT) {
      console.warn(
        `Empreinte de rendu en version ${version} (${path.basename(filePath)}), la recette est en ` +
          `${VERSION_FINGERPRINT}. Le rendu sera refait.`,
      )
      return null
    }
    const lu = SCHEMA_FINGERPRINT.safeParse(raw)
    if (lu.success) return lu.data
  } catch {
    // JSON tronqué — un processus tué en pleine écriture, malgré le renommage.
  }
  console.warn(`Empreinte de rendu illisible (${path.basename(filePath)}). Le rendu sera refait.`)
  return null
}

/** Écrit l'empreinte, sous un nom temporaire puis renommée, comme les sorties. */
async function writeFingerprint(filePath: string, fingerprint: FingerprintRender): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(fingerprint, null, 2)}\n`)
}

/**
 * Les marques incrustées ne sont plus celles qu'on incrusterait aujourd'hui.
 *
 * **Un dossier vide ne périme rien**, et c'est la seule subtilité de cette
 * fonction. Un clip qui demande des marques dont plus aucune n'est exploitable
 * ne peut pas se rendre — `refuserFauteDeMarque` l'arrête —, si bien que
 * déclarer son rendu périmé transformerait une livraison correcte en export qui
 * refuse. C'est arrivé pour de vrai : les deux PNG ont disparu d'`assets/brand/`
 * entre le matin et l'après-midi du 18 août. Le rendu déjà produit reste alors
 * le meilleur qu'on ait.
 *
 * **Mais cette tolérance ne vaut que pour cette question-là.** Décider si une
 * livraison déjà faite est périmée et décider si on peut certifier une livraison
 * qu'on vient de faire ne se répondent pas pareil : dans le premier cas, ne pas
 * savoir n'est pas une raison de détruire ; dans le second, ne pas savoir n'est
 * pas une raison d'affirmer. D'où `dossierVideToléré`, que la certification
 * d'après-rendu passe à faux. (relevé par Codex)
 *
 * **La comparaison porte sur le contenu autant que sur le nom** : remplacer
 * `logo.png` par une autre image sous le même nom est la façon normale de
 * changer de marque. (relevé par Codex)
 */
export function markersHaveMoved(
  fingerprint: FingerprintRender,
  available: readonly MarkerNative[],
  folderEmptyTolerated: boolean,
): boolean {
  const today = markersIdentities(available)
  if (folderEmptyTolerated && today.length === 0) return false
  // Retriées à la lecture : le fichier a pu être écrit à la main.
  const burnedIn = sortedByName(fingerprint.marks)
  return (
    burnedIn.length !== today.length ||
    burnedIn.some((m, i) => m.name !== today[i].name || m.content !== today[i].content)
  )
}

/** Pourquoi une empreinte ne décrit pas le rendu qu'on produirait maintenant. */
export type GapFingerprint = 'absente' | 'recette' | 'montage' | 'marques' | 'style' | 'texte'

/**
 * Ce qu'on incrusterait **maintenant**, pour ce que l'appelant en sait.
 *
 * **Chaque champ peut valoir `null`, et cela veut dire « je n'ai pas sondé »**,
 * jamais « il n'y en a pas » : la comparaison porte alors sur tout le reste. Un
 * `GET /api/clips/:id` se sert à chaque affichage de carte et ne lance pas deux
 * ffprobe pour cela ; `renderClip`, lui, lit le dossier des marques et connaît
 * son preset de toute façon. C'est un arbitrage de coût, pas deux avis sur la
 * même question : la même fonction, avec des critères en moins.
 */
export type ObservedBurnIn = {
  markers: readonly MarkerNative[] | null
  look: CaptionsLook | null
  /**
   * Le document ASS qu'on incrusterait maintenant — **trois valeurs, pas
   * deux**. `undefined` dit « pas sondé », comme `null` pour les deux champs
   * au-dessus ; `null` dit « sondé, et rien à incruster » (pas de sous-titres
   * demandés, ou aucun mot dans les segments) ; une chaîne est le document.
   * Confondre les deux `null` laisserait passer exactement le cas où une
   * correction a vidé de mots les segments d'un clip qui demande des
   * sous-titres : l'empreinte porterait encore l'ancien document, `texte`
   * vaudrait `null` « je n'ai rien à incruster », et la comparaison
   * conclurait à tort que rien n'a changé.
   */
  text: string | null | undefined
}

/**
 * L'écart entre ce qui a été rendu et ce qu'on rendrait maintenant, ou `null`
 * quand il n'y en a pas. Pure : c'est l'appelant qui a lu le disque.
 */
export function lFingerprintGap(
  fingerprint: FingerprintRender | null,
  clip: ShapeRendered,
  observed: ObservedBurnIn,
): GapFingerprint | null {
  // **Une empreinte absente vaut « périmé », jamais « inconnu ».** C'est le seul
  // choix qui referme le quatrième cas sans intervention manuelle : les rendus
  // déjà sur le disque n'en ont pas, et « inconnu » les laisserait sauter pour
  // toujours — ce que `--force` rattrape aujourd'hui, à condition d'avoir lu le
  // commentaire qui le dit. Ce que ça coûte est un réencodage par clip, une
  // fois ; ce que ça évite est un MP4 sans logo publié comme la livraison du
  // jour.
  if (fingerprint === null) return 'absente'
  if (fingerprint.version !== VERSION_FINGERPRINT) return 'recette'
  if (renderEstStale(fingerprint, clip)) return 'montage'
  // `clip.branding` en guise de tolérance : un clip qui ne demande pas de marque
  // n'a rien à excuser, son empreinte en porte zéro et la comparaison passe.
  if (observed.markers !== null && markersHaveMoved(fingerprint, observed.markers, clip.branding)) {
    return 'marques'
  }
  // **Seulement quand un document a été incrusté.** `captionsLook` à `null` dit
  // qu'il n'y en a pas eu, et le preset n'a alors rien décrit de l'image : le
  // comparer périmerait au premier réglage de police un clip qui n'en porte pas.
  if (
    observed.look !== null &&
    fingerprint.captionsLook !== null &&
    fingerprint.captionsLook !== lookDigest(observed.look)
  ) {
    return 'style'
  }
  // **`undefined` seul est « pas sondé ».** `null` est une réponse : « rien à
  // incruster maintenant », qui doit se comparer au `captionsContent` de
  // l'empreinte comme n'importe quelle autre valeur — c'est exactement ce qui
  // détecte une correction ayant vidé de mots les segments d'un clip qui
  // demande des sous-titres (#87).
  if (observed.text !== undefined && fingerprint.captionsContent !== digestOfCaptionsText(observed.text)) {
    return 'texte'
  }
  return null
}

/** `écartDeLEmpreinte` en booléen, pour les appelants qui n'ont pas à dire pourquoi. */
export function fingerprintToDay(
  fingerprint: FingerprintRender | null,
  clip: ShapeRendered,
  observed: ObservedBurnIn,
): boolean {
  return lFingerprintGap(fingerprint, clip, observed) === null
}

/** Ce que le journal dit de chaque écart, à qui n'a pas lu ce fichier. */
const GAP_REASON: Record<GapFingerprint, string> = {
  absente: "aucune empreinte ne dit ce qu'ils décrivent",
  recette: 'ils ont été produits par une recette de rendu antérieure',
  montage: 'le montage a changé depuis',
  marques: "les marques incrustées ne sont plus celles du dossier",
  style: "les sous-titres ont été incrustés avec un autre look",
  texte: 'le transcript a changé sur les segments de ce clip',
}

/**
 * La décision de saut, isolée et pure — `existe` et le verdict de l'empreinte
 * sont passés en arguments, donc elle se teste sans toucher au disque.
 *
 * **Les trois sorties comptent, pas seulement le MP4.** Un rendu interrompu juste
 * après l'encodage laisse le MP4 en place sans son `.txt` ni sa variante ; ne
 * regarder que le premier fichier ferait passer ce clip pour exporté et Julien
 * publierait sans description. Le graphe de l'itération 0 décide sur la présence
 * du fichier (spec §4), donc la présence doit couvrir tout ce que l'étape promet.
 *
 * **Et la présence ne suffit pas.** Elle ne dit rien de ce que les fichiers
 * contiennent : un jeu laissé par un montage abandonné, ou produit sous une
 * recette antérieure, la satisfait aussi bien qu'une livraison à jour, et
 * l'export répondait alors `skipped: true` sur une livraison fausse. C'est
 * `décritLeClip` — le verdict de `écartDeLEmpreinte` — qui répond à cette
 * question-là.
 *
 * **`skipped: true` reste un cas nominal** : il l'est quand il est vrai, et il
 * l'est chaque fois que l'empreinte décrit le clip.
 */
export function sauterRender(
  paths: PathsRender,
  exists: (path: string) => boolean,
  describedClip: boolean,
  force = false,
): boolean {
  if (force) return false
  if (!describedClip) return false
  return [paths.mp4, paths.variant9x16, paths.texts].every(
    (path) => path === null || exists(path),
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
export function redoOutputs(
  paths: PathsRender,
  exists: (path: string) => boolean,
  describedClip: boolean,
  force = false,
): boolean {
  if (force) return true
  // **Une empreinte qui ne décrit pas le clip rallume ffmpeg**, et pas seulement
  // un fichier manquant. Sans cette ligne, un jeu de MP4 complet mais périmé
  // sauterait l'encodage pour n'y réécrire que le `.txt` : le correctif de
  // `sauterLeRendu` ne ferait alors que déplacer le mensonge d'une fonction.
  if (!describedClip) return true
  return !exists(paths.mp4) || (paths.variant9x16 !== null && !exists(paths.variant9x16))
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
const STRIP_TOP = 0.13

/** La marge latérale, en fraction de la largeur du clip. */
const MARGIN = 0.05

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
const CAP_HAUTEUR = 0.06

/**
 * En dessous, une marque réduite cesse d'être lisible sur un téléphone. Un très
 * petit clip reçoit donc une marque proportionnellement plus grande plutôt
 * qu'illisible — et le plafond ci-dessus l'emporte quand même sur ce plancher :
 * une marque trop petite est un défaut cosmétique, une marque imprimée sous la
 * barre d'interface est un cadre raté.
 */
const WIDTH_MINIMUM = 80

/**
 * Ce que le dossier des marques peut porter, et à quelle largeur.
 *
 * Le logo est plus étroit que le filigrane d'openshorts (0,30) parce qu'il ne
 * cherche pas à être difficile à recadrer ; la mention Twitch l'est encore plus —
 * c'est une adresse, pas une signature. Les deux sont facultatives, et chacune se
 * rend seule.
 */
const MARKERS_EXPECTED: readonly { file: string; widthRatio: number; edge: Edge }[] = [
  { file: 'logo.png', widthRatio: 0.22, edge: 'gauche' },
  { file: 'twitch.png', widthRatio: 0.16, edge: 'droite' },
]

type Edge = 'gauche' | 'droite'

/** Une marque trouvée sur le disque, avec sa taille native. */
export type MarkerNative = {
  path: string
  nativeW: number
  nativeH: number
  widthRatio: number
  edge: Edge
  /**
   * Le condensat du fichier. Il ne sert pas au rendu — `planifierMarques`
   * l'ignore — mais à l'empreinte, qui doit distinguer deux images portant le
   * même nom fixe. Voir `contenuDeLaMarque`.
   */
  content: string
}

/** Une marque placée, dans la forme que `renderArgs` attend pour ses `logos`. */
export type PlacementMarker = { path: string; x: number; y: number; w: number; h: number }

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
export function scheduleMarkers(
  clipW: number,
  clipH: number,
  markers: readonly MarkerNative[],
): PlacementMarker[] {
  if (markers.length === 0) return []

  const margin = Math.round(clipW * MARGIN)
  const espace = pair(clipW - 2 * margin)
  const cap = clipH * CAP_HAUTEUR

  const sized = markers.map((m) => {
    let w = Math.max(WIDTH_MINIMUM, Math.round(clipW * m.widthRatio))
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
    if (h > cap) {
      w = Math.max(1, Math.round((w * cap) / h))
      h = cap
    }
    return { path: m.path, bord: m.edge, w: pair(w), h: pair(h) }
  })

  const stripTop = Math.round(clipH * STRIP_TOP)
  const median = stripTop + Math.max(...sized.map((d) => d.h)) / 2

  return sized.map((d) => ({
    path: d.path,
    w: d.w,
    h: d.h,
    x: Math.max(0, d.bord === 'gauche' ? margin : clipW - margin - d.w),
    y: Math.max(0, Math.round(median - d.h / 2)),
  }))
}

/** `assets/brand/` à la racine du dépôt. Ignoré par git : les marques sont à l'opérateur. */
function markersFolder(given?: string): string {
  return given ?? path.join(process.cwd(), 'assets', 'brand')
}

/** `fonts/`, où vit Anton — la police du preset de sous-titres par défaut. */
function fontsFolder(given?: string): string {
  return given ?? path.join(process.cwd(), 'fonts')
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
export async function collectMarkers(brandDir?: string): Promise<MarkerNative[]> {
  const folder = markersFolder(brandDir)
  const found: MarkerNative[] = []
  for (const expected of MARKERS_EXPECTED) {
    const filePath = path.join(folder, expected.file)
    if (!fs.existsSync(filePath)) continue
    // Le contenu avant le sondage : c'est la lecture la moins chère des deux, et
    // un fichier qu'on ne sait pas lire n'a pas besoin d'un ffprobe pour être
    // écarté. Une marque illisible se journalise et s'ignore, comme une marque
    // que ffprobe ne sait pas mesurer.
    let content: string
    try {
      content = fileContent(filePath)
    } catch (error) {
      console.warn(
        `Marque illisible, ignorée : ${filePath} (${error instanceof Error ? error.name : 'erreur inconnue'})`,
      )
      continue
    }
    const { width, height } = await probe(filePath)
    if (width === null || height === null || width <= 0 || height <= 0) {
      console.warn(`Marque illisible, ignorée : ${filePath}`)
      continue
    }
    found.push({
      path: filePath,
      nativeW: width,
      nativeH: height,
      widthRatio: expected.widthRatio,
      edge: expected.edge,
      content,
    })
  }
  return found
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
export function markerRejectFaute(
  branding: boolean,
  markers: readonly MarkerNative[],
): boolean {
  return branding && markers.length === 0
}

/** Les mots-dièse d'un texte, dédoublonnés sans tenir compte de la casse. */
export function wordsHash(text: string): string[] {
  const seen = new Set<string>()
  const output: string[] = []
  for (const found of text.matchAll(/#[\p{L}\p{N}_]+/gu)) {
    const key = found[0].toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    output.push(found[0])
  }
  return output
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
export function publicationText(clip: Clip): string {
  const title = clip.title.trim()
  const description = clip.description.trim()
  const hashes = wordsHash(`${title}\n${description}`)
  return [
    `Titre : ${title === '' ? '(sans titre)' : title}`,
    '',
    'Description :',
    description === '' ? '(sans description)' : description,
    '',
    `Mots-dièse : ${hashes.length === 0 ? '(aucun)' : hashes.join(' ')}`,
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
async function writeFile(filePath: string, content: string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  const temporary = pathTemporary(filePath)
  try {
    await fsp.writeFile(temporary, content, 'utf8')
    await fsp.rename(temporary, filePath)
  } catch (cause) {
    await fsp.rm(temporary, { force: true }).catch(() => {})
    throw cause
  }
}

/**
 * Écrit le `.txt` de publication, **depuis la base et sans point d'attente**, et
 * c'est le troisième point de #48.
 *
 * Deux chemins écrivent ce fichier — la route `PATCH`, quand le texte change, et
 * `renderClip`, à chaque export — et rien ne disait lequel des deux fait foi.
 * Chacun passait par un nom temporaire renommé, donc aucun mélange, mais le
 * dernier renommage gagnait, et il pouvait porter le texte le plus ancien :
 * `renderClip` relisait le clip *avant* un `await`, si bien qu'un `PATCH` glissé
 * dans cette fenêtre écrivait le bon texte pour se le faire écraser aussitôt.
 *
 * **La règle, désormais, tient en une phrase : le `.txt` porte l'état de la base
 * au moment de son écriture.** Elle est tenue par la forme de cette fonction et
 * non par la discipline de ses appelants : la relecture, la sérialisation et le
 * renommage sont synchrones et se suivent sans `await`, donc rien ne s'intercale
 * — `better-sqlite3` est synchrone et Node a un seul fil. Prendre le `clipId`
 * plutôt qu'un clip rend le défaut impossible à réintroduire par distraction,
 * comme pour `marquerExporté`.
 *
 * Le coût est une écriture synchrone de quelques centaines d'octets sur un
 * disque local, dans une route qui, elle, dure de dix secondes à une minute.
 *
 * `repli` ne sert qu'au clip supprimé pendant l'export, dont les fichiers
 * méritent quand même leur texte.
 */
export function publicationWriteText(
  db: Database.Database,
  clipId: string,
  fallback: Clip,
  filePath: string,
): void {
  const content = publicationText(getClip(db, clipId) ?? fallback)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = pathTemporary(filePath)
  try {
    fs.writeFileSync(temporary, content, 'utf8')
    fs.renameSync(temporary, filePath)
  } catch (cause) {
    try {
      fs.rmSync(temporary, { force: true })
    } catch {
      // Le provisoire a pu ne jamais être créé ; sans conséquence.
    }
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
export async function renderClip(clipId: string, options: OptionsRender = {}): Promise<RenderResult> {
  const db = options.db ?? getDb()
  const clip = getClip(db, clipId)
  if (clip === undefined) throw new Error(`Clip inconnu : ${clipId}`)

  const project = getProject(db, clip.projectId)
  if (project === undefined) {
    throw new Error(`Projet inconnu pour le clip ${clipId} : ${clip.projectId}`)
  }

  // **Le cadrage se résout ici, une fois, et tout ce qui suit le suit.** Le
  // ratio ne vient plus du clip et n'est plus unique : `computeFraming` en
  // choisit un **par plan**, le plus serré qu'une position fixe y tienne
  // (spec §10) — sauf quand l'humain l'a épinglé, auquel cas c'est le sien
  // partout, avec les crops recalculés pour lui. `'auto'` n'atteint donc jamais
  // `cropRect`, dont la table des ratios n'a pas cette clé.
  //
  // Les deux sorties n'en font pas le même usage : le **natif** garde un seul
  // ratio pour tout le clip — le plus large des plans, `framing.ratio` —, la
  // **variante 9:16** pose chaque plan à son propre ratio sur son canevas
  // vertical. Le raisonnement est en tête de `src/core/cadrage.ts`.
  //
  // Quand l'analyse manque, `clipFraming` se rabat sur le réglage manuel du
  // clip et le dit dans `origin` — l'écran l'affiche, et le journal aussi
  // quelques lignes plus bas.
  const framing = clipFraming(clip)
  const ratio = framing.ratio
  const framingSnapshot = renderedFraming(framing)
  const paths = pathsRender(clip.projectId, clipId, ratio)

  // **L'EDL se valide avant la décision de saut**, et l'ordre compte : l'édition
  // autorise de vider un clip, et un clip vidé après un premier export a encore
  // ses fichiers. Le saut le rendrait alors `skipped: true` en le marquant
  // exporté, alors qu'il ne décrit plus rien. (relevé par Copilot)
  const duration = clipDuration(clip.segments)
  if (duration <= 0) {
    throw new Error(
      `Le clip ${clipId} ne porte aucun segment à rendre. Un clip est une liste de segments, et une liste vide n'a pas de durée.`,
    )
  }

  // **Les marques que le dossier porte aujourd'hui, avant la décision de saut.**
  // L'empreinte dit lesquelles ont été incrustées ; les comparer suppose de
  // savoir lesquelles le seraient maintenant. Deux `existsSync` et deux sondages
  // sur un dossier local — rien à voir avec l'aller-retour en 9p que la décision
  // de saut continue d'éviter, le transcript n'étant lu que plus bas.
  //
  // Le dossier ne se lit que si le clip en veut : un clip sans marque n'a rien à
  // comparer, et `branding` passé à faux se voit déjà dans les cinq champs.
  const markers = clip.branding ? await collectMarkers(options.brandDir) : []

  // Le look entre dans l'empreinte, donc il se résout avant la décision de saut
  // et non plus au moment d'écrire le `.ass`. Les polices se relèvent ici **sans
  // rien dire** : l'avertissement appartient au chemin qui encode, et le poser
  // ici le ferait sonner à chaque export sauté.
  const look: CaptionsLook = {
    style: options.style ?? DEFAULT_CAPTION_STYLE,
    fonts: fontsDigest(fontsFolder(options.fontsDir)),
  }

  // **Le document qu'on incrusterait maintenant, avant la décision de saut
  // (#87).** Sans lui, une correction du transcript qui ne touche aucun
  // segment de ce clip laisserait `sauterLeRendu` reprendre un MP4 qui porte
  // encore les anciens mots — c'est exactement le chemin que la correction
  // manuelle de la PR #86 a ouvert : elle ne touche aux segments d'aucun clip.
  //
  // **Un aller-retour sur le Drive, à la différence des marques et du look
  // juste au-dessus.** C'est nouveau : jusqu'ici la décision de saut l'évitait
  // exprès (voir le commentaire de `EmpreinteRendu.captionsLook`), parce
  // qu'aucun des huit champs d'avant ne pouvait bouger sans que le graphe
  // refasse ce qui en dépend. Le texte, si — c'est tout le défaut que #87
  // ferme —, et rien d'autre ne peut le voir. Seulement quand le clip demande
  // des sous-titres : sans cela, `captionsLook` comme `captionsContent` valent
  // déjà `null` dans l'empreinte, et rien ne doit dépendre du transcript pour
  // un clip qui ne l'affiche pas (spec §4).
  //
  // Calculé une seule fois pour tout le passage : la décision de saut s'en
  // sert ici, et l'écriture du `.ass` plus bas réutilise le même document
  // plutôt que de relire le transcript une seconde fois.
  const textCurrent: string | null = clip.captions ? await currentCaptionsDocument(clip, project, look.style) : null

  // Ce que les fichiers présents décrivent, s'il y en a.
  const gap = lFingerprintGap(lireFingerprint(paths.fingerprint), renderedShape(clip, framingSnapshot), {
    markers,
    look,
    text: textCurrent,
  })

  // **Le refus de sauter se dit.** C'est tout le défaut qu'on ferme : un rendu
  // périmé était repris pour bon sans un mot, et l'interface présente
  // `skipped: true` comme un succès (spec §3.4). Le réencodage se voit déjà —
  // l'export dure alors dix secondes au lieu d'aucune — mais rien ne disait
  // pourquoi. Sous `force`, la décision ne vient pas de l'empreinte : on se tait.
  if (gap !== null && options.force !== true && fs.existsSync(paths.mp4)) {
    console.warn(
      `Clip ${clipId} : des rendus sont là mais ${GAP_REASON[gap]}. Ils sont refaits.`,
    )
  }

  // **Le transcript est déjà lu, si le clip demande des sous-titres** — voir
  // `texteActuel` ci-dessus (#87). Ce n'était pas le cas avant : le sidecar vit
  // sur le Drive partagé, monté en 9p, lent et sujet au décrochage, et la
  // décision de saut évitait cet aller-retour tant que rien ne pouvait le
  // rendre nécessaire. Un clip sans sous-titres continue de l'éviter.
  if (sauterRender(paths, (c) => fs.existsSync(c), gap === null, options.force)) {
    // **Le `.txt` se réécrit même quand le rendu saute**, et c'est le seul des
    // trois à le faire. Il ne coûte rien, et c'est celui qu'on retouche le plus :
    // corriger une faute dans la description puis relancer l'export ne doit pas
    // exiger un `--force` qui réencoderait trois minutes de vidéo pour rien.
    // (relevé par Aristarque)
    publicationWriteText(db, clipId, clip, paths.texts)
    // La variante d'un ratio abandonné s'efface ici aussi. Le chemin non sauté le
    // fait déjà ; sans cela, un clip dont le ratio natif retombe à 9:16 et dont
    // les sorties sont complètes garderait son ancienne variante alors que
    // `RenderResult` annonce qu'il n'y en a pas. (relevé par Aristarque)
    if (paths.variant9x16 === null) {
      fs.rmSync(pathVariant(clip.projectId, clipId), { force: true })
    }
    // **Le même contrôle qu'à la fin du chemin long, et il manquait ici.** Ce
    // chemin-ci n'encode pas, mais il écrit quand même — le `.txt` — et il pose
    // `exported`. Sans lui, un montage modifié entre la décision de saut et
    // cette ligne faisait annoncer « exporté » sur des fichiers que le `PATCH`
    // venait d'effacer. Le chemin long refusait ce cas depuis toujours ; celui-ci
    // ne le voyait pas.
    if (discardRenderStale(db, clipId, paths, clip, framingSnapshot)) {
      throw new Error(
        `Le clip ${clipId} a été modifié pendant son export : les fichiers présents décrivaient le montage d'avant et ont été écartés. Relancer l'export.`,
      )
    }

    // **Le statut se répare ici aussi.** Un processus arrêté entre l'écriture du
    // `.txt` et la mise à jour du statut laisse toutes les sorties en place : la
    // relance sauterait, et le clip resterait en « kept » pour toujours sans que
    // rien ne puisse le rattraper. La présence des fichiers fait foi en itération
    // 0 (spec §4), donc elle vaut aussi pour le statut. (relevé par Copilot)
    markExported(db, clipId, clip, framingSnapshot)
    return {
      mp4: paths.mp4,
      variant9x16: paths.variant9x16,
      texts: paths.texts,
      skipped: true,
    }
  }

  // **L'encodeur se résout à l'appel, dans la fonction paresseuse.** `encoderName`
  // lève sur un `FFMPEG_ENCODER` inconnu — refus voulu, jamais un repli silencieux
  // — et le résoudre ici le ferait lever aussi sur un clip dont le MP4 est déjà
  // là. C'est la leçon relevée sur `buildProxy` : un artefact présent doit revenir
  // tout de suite, quoi que porte l'environnement.
  const encoder = (): EncoderName => options.encoder ?? encoderName()

  // Vrai dès que ffmpeg a réellement produit le MP4 natif dans ce passage :
  // c'est lui qui décide du sort du `.ass` provisoire, dans le `finally`.
  let nativeEncoded = false

  // **Les deux sorties se rendent depuis la source et se refont ensemble.** La
  // variante partait du MP4 natif ; elle en héritait alors les sous-titres dans
  // son fond flouté (#22). C'est aussi ce qui rend le ratio par plan gratuit :
  // les deux étant deux rendus indépendants, un plan serré n'est jamais rétréci
  // deux fois.
  //
  // **On ne prépare que ce qu'un encodage va vraiment consommer.** Un passage
  // interrompu juste après l'encodage laisse les MP4 sans leur `.txt` : cette
  // reprise-là n'a rien à faire du transcript, qui vit sur le Drive et coûte un
  // aller-retour en 9p, ni des sondages ffprobe.
  if (redoOutputs(paths, (c) => fs.existsSync(c), gap === null, options.force)) {
    // **La copie de travail, pas le Drive — et son absence se répare ici.** Ce
    // commentaire disait déjà « son absence se répare en réingérant » et le code
    // se contentait de lever en le prescrivant : or rien dans l'application ne
    // savait déclencher une réingestion, `CIBLES_LANÇABLES` ne l'expose pas, et
    // un projet dont tous les artefacts existent planifie un plan vide. Le seul
    // remède était un script dans un terminal, ce que le critère de réussite de
    // la conception exclut. Et le TTL de huit heures posé par cette même
    // livraison en aurait fait le cas normal plutôt que l'accident. (issue #76)
    //
    // `ensureLocalCopy` sonde le montage sous délai de garde avant de promettre
    // quoi que ce soit, passe par le verrou des copies — deux exports lancés
    // coup sur coup sur la même émission attendent la même copie —, et laisse le
    // message qui dit quoi faire en dernier recours, pour le montage muet ou
    // l'original disparu.
    const src = await ensureLocalCopy(project, { db })
    // **Et on la tient jusqu'à la fin du rendu.** `ensureLocalCopy` ne protège
    // la copie que pendant sa recopie ; ensuite le rendu la lit — lecture du
    // transcript, sondage des dimensions, puis dix secondes à une minute
    // d'encodage — et le TTL de huit heures s'applique à elle comme aux autres.
    // Un balayage, celui du démarrage ou celui qui suit une analyse, pouvait
    // donc l'effacer entre ce retour et l'ouverture du fichier par ffmpeg :
    // `copiesInUse` ne connaît que les analyses, pas les exports.
    // (relevé par Copilot)
    const releaseCopy = holdStagedCopy(src)
    try {

      // **La porte des marques, et elle est ici pour deux raisons.** Avant tout ce
      // qui coûte : la lecture du transcript traverse le Drive en 9p, l'encodage
      // dure de dix secondes à une minute, et `POST /api/clips/:id/export` est
      // synchrone — personne n'attend une minute pour apprendre qu'il manquait un
      // PNG de quarante kilo-octets. Et après la copie de travail : sans source il
      // n'y a rien à cadrer, là où une marque absente est un défaut de la
      // livraison et non de l'entrée.
      //
      // **Le chemin du saut ne refuse toujours pas**, et c'est délibéré : y
      // refuser ferait échouer une relance qui se contente de réécrire un `.txt`
      // sans rien changer aux fichiers livrés.
      //
      // Ce qui a changé avec #48, c'est qu'il ne saute plus à l'aveugle. Un clip
      // exporté sans marque avant #37 n'a pas d'empreinte, donc il ne saute plus,
      // donc il arrive ici et se refait — ou refuse en le disant, si le dossier
      // est vide. Le `force` reste, il n'est simplement plus le seul remède, ni
      // un remède qu'il faut avoir lu ce commentaire pour connaître.
      //
      // Le dossier a été lu plus haut, pour comparer l'empreinte : la porte se
      // contente d'en juger, et l'ordre des erreurs ne change pas — la copie de
      // travail manquante se dit toujours avant la marque manquante.
      if (markerRejectFaute(clip.branding, markers)) {
        // **« Aucune exploitable » et non « aucune présente ».** `probe` ne lève
        // jamais : un PNG corrompu, comme un ffprobe absent, rend un sondage vide
        // et `collecterMarques` écarte la marque en le journalisant. Dire que le
        // dossier est vide serait alors faux, et enverrait chercher un fichier qui
        // est là.
        throw new Error(
          `Le clip ${clipId} demande des marques et aucune n'est exploitable : ni ` +
            `${MARKERS_EXPECTED.map((m) => m.file).join(' ni ')} — absentes, ou illisibles et ` +
            `alors signalées au journal. L'export livrerait un MP4 sans logo sans un mot, et le rendu ` +
            `est la dernière étape avant publication. Déposer au moins l'une d'elles dans ` +
            `assets/brand/ (son README dit le format), ou passer branding à false sur ce clip.`,
        )
      }

      // **Le `.ass` s'écrit d'abord sous un nom temporaire.** Il est gardé sur le
      // disque pour relire ce que libass a incrusté, et `produireArtefact` conserve
      // l'ancien MP4 quand ffmpeg échoue : écrire directement sur le nom définitif
      // laisserait, après un rendu forcé raté, l'ASS d'une tentative qui n'a rien
      // produit à côté d'une vidéo d'avant. Le sidecar ne bouge qu'une fois le MP4
      // en place. (relevé par Copilot)
      // Le document a déjà été calculé plus haut, en `texteActuel` — pour la
      // décision de saut autant que pour ceci, une seule lecture du transcript.
      const assProvisional = clip.captions
        ? await writeCaptionsDocument(clip.id, textCurrent, pathTemporary(paths.ass))
        : undefined
      // Le dossier de polices n'a de sens qu'avec un `.ass` à incruster : en parler
      // sans cela ferait avertir sur un clip qui n'a pas de sous-titres. Son
      // *contenu*, lui, a déjà été relevé plus haut pour l'empreinte.
      const fontsDir =
        assProvisional === undefined ? undefined : fontsUsableFolder(options.fontsDir)

      try {
        const size = await dimensionsSource(src)

        // **Le montage découpé aux frontières de plans.** C'est ici que le cadre
        // cesse d'être unique : un segment qui traverse cinq plans devient cinq
        // entrées, chacune avec le ratio et la position de son plan, et le cadre
        // saute là où une coupe existe déjà.
        //
        // **La somme des durées ne bouge pas**, et c'est ce dont dépend le
        // recalage des sous-titres : `splitByShot` recopie les bornes
        // intermédiaires au lieu de les recalculer, donc chaque segment se
        // retrouve couvert exactement. `sousTitresDuClip` continue de lire
        // `clip.segments`, comme avant, et n'a rien à savoir de ce découpage.
        const pieces = splitByShot(
          clip.segments,
          framing.shots,
          // Le repli d'un intervalle qu'aucun plan ne couvre : le cadre le plus
          // large, centré. Le plus large parce qu'on ne sait rien de ce qui s'y
          // passe et qu'un 9:16 aveugle jetterait 68 % de la largeur sans le dire
          // — c'est déjà ce que `chooseRatio` fait quand il ne mesure rien. Centré,
          // comme `computeFraming` centre un plan sur lequel il n'a rien mesuré :
          // deux défauts qui divergent finissent par se contredire.
          { ratio: '16:9', cropX: 0.5, cropXNative: 0.5 },
        )

        // **Un décodeur par entrée**, et le graphe est mesuré bon jusqu'à une
        // dizaine (`renderArgs`). Le découpage par plan en ajoute : la médiane des
        // plans est de 5,3 s sur `2026-03-08-caro-mdlm`, donc un clip d'une minute
        // peut en traverser une douzaine. On le dit plutôt que de le découvrir sur
        // un export qui rame — il n'y a rien à décider ici, et refuser serait pire
        // que lent.
        if (pieces.length > PIECE_COUNT_WARN) {
          console.warn(
            `Clip ${clipId} : ${pieces.length} morceaux à décoder (${clip.segments.length} segments ` +
              `découpés sur ${framing.shots.length} plans). Chacun ouvre un décodeur ; au-delà d'une ` +
              `dizaine, l'export ralentit.`,
          )
        }

        // **Le natif garde un seul ratio pour tout le clip** — seule la position
        // saute aux frontières. La variante, elle, prend le ratio de chaque plan.
        const out = outputSize(ratio)
        const verticalCanvas = outputSize('9:16')
        const nativePieces: FramedSegment[] = pieces.map((m) => ({
          start: m.start,
          end: m.end,
          ratio,
          crop: cropRect(ratio, m.cropXNative, size.w, size.h),
        }))
        const verticalPieces: FramedSegment[] = pieces.map((m) => ({
          start: m.start,
          end: m.end,
          ratio: m.ratio,
          crop: cropRect(m.ratio, m.cropX, size.w, size.h),
        }))

        // **Les marques sont planifiées sur le canevas de CHAQUE sortie**, et non
        // une fois pour les deux : elles s'incrustent après la composition, à la
        // taille du fichier produit, et `planifierMarques` raisonne en fractions
        // de ce canevas. Les planifier une seule fois poserait dans la variante
        // une bande calculée pour un autre format. C'est la même raison que pour
        // les sous-titres — voir `renderArgs`.
        const logos = scheduleMarkers(out.w, out.h, markers)
        const verticalLogos = scheduleMarkers(verticalCanvas.w, verticalCanvas.h, markers)

        // **La variante périmée s'efface avant le PREMIER encodage**, et non entre
        // les deux. Elle ne décrit déjà plus le montage qu'on est en train de
        // rendre ; la laisser le temps du natif ouvre une fenêtre où un arrêt
        // brutal — coupure, tueur de mémoire — laisse l'ancienne 9:16 à côté d'un
        // natif tout neuf, et la relance suivante, sans `force`, trouve les trois
        // sorties présentes et saute définitivement sur cette paire incohérente.
        // Effacée d'abord, n'importe quelle interruption laisse une sortie
        // manquante, donc réessayable. (relevé par Copilot)
        const variant = paths.variant9x16
        if (variant !== null) fs.rmSync(variant, { force: true })

        // **L'empreinte d'avant part avec elle, et pour la même raison poussée
        // d'un cran.** Elle certifie les MP4 qu'on est en train de remplacer : la
        // laisser en place le temps des deux encodages laisse `livraisonÀJour`
        // répondre vrai sur une paire à moitié réécrite, et rien ne le signale
        // puisqu'un `GET` ne sonde pas le dossier des marques. N'importe quelle
        // sortie de ce bloc — interruption, refus de certifier plus bas — laisse
        // alors des fichiers que rien ne certifie, donc à refaire.
        // (relevé par Copilot)
        fs.rmSync(paths.fingerprint, { force: true })

        await produceArtifact({
          dst: paths.mp4,
          // `true` et non `options.force` : la décision est prise au-dessus, une
          // fois pour les deux sorties. La laisser se reprendre ici ferait sauter
          // un natif présent dont la variante manque, et la paire repartirait de
          // deux montages. (relevé par Codex et Copilot)
          force: true,
          durationSec: duration,
          onProgress: (a) => options.onProgress?.({ ...a, output: 'natif' }),
          what: `rendu ${ratio} du clip ${clipId}`,
          args: (destination) =>
            renderArgs({
              src,
              segments: nativePieces,
              out,
              assPath: assProvisional,
              fontsDir,
              logos,
              dst: destination,
              encoder: encoder(),
            }),
        })
        // `produireArtefact` ne peut pas sauter avec `force: true` : arriver ici,
        // c'est que le MP4 natif vient d'être écrit, donc que le `.ass` provisoire
        // décrit bien la vidéo posée sur le disque.
        nativeEncoded = true

        // **La variante suit le natif, toujours** : ils décrivent le même montage,
        // et un natif réencodé alors que la variante est restée en place laisserait
        // deux fichiers qui ne racontent plus la même chose — l'appel suivant, les
        // trouvant tous les deux, sauterait sans un mot. (relevé par Aristarque)
        if (variant !== null) {
          await produceArtifact({
            dst: variant,
            force: true,
            durationSec: duration,
            onProgress: (a) => options.onProgress?.({ ...a, output: '9x16' }),
            what: `variante 9:16 du clip ${clipId}`,
            args: (destination) =>
              blurredVariantArgs({
                src,
                segments: verticalPieces,
                out: verticalCanvas,
                assPath: assProvisional,
                fontsDir,
                logos: verticalLogos,
                dst: destination,
                encoder: encoder(),
              }),
          })
        }

        // **L'empreinte se pose une fois les deux sorties écrites, jamais avant.**
        // Une interruption entre les deux laisse alors des fichiers sans
        // empreinte, donc à refaire — l'ordre inverse laisserait une empreinte qui
        // certifie un MP4 qui n'existe pas, ou qui n'est écrit qu'à moitié.
        //
        // Elle porte **ce qui a été incrusté** : les marques réellement posées et
        // non ce que `branding` demandait, et le preset avec lequel les
        // sous-titres l'ont été. C'est ce qui distingue un rendu d'aujourd'hui des
        // trois du 18 août, sur lesquels `branding` valait `true` sans qu'aucune
        // marque n'ait été incrustée.
        //
        // **Les marques sont relues avant d'être certifiées.** Elles ont été
        // sondées avant la décision de saut, et les deux ffmpeg rouvrent ensuite
        // les mêmes chemins : un PNG remplacé pendant l'export peut se retrouver
        // incrusté dans la variante et pas dans le natif, pendant que l'empreinte
        // certifierait le condensat d'avant — et le clip partirait `exported` sur
        // deux fichiers qui ne montrent pas la même marque. On ne certifie que ce
        // qu'on a pu vérifier ; sans empreinte, l'export suivant les refait.
        // (relevé par Copilot)
        //
        // Un dossier vidé pendant l'export déclenche donc, lui aussi : ce qui a
        // été incrusté l'a bien été, mais plus rien ne permet de le vérifier, et
        // une empreinte qui affirme sans avoir vérifié est exactement ce que
        // cette PR ferme.
        const fingerprint = renderFingerprint(renderedShape(clip, framingSnapshot), markers, {
          burnedIn: assProvisional !== undefined,
          look,
          text: textCurrent,
        })
        const markersAfter = clip.branding ? await collectMarkers(options.brandDir) : []
        // **Sans la tolérance du dossier vide.** Elle existe pour ne pas détruire
        // une livraison déjà faite quand on ne sait plus ce qu'elle porte ; ici on
        // décide de *certifier* celle qu'on vient de faire, et ne pas savoir n'est
        // pas une raison d'affirmer. Un logo remplacé entre les deux encodages
        // puis retiré avant ce contrôle passait sinon inaperçu.
        // (relevé par Codex)
        if (markersHaveMoved(fingerprint, markersAfter, false)) {
          throw new Error(
            `Les marques du clip ${clipId} ne sont plus celles qui ont servi à son export : les deux sorties peuvent ne pas porter la même, et rien ne permet de le vérifier. Aucune empreinte n'est posée, l'export suivant les refera. Relancer l'export.`,
          )
        }
        await writeFingerprint(paths.fingerprint, fingerprint)
      } finally {
        // Le sidecar définitif suit le MP4, et seulement lui : un rendu raté laisse
        // en place celui qui décrit la vidéo réellement posée sur le disque.
        if (nativeEncoded) {
          if (assProvisional === undefined) fs.rmSync(paths.ass, { force: true })
          else await fsp.rename(assProvisional, paths.ass)
        } else if (assProvisional !== undefined) {
          await fsp.rm(assProvisional, { force: true }).catch(() => {})
        }
      }
    } finally {
      releaseCopy()
    }
  }

  // Un clip dont le ratio natif retombe à 9:16 n'a plus de variante à produire,
  // et l'ancienne resterait à côté du nouveau MP4 en ressemblant à une livraison
  // à jour — alors que `RenderResult` annonce qu'il n'y en a pas.
  // (relevé par Copilot)
  if (paths.variant9x16 === null) {
    fs.rmSync(pathVariant(clip.projectId, clipId), { force: true })
  }

  // **Le titre et la description se relisent en base, pour la même raison que le
  // statut.** `clip` est l'instantané d'avant l'encodage, qui a duré des minutes :
  // écrire le `.txt` depuis lui livrerait la description que l'utilisateur vient
  // de corriger pendant ce temps. La relecture et l'écriture se suivent sans
  // point d'attente — voir `écrireTexteDePublication`, qui porte l'arbitrage
  // entre ce chemin-ci et celui du `PATCH`.
  publicationWriteText(db, clipId, clip, paths.texts)

  // **Le montage a-t-il bougé pendant l'encodage ?** Si oui, les fichiers qu'on
  // vient de produire décrivent un cadre que personne ne veut plus : on les
  // retire et on échoue franchement, plutôt que de les laisser sur le disque où
  // l'export suivant les prendrait pour bons. C'est le prix d'un modèle où la
  // présence du fichier fait foi.
  if (discardRenderStale(db, clipId, paths, clip, framingSnapshot)) {
    throw new Error(
      `Le clip ${clipId} a été modifié pendant son export : les fichiers produits décrivaient le montage d'avant et ont été écartés. Relancer l'export.`,
    )
  }

  // Le statut ne bouge qu'une fois les fichiers sur le disque : le poser avant
  // l'encodage protégerait un clip qui n'existe pas.
  markExported(db, clipId, clip, framingSnapshot)

  return {
    mp4: paths.mp4,
    variant9x16: paths.variant9x16,
    texts: paths.texts,
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
 * `rendu` est le clip tel qu'il a été lu au début de l'export : son statut sert
 * à reconnaître une décision prise depuis, et ses cinq champs d'image à
 * reconnaître un montage qui a bougé — voir plus bas.
 *
 * `better-sqlite3` est synchrone : rien de ce processus ne s'intercale entre la
 * relecture et l'écriture. Et un clip supprimé pendant le rendu n'est pas
 * ressuscité, puisqu'on n'écrit que ce qu'on vient de lire.
 */
export function markExported(
  db: Database.Database,
  clipId: string,
  render: Clip,
  framing: RenderedFraming,
): void {
  const toDay = getClip(db, clipId)
  if (toDay === undefined) return
  if (toDay.status === 'exported') return
  // **Toute décision prise pendant l'encodage l'emporte.** L'écart de statut
  // couvre tout ce que l'interface offre comme *décision* : écarter le clip, ou
  // rappuyer sur « Gardé », qui le ramène à `candidate`
  // (`src/lib/clip-status.ts`). (relevé par Copilot)
  if (toDay.status !== render.status) {
    console.warn(
      `Clip ${clipId} : passé de « ${render.status} » à « ${toDay.status} » pendant l'export. Les fichiers sont produits, la décision est conservée.`,
    )
    return
  }
  // **Mais l'écart de statut ne couvrait pas le montage, et c'est le premier
  // point de #48.** Retirer un passage, déplacer une borne ou changer le ratio
  // ne change pas le statut : un clip `kept` reste `kept`, et cette fonction
  // posait alors `exported` sur des fichiers qui décrivent le montage d'avant.
  // Le clip se disait livré, `sortiesDuClip` publiait ses URL, et l'interface
  // les affichait comme la livraison du jour.
  //
  // Les deux appelants de `renderClip` passent déjà par `écarterRenduPérimé`
  // une ligne plus haut, qui lève sur ce cas. Ce contrôle-ci n'en est pas la
  // répétition : il rend la garantie **intrinsèque à la fonction** plutôt que
  // dépendante de l'ordre des appels, et cette fonction est exportée.
  if (renderEstStale(renderedShape(render, framing), renderedShape(toDay, renderedFraming(clipFraming(toDay))))) {
    console.warn(
      `Clip ${clipId} : le montage a changé pendant l'export. Les fichiers produits décrivent le montage d'avant, le statut n'est pas posé.`,
    )
    return
  }
  putClip(db, { ...toDay, status: 'exported' })
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
export function discardRenderStale(
  db: Database.Database,
  clipId: string,
  paths: PathsRender,
  render: Clip,
  framing: RenderedFraming,
  /**
   * Comment obtenir le cadrage du clip **relu**.
   *
   * **Injecté, et le défaut n'est pas le cas intéressant.** `clipFraming` lit
   * `analysis.json`, donc peut lever sur un refus de droits ou un montage mort.
   * Appelée depuis `PATCH /api/clips/:id`, cette fonction s'exécute *après*
   * l'écriture en base, et la route avale ce qui lève — mais son rattrapage
   * redescend un clip `exported` à `kept`. Une panne passagère de système de
   * fichiers ferait donc disparaître les sorties d'un rendu parfaitement valide,
   * sur une simple correction de titre. La route passe donc un résolveur bâti
   * sur l'analyse qu'elle a lue **avant** d'écrire, et rien de faillible ne
   * subsiste après le point de non-retour. (relevé par Codex)
   */
  rereadFraming: (clip: Clip) => RenderedFraming = (clip) => renderedFraming(clipFraming(clip)),
): boolean {
  const toDay = getClip(db, clipId)
  if (toDay === undefined) return false
  // **Le cadrage d'après se recalcule sur le clip relu**, pas sur celui qu'on
  // avait : c'est tout l'objet du contrôle. Retirer un passage où un comédien
  // traverse le plateau peut faire retomber un 16:9 en 1:1 sans qu'aucun champ
  // du clip ne dise « cadrage », et les fichiers montreraient alors un cadre que
  // plus personne ne veut.
  if (!renderEstStale(renderedShape(render, framing), renderedShape(toDay, rereadFraming(toDay))))
    return false

  // **L'empreinte part la première.** Elle est ce qui certifie les autres : un
  // échec au milieu de cette boucle doit laisser des fichiers sans empreinte —
  // donc à refaire — et jamais une empreinte sans les fichiers qu'elle décrit,
  // qui ferait sauter l'export suivant sur une livraison amputée.
  for (const path of [paths.fingerprint, paths.mp4, paths.variant9x16, paths.texts]) {
    if (path !== null) fs.rmSync(path, { force: true })
  }
  if (toDay.status === 'exported') putClip(db, { ...toDay, status: 'kept' })
  return true
}

/**
 * Vrai quand ce qui a été rendu ne décrit plus le clip.
 *
 * **Seuls les champs que l'encodage consomme comptent.** Les segments, le
 * cadrage résolu, les sous-titres et la marque sont dans l'image : les changer
 * périme le fichier. Le titre et la description, eux, ne vont que dans le `.txt`,
 * qui est réécrit depuis l'état à jour — les compter ici ferait perdre son
 * statut à un clip dont on a seulement corrigé une faute de frappe. Et `ratio`
 * comme `cropX` n'y sont plus : c'est `framing` qui porte ce que ffmpeg a
 * réellement découpé, voir `FormeRendue`.
 *
 * **Elle prend une `FormeRendue`, pas un `Clip`**, et c'est ce qui permet de lui
 * passer aussi bien deux clips qu'une empreinte et un clip : la liste des champs
 * qui comptent est écrite une fois, ici, et les deux comparaisons ne peuvent pas
 * diverger.
 *
 * Pure, donc testable sans base ni ffmpeg.
 */
export function renderEstStale(render: ShapeRendered, toDay: ShapeRendered): boolean {
  const sameSegments =
    render.segments.length === toDay.segments.length &&
    render.segments.every(
      (s, i) => s.start === toDay.segments[i].start && s.end === toDay.segments[i].end,
    )
  // **Le cadrage se compare en profondeur, comme les segments.** Un `!==` sur un
  // `cropX` unique suffisait quand il n'y en avait qu'un ; il y en a désormais un
  // par plan, et deux tableaux de crops identiques ne sont jamais le même objet.
  // Comparés par référence, ils seraient toujours différents — chaque appel
  // périmerait le rendu, l'export réencoderait à chaque passage, et `skipped`
  // ne serait plus jamais vrai.
  const sameFraming =
    render.framing.ratio === toDay.framing.ratio &&
    render.framing.shots.length === toDay.framing.shots.length &&
    render.framing.shots.every(
      (p, i) =>
        p.start === toDay.framing.shots[i].start &&
        p.end === toDay.framing.shots[i].end &&
        p.ratio === toDay.framing.shots[i].ratio &&
        p.cropX === toDay.framing.shots[i].cropX &&
        p.cropXNative === toDay.framing.shots[i].cropXNative,
    )
  return (
    !sameSegments ||
    !sameFraming ||
    render.captions !== toDay.captions ||
    render.branding !== toDay.branding
  )
}

/**
 * Le dossier de polices, seulement s'il existe.
 *
 * `fontsdir` pointant nulle part n'est pas une erreur pour libass : il se rabat
 * sur fontconfig, ne trouve pas Anton, et incruste les sous-titres dans une autre
 * police — sans un mot. On préfère l'omettre et le dire.
 */
function fontsUsableFolder(given?: string): string | undefined {
  const folder = fontsFolder(given)
  if (fs.existsSync(folder)) return folder
  console.warn(
    `Dossier de polices introuvable (${folder}) : les sous-titres seront incrustés dans la police que libass trouvera.`,
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
export function clipUnderTitles(
  words: Word[],
  segments: Segment[],
  style: CaptionStyle,
): string | null {
  const recalibrated = retimeWords(words, segments)
  const cards = splitIntoCards(recalibrated, style.maxChars, style.maxDuration)
  return cards.length === 0 ? null : renderAss(cards, style)
}

/**
 * Le document ASS qu'on incrusterait maintenant pour ce clip, sans rien
 * écrire — ou `null` si aucun mot ne tombe dans ses segments.
 *
 * **Sert deux fois** (#87) : à la décision de saut, qui doit savoir si le
 * texte a changé avant de décider s'il y a un rendu à refaire, et à l'écriture
 * réelle du `.ass` plus bas dans `renderClip`, qui réutilise le même document
 * plutôt que de relire le transcript une seconde fois.
 *
 * **Par `transcriptDuProjet` (`vues.ts`) d'abord, jamais par `placeSidecar` ni
 * `lireTranscript` directement** :
 *
 * - il sait déjà chercher le repli dans le projet **avant** le Drive
 *   (`chercherSidecar`, `run.ts`) — un `existsSync(transcriptPath(...))` seul
 *   raterait ce repli (`paths.ts` documente le piège), et sonder le montage
 *   avant de le lui laisser essayer le raterait tout autant : un projet dont
 *   le repli local existe déjà n'a jamais besoin du Drive, que le montage
 *   réponde ou non ;
 * - il mémoïse sur `fichier:taille:mtime` — un second export de la même
 *   émission, ou un GET qui a déjà tout lu pour l'écran de clip, ne repaie pas
 *   la lecture ;
 * - à la différence de `placeSidecar`, il ne **crée** jamais rien : c'est une
 *   lecture, pas l'écriture du sidecar que fait `transcribe`, et elle n'a donc
 *   pas à préparer un dossier sur un montage qui vient tout juste de répondre.
 *
 * **Le montage n'est sondé qu'en cas d'échec**, pour distinguer les deux
 * raisons possibles — le troisième verdict. Un montage qui ne répond pas
 * n'est ni « périmé » — reboucler l'export contre un Drive illisible — ni « à
 * jour » — servir un rendu peut-être faux : c'est un refus explicite, dans le
 * même vocabulaire que `montage.cause` (#62) donne à `listerSources`. «
 * muet » est transitoire et invite à réessayer ; un transcript introuvable
 * une fois le montage confirmé vivant ne l'est pas. Sonder ici, à l'appel
 * `fsp.stat` (pas `existsSync`) — `transcribe` (`steps/transcript.ts`) pose la
 * même garde avant le même genre d'appel, pour la même raison : un montage 9p
 * au transport mort gèle la boucle d'événements entière sur un appel
 * synchrone, donc **tout le serveur**, pas seulement cet export.
 */
async function currentCaptionsDocument(
  clip: Pick<Clip, 'id' | 'segments'>,
  project: Project,
  style: CaptionStyle,
): Promise<string | null> {
  const transcript = await projectTranscript(project)
  if (transcript === null) {
    if (!(await editingResponds(resolveSource(project.sourcePath)))) {
      throw new Error(
        `Le dossier des replays ne répond pas : impossible de lire le transcript du clip ${clip.id}. ` +
          'REPLAY_DIR est monté en 9p et peut être monté avec son transport mort dessous — ' +
          '/proc/mounts ne le distingue pas. Rouvrir le lecteur côté Windows, ou remonter le partage.',
      )
    }
    throw new Error(
      `Aucun transcript pour le clip ${clip.id} : ni à côté de l'original, ni dans le projet. Le ` +
        'clip demande des sous-titres, et il n’y a rien à en tirer.',
    )
  }

  const words: Word[] = transcript.segments.flatMap((s) => s.words)
  return clipUnderTitles(words, clip.segments, style)
}

/**
 * Écrit le `.ass` à partir du document déjà calculé par `currentCaptionsDocument`, et
 * rend son chemin — ou `undefined` s'il n'y a rien à incruster, auquel cas un
 * `.ass` d'un passage précédent est **effacé** ailleurs dans `renderClip`. Il
 * est gardé sur le disque pour relire ce que libass a incrusté ; un fichier
 * périmé y raconterait des sous-titres que le MP4 ne porte pas.
 * (relevé par Copilot)
 */
async function writeCaptionsDocument(
  clipId: string,
  document: string | null,
  path: string,
): Promise<string | undefined> {
  if (document === null) {
    console.warn(`Clip ${clipId} : aucun mot dans les segments retenus, rendu sans sous-titres.`)
    return undefined
  }

  await writeFile(path, document)
  return path
}
