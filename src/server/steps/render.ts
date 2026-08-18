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
import { getClip, getDb, getProject, putClip } from '@/server/db'
import {
  cheminTemporaire,
  encoderName,
  produireArtefact,
  type Avancement,
} from '@/server/ffmpeg'
import { probe } from '@/server/ffprobe'
import { estUneAbsence } from '@/server/octets'
import { placeSidecar, rendersDir } from '@/server/paths'
import { lireTranscript } from '@/server/steps/candidates'
import { ensureLocalCopy } from '@/server/steps/ingest'

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
export type SortieRendu = 'natif' | '9x16'

export type AvancementRendu = Avancement & { sortie: SortieRendu }

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
 * Les cinq chemins d'un clip. `variant9x16` vaut `null` quand le ratio natif est
 * déjà 9:16 : la variante à fond flouté n'existe que pour porter un 4:5 ou un
 * 1:1 sur TikTok et Shorts, et sur un clip déjà vertical elle serait le même
 * cadre rendu une seconde fois (spec §11).
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
  /**
   * L'empreinte du rendu — ce que les fichiers ci-dessus décrivent (#48).
   *
   * **Elle n'est pas une sortie** : `sortiesDuClip` ne la publie pas et
   * `sortieNommée` ne la sert pas. C'est une pièce interne, rangée à côté des
   * fichiers qu'elle décrit précisément pour disparaître avec eux.
   */
  empreinte: string
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
 * abandonné : un clip dont le ratio natif retombe à 9:16 n'a plus de variante à
 * produire, et l'ancienne resterait sur le disque à ressembler à une livraison à
 * jour. (relevé par Copilot)
 */
function cheminVariante(projectId: string, clipId: string): string {
  return path.join(rendersDir(projectId), `${vérifierClipId(clipId)}-9x16.mp4`)
}

/**
 * **Le ratio attendu est le ratio NATIF résolu**, celui que `computeFraming`
 * choisit — le plus large des plans —, jamais `clip.ratio` : un clip en `auto`
 * n'en a pas à lui, et lire le mauvais ferait chercher une variante sous un clip
 * qui n'en a pas, ou l'inverse.
 */
export function cheminsRendu(projectId: string, clipId: string, ratio: Ratio): CheminsRendu {
  const dossier = rendersDir(projectId)
  const nom = vérifierClipId(clipId)
  return {
    mp4: path.join(dossier, `${nom}.mp4`),
    variant9x16: ratio === '9:16' ? null : cheminVariante(projectId, nom),
    texts: path.join(dossier, `${nom}.txt`),
    ass: path.join(dossier, `${nom}.ass`),
    // **Le nom ne dépend pas du ratio**, contrairement à celui de la variante :
    // l'empreinte décrit le rendu quel que soit le ratio, et un clip dont le
    // ratio natif change doit retrouver — pour l'écarter — celle qu'il a écrite
    // avant.
    empreinte: path.join(dossier, `${nom}.rendu.json`),
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
 * cadrage automatique, ce qui a été *décidé pour* le clip —, `marques` et
 * `sousTitres` ce qui a été *obtenu*. Reste tout ce que le code fait sans qu'on
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
 */
export const VERSION_EMPREINTE = 2

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
export type FormeRendue = Pick<Clip, 'segments' | 'captions' | 'branding'> & {
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
export function renderedShape(clip: Pick<Clip, 'segments' | 'captions' | 'branding'>, framing: RenderedFraming): FormeRendue {
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
export type EmpreinteRendu = FormeRendue & {
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
  marques: MarqueIncrustée[]
  /**
   * `null` quand aucun document ASS n'a été incrusté ; sinon le condensat du
   * preset avec lequel il l'a été.
   *
   * **Un seul champ pour deux faits, parce qu'ils ne se séparent pas** : un
   * preset n'a de sens que s'il y a des sous-titres, et deux champs porteraient
   * un invariant à tenir entre eux. Un clip qui demande des sous-titres et dont
   * aucun mot ne tombe dans les segments se rend sans, en le journalisant :
   * `captions: true` avec `sousTitres: null` dit exactement cela.
   *
   * **Le condensat se compare, la présence non**, et l'asymétrie a une cause.
   * `OptionsRendu.style` change l'image : un rendu forcé avec un preset
   * personnalisé, puis un appel avec le preset par défaut, sautait en déclarant
   * à jour une vidéo produite avec l'autre style. (relevé par Copilot) La
   * *présence*, elle, ne peut se comparer qu'en relisant le transcript, donc en
   * payant l'aller-retour sur le Drive en 9p que la décision de saut évite
   * exprès — et la rendre périmante sans cette lecture ferait boucler l'export
   * sur un clip dont aucun mot ne tombe dans les segments : chaque passage
   * referait le rendu pour réécrire la même empreinte.
   */
  sousTitres: string | null
}

/** Une marque incrustée : son nom de fichier, et de quoi voir qu'elle a changé. */
export type MarqueIncrustée = { nom: string; contenu: string }

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
export type LookDesSousTitres = { style: CaptionStyle; polices: string }

/**
 * Le schéma de lecture. **Non strict, et volontairement** : une version
 * ultérieure ajoutera des champs, et c'est `version` qui doit trancher, pas un
 * refus d'analyse qui dirait « illisible » d'un fichier parfaitement formé.
 */
const SCHÉMA_EMPREINTE = z.object({
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
  marques: z.array(z.object({ nom: z.string(), contenu: z.string() })),
  sousTitres: z.string().nullable(),
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
function contenuDuFichier(chemin: string): string {
  return createHash('sha256').update(fs.readFileSync(chemin)).digest('hex')
}

/**
 * Le condensat du look des sous-titres.
 *
 * **Clés triées avant sérialisation.** `JSON.stringify` suit l'ordre
 * d'insertion : sans ce tri, réordonner le littéral de `DEFAULT_CAPTION_STYLE`
 * — un geste qui ne change pas une image — périmerait tous les rendus du
 * disque.
 */
function condensatDuLook(look: LookDesSousTitres): string {
  const stable = Object.entries(look.style).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return createHash('sha256').update(JSON.stringify([stable, look.polices])).digest('hex')
}

/** Ce que libass sait charger depuis un `fontsdir`. */
const EXTENSIONS_DE_POLICE = ['.ttf', '.otf', '.ttc']

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
export function condensatDesPolices(dossier: string): string {
  let noms: string[]
  try {
    noms = fs.readdirSync(dossier).filter((nom) =>
      EXTENSIONS_DE_POLICE.includes(path.extname(nom).toLowerCase()),
    )
  } catch {
    noms = []
  }
  const entrées = noms.sort().map((nom): [string, string] => {
    try {
      return [nom, contenuDuFichier(path.join(dossier, nom))]
    } catch {
      return [nom, 'illisible']
    }
  })
  return createHash('sha256').update(JSON.stringify(entrées)).digest('hex')
}

/** Une liste de marques dans un ordre stable, quelle que soit sa provenance. */
function triéesParNom(marques: readonly MarqueIncrustée[]): MarqueIncrustée[] {
  return [...marques].sort((a, b) => (a.nom < b.nom ? -1 : a.nom > b.nom ? 1 : 0))
}

/** Les marques telles que l'empreinte les note : nom et contenu, triés par nom. */
function identitésDeMarques(marques: readonly MarqueNative[]): MarqueIncrustée[] {
  return triéesParNom(marques.map((m) => ({ nom: path.basename(m.path), contenu: m.contenu })))
}

/**
 * L'empreinte que ce passage vient de produire. Pure.
 *
 * `style` n'est lu que si un document a été incrusté : le preset d'un clip sans
 * sous-titres ne décrit rien de son image, et l'y noter périmerait ce clip au
 * premier réglage de police.
 */
export function empreinteDuRendu(
  clip: FormeRendue,
  marques: readonly MarqueNative[],
  sousTitres: { incrustés: boolean; look: LookDesSousTitres },
): EmpreinteRendu {
  return {
    version: VERSION_EMPREINTE,
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
    marques: identitésDeMarques(marques),
    sousTitres: sousTitres.incrustés ? condensatDuLook(sousTitres.look) : null,
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
export function lireEmpreinte(chemin: string): EmpreinteRendu | null {
  let contenu: string
  try {
    contenu = fs.readFileSync(chemin, 'utf8')
  } catch (erreur) {
    if (!estUneAbsence(erreur)) {
      console.warn(
        `Empreinte de rendu inaccessible (${path.basename(chemin)}) : ` +
          `${erreur instanceof Error ? erreur.name : 'erreur inconnue'}. Le rendu sera refait.`,
      )
    }
    return null
  }
  try {
    const brut: unknown = JSON.parse(contenu)
    // **La version se lit avant le schéma, et c'est le seul ordre honnête.** Une
    // empreinte d'une recette antérieure n'a pas les champs d'aujourd'hui : la
    // passer au schéma la ferait refuser, et le journal dirait « illisible »
    // d'un fichier parfaitement formé. Le remède est le même — refaire le rendu
    // — mais le message enverrait chercher une corruption qui n'existe pas.
    // C'est `version` qui tranche, comme le dit la note du schéma.
    const version = (brut as { version?: unknown } | null)?.version
    if (typeof version === 'number' && version !== VERSION_EMPREINTE) {
      console.warn(
        `Empreinte de rendu en version ${version} (${path.basename(chemin)}), la recette est en ` +
          `${VERSION_EMPREINTE}. Le rendu sera refait.`,
      )
      return null
    }
    const lu = SCHÉMA_EMPREINTE.safeParse(brut)
    if (lu.success) return lu.data
  } catch {
    // JSON tronqué — un processus tué en pleine écriture, malgré le renommage.
  }
  console.warn(`Empreinte de rendu illisible (${path.basename(chemin)}). Le rendu sera refait.`)
  return null
}

/** Écrit l'empreinte, sous un nom temporaire puis renommée, comme les sorties. */
async function écrireEmpreinte(chemin: string, empreinte: EmpreinteRendu): Promise<void> {
  await écrireFichier(chemin, `${JSON.stringify(empreinte, null, 2)}\n`)
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
export function lesMarquesOntBougé(
  empreinte: EmpreinteRendu,
  disponibles: readonly MarqueNative[],
  dossierVideToléré: boolean,
): boolean {
  const aujourdhui = identitésDeMarques(disponibles)
  if (dossierVideToléré && aujourdhui.length === 0) return false
  // Retriées à la lecture : le fichier a pu être écrit à la main.
  const incrustées = triéesParNom(empreinte.marques)
  return (
    incrustées.length !== aujourdhui.length ||
    incrustées.some((m, i) => m.nom !== aujourdhui[i].nom || m.contenu !== aujourdhui[i].contenu)
  )
}

/** Pourquoi une empreinte ne décrit pas le rendu qu'on produirait maintenant. */
export type ÉcartEmpreinte = 'absente' | 'recette' | 'montage' | 'marques' | 'style'

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
export type CeQuOnIncrusterait = {
  marques: readonly MarqueNative[] | null
  look: LookDesSousTitres | null
}

/**
 * L'écart entre ce qui a été rendu et ce qu'on rendrait maintenant, ou `null`
 * quand il n'y en a pas. Pure : c'est l'appelant qui a lu le disque.
 */
export function écartDeLEmpreinte(
  empreinte: EmpreinteRendu | null,
  clip: FormeRendue,
  observé: CeQuOnIncrusterait,
): ÉcartEmpreinte | null {
  // **Une empreinte absente vaut « périmé », jamais « inconnu ».** C'est le seul
  // choix qui referme le quatrième cas sans intervention manuelle : les rendus
  // déjà sur le disque n'en ont pas, et « inconnu » les laisserait sauter pour
  // toujours — ce que `--force` rattrape aujourd'hui, à condition d'avoir lu le
  // commentaire qui le dit. Ce que ça coûte est un réencodage par clip, une
  // fois ; ce que ça évite est un MP4 sans logo publié comme la livraison du
  // jour.
  if (empreinte === null) return 'absente'
  if (empreinte.version !== VERSION_EMPREINTE) return 'recette'
  if (leRenduEstPérimé(empreinte, clip)) return 'montage'
  // `clip.branding` en guise de tolérance : un clip qui ne demande pas de marque
  // n'a rien à excuser, son empreinte en porte zéro et la comparaison passe.
  if (observé.marques !== null && lesMarquesOntBougé(empreinte, observé.marques, clip.branding)) {
    return 'marques'
  }
  // **Seulement quand un document a été incrusté.** `sousTitres` à `null` dit
  // qu'il n'y en a pas eu, et le preset n'a alors rien décrit de l'image : le
  // comparer périmerait au premier réglage de police un clip qui n'en porte pas.
  if (
    observé.look !== null &&
    empreinte.sousTitres !== null &&
    empreinte.sousTitres !== condensatDuLook(observé.look)
  ) {
    return 'style'
  }
  return null
}

/** `écartDeLEmpreinte` en booléen, pour les appelants qui n'ont pas à dire pourquoi. */
export function empreinteÀJour(
  empreinte: EmpreinteRendu | null,
  clip: FormeRendue,
  observé: CeQuOnIncrusterait,
): boolean {
  return écartDeLEmpreinte(empreinte, clip, observé) === null
}

/** Ce que le journal dit de chaque écart, à qui n'a pas lu ce fichier. */
const RAISON_DE_LÉCART: Record<ÉcartEmpreinte, string> = {
  absente: "aucune empreinte ne dit ce qu'ils décrivent",
  recette: 'ils ont été produits par une recette de rendu antérieure',
  montage: 'le montage a changé depuis',
  marques: "les marques incrustées ne sont plus celles du dossier",
  style: "les sous-titres ont été incrustés avec un autre look",
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
export function sauterLeRendu(
  chemins: CheminsRendu,
  existe: (chemin: string) => boolean,
  décritLeClip: boolean,
  force = false,
): boolean {
  if (force) return false
  if (!décritLeClip) return false
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
  décritLeClip: boolean,
  force = false,
): boolean {
  if (force) return true
  // **Une empreinte qui ne décrit pas le clip rallume ffmpeg**, et pas seulement
  // un fichier manquant. Sans cette ligne, un jeu de MP4 complet mais périmé
  // sauterait l'encodage pour n'y réécrire que le `.txt` : le correctif de
  // `sauterLeRendu` ne ferait alors que déplacer le mensonge d'une fonction.
  if (!décritLeClip) return true
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
  /**
   * Le condensat du fichier. Il ne sert pas au rendu — `planifierMarques`
   * l'ignore — mais à l'empreinte, qui doit distinguer deux images portant le
   * même nom fixe. Voir `contenuDeLaMarque`.
   */
  contenu: string
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
    // Le contenu avant le sondage : c'est la lecture la moins chère des deux, et
    // un fichier qu'on ne sait pas lire n'a pas besoin d'un ffprobe pour être
    // écarté. Une marque illisible se journalise et s'ignore, comme une marque
    // que ffprobe ne sait pas mesurer.
    let contenu: string
    try {
      contenu = contenuDuFichier(chemin)
    } catch (erreur) {
      console.warn(
        `Marque illisible, ignorée : ${chemin} (${erreur instanceof Error ? erreur.name : 'erreur inconnue'})`,
      )
      continue
    }
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
      contenu,
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
export function écrireTexteDePublication(
  db: Database.Database,
  clipId: string,
  repli: Clip,
  chemin: string,
): void {
  const contenu = texteDePublication(getClip(db, clipId) ?? repli)
  fs.mkdirSync(path.dirname(chemin), { recursive: true })
  const temporaire = cheminTemporaire(chemin)
  try {
    fs.writeFileSync(temporaire, contenu, 'utf8')
    fs.renameSync(temporaire, chemin)
  } catch (cause) {
    try {
      fs.rmSync(temporaire, { force: true })
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
export async function renderClip(clipId: string, options: OptionsRendu = {}): Promise<RenderResult> {
  const db = options.db ?? getDb()
  const clip = getClip(db, clipId)
  if (clip === undefined) throw new Error(`Clip inconnu : ${clipId}`)

  const projet = getProject(db, clip.projectId)
  if (projet === undefined) {
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

  // **Les marques que le dossier porte aujourd'hui, avant la décision de saut.**
  // L'empreinte dit lesquelles ont été incrustées ; les comparer suppose de
  // savoir lesquelles le seraient maintenant. Deux `existsSync` et deux sondages
  // sur un dossier local — rien à voir avec l'aller-retour en 9p que la décision
  // de saut continue d'éviter, le transcript n'étant lu que plus bas.
  //
  // Le dossier ne se lit que si le clip en veut : un clip sans marque n'a rien à
  // comparer, et `branding` passé à faux se voit déjà dans les cinq champs.
  const marques = clip.branding ? await collecterMarques(options.brandDir) : []

  // Le look entre dans l'empreinte, donc il se résout avant la décision de saut
  // et non plus au moment d'écrire le `.ass`. Les polices se relèvent ici **sans
  // rien dire** : l'avertissement appartient au chemin qui encode, et le poser
  // ici le ferait sonner à chaque export sauté.
  const look: LookDesSousTitres = {
    style: options.style ?? DEFAULT_CAPTION_STYLE,
    polices: condensatDesPolices(dossierDesPolices(options.fontsDir)),
  }

  // Ce que les fichiers présents décrivent, s'il y en a.
  const écart = écartDeLEmpreinte(lireEmpreinte(chemins.empreinte), renderedShape(clip, framingSnapshot), {
    marques,
    look,
  })

  // **Le refus de sauter se dit.** C'est tout le défaut qu'on ferme : un rendu
  // périmé était repris pour bon sans un mot, et l'interface présente
  // `skipped: true` comme un succès (spec §3.4). Le réencodage se voit déjà —
  // l'export dure alors dix secondes au lieu d'aucune — mais rien ne disait
  // pourquoi. Sous `force`, la décision ne vient pas de l'empreinte : on se tait.
  if (écart !== null && options.force !== true && fs.existsSync(chemins.mp4)) {
    console.warn(
      `Clip ${clipId} : des rendus sont là mais ${RAISON_DE_LÉCART[écart]}. Ils sont refaits.`,
    )
  }

  // **Le saut se décide avant de toucher au transcript.** Le sidecar vit sur le
  // Drive partagé, monté en 9p, lent et sujet au décrochage : un clip déjà rendu
  // ne doit pas payer un aller-retour dessus pour s'entendre dire qu'il n'y a
  // rien à faire.
  if (sauterLeRendu(chemins, (c) => fs.existsSync(c), écart === null, options.force)) {
    // **Le `.txt` se réécrit même quand le rendu saute**, et c'est le seul des
    // trois à le faire. Il ne coûte rien, et c'est celui qu'on retouche le plus :
    // corriger une faute dans la description puis relancer l'export ne doit pas
    // exiger un `--force` qui réencoderait trois minutes de vidéo pour rien.
    // (relevé par Aristarque)
    écrireTexteDePublication(db, clipId, clip, chemins.texts)
    // La variante d'un ratio abandonné s'efface ici aussi. Le chemin non sauté le
    // fait déjà ; sans cela, un clip dont le ratio natif retombe à 9:16 et dont
    // les sorties sont complètes garderait son ancienne variante alors que
    // `RenderResult` annonce qu'il n'y en a pas. (relevé par Aristarque)
    if (chemins.variant9x16 === null) {
      fs.rmSync(cheminVariante(clip.projectId, clipId), { force: true })
    }
    // **Le même contrôle qu'à la fin du chemin long, et il manquait ici.** Ce
    // chemin-ci n'encode pas, mais il écrit quand même — le `.txt` — et il pose
    // `exported`. Sans lui, un montage modifié entre la décision de saut et
    // cette ligne faisait annoncer « exporté » sur des fichiers que le `PATCH`
    // venait d'effacer. Le chemin long refusait ce cas depuis toujours ; celui-ci
    // ne le voyait pas.
    if (écarterRenduPérimé(db, clipId, chemins, clip, framingSnapshot)) {
      throw new Error(
        `Le clip ${clipId} a été modifié pendant son export : les fichiers présents décrivaient le montage d'avant et ont été écartés. Relancer l'export.`,
      )
    }

    // **Le statut se répare ici aussi.** Un processus arrêté entre l'écriture du
    // `.txt` et la mise à jour du statut laisse toutes les sorties en place : la
    // relance sauterait, et le clip resterait en « kept » pour toujours sans que
    // rien ne puisse le rattraper. La présence des fichiers fait foi en itération
    // 0 (spec §4), donc elle vaut aussi pour le statut. (relevé par Copilot)
    marquerExporté(db, clipId, clip, framingSnapshot)
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
  if (refaireLesSorties(chemins, (c) => fs.existsSync(c), écart === null, options.force)) {
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
    const src = await ensureLocalCopy(projet, { db })

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

    // **Le `.ass` s'écrit d'abord sous un nom temporaire.** Il est gardé sur le
    // disque pour relire ce que libass a incrusté, et `produireArtefact` conserve
    // l'ancien MP4 quand ffmpeg échoue : écrire directement sur le nom définitif
    // laisserait, après un rendu forcé raté, l'ASS d'une tentative qui n'a rien
    // produit à côté d'une vidéo d'avant. Le sidecar ne bouge qu'une fois le MP4
    // en place. (relevé par Copilot)
    const assProvisoire = clip.captions
      ? await écrireSousTitres(clip, cheminTemporaire(chemins.ass), projet, look.style)
      : undefined
    // Le dossier de polices n'a de sens qu'avec un `.ass` à incruster : en parler
    // sans cela ferait avertir sur un clip qui n'a pas de sous-titres. Son
    // *contenu*, lui, a déjà été relevé plus haut pour l'empreinte.
    const fontsDir =
      assProvisoire === undefined ? undefined : dossierDesPolicesUtilisable(options.fontsDir)

    try {
      const taille = await dimensionsSource(src)

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
        crop: cropRect(ratio, m.cropXNative, taille.w, taille.h),
      }))
      const verticalPieces: FramedSegment[] = pieces.map((m) => ({
        start: m.start,
        end: m.end,
        ratio: m.ratio,
        crop: cropRect(m.ratio, m.cropX, taille.w, taille.h),
      }))

      // **Les marques sont planifiées sur le canevas de CHAQUE sortie**, et non
      // une fois pour les deux : elles s'incrustent après la composition, à la
      // taille du fichier produit, et `planifierMarques` raisonne en fractions
      // de ce canevas. Les planifier une seule fois poserait dans la variante
      // une bande calculée pour un autre format. C'est la même raison que pour
      // les sous-titres — voir `renderArgs`.
      const logos = planifierMarques(out.w, out.h, marques)
      const verticalLogos = planifierMarques(verticalCanvas.w, verticalCanvas.h, marques)

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

      // **L'empreinte d'avant part avec elle, et pour la même raison poussée
      // d'un cran.** Elle certifie les MP4 qu'on est en train de remplacer : la
      // laisser en place le temps des deux encodages laisse `livraisonÀJour`
      // répondre vrai sur une paire à moitié réécrite, et rien ne le signale
      // puisqu'un `GET` ne sonde pas le dossier des marques. N'importe quelle
      // sortie de ce bloc — interruption, refus de certifier plus bas — laisse
      // alors des fichiers que rien ne certifie, donc à refaire.
      // (relevé par Copilot)
      fs.rmSync(chemins.empreinte, { force: true })

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
        args: (destination) =>
          renderArgs({
            src,
            segments: nativePieces,
            out,
            assPath: assProvisoire,
            fontsDir,
            logos,
            dst: destination,
            encoder: encodeur(),
          }),
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
            blurredVariantArgs({
              src,
              segments: verticalPieces,
              out: verticalCanvas,
              assPath: assProvisoire,
              fontsDir,
              logos: verticalLogos,
              dst: destination,
              encoder: encodeur(),
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
      const empreinte = empreinteDuRendu(renderedShape(clip, framingSnapshot), marques, {
        incrustés: assProvisoire !== undefined,
        look,
      })
      const marquesAprès = clip.branding ? await collecterMarques(options.brandDir) : []
      // **Sans la tolérance du dossier vide.** Elle existe pour ne pas détruire
      // une livraison déjà faite quand on ne sait plus ce qu'elle porte ; ici on
      // décide de *certifier* celle qu'on vient de faire, et ne pas savoir n'est
      // pas une raison d'affirmer. Un logo remplacé entre les deux encodages
      // puis retiré avant ce contrôle passait sinon inaperçu.
      // (relevé par Codex)
      if (lesMarquesOntBougé(empreinte, marquesAprès, false)) {
        throw new Error(
          `Les marques du clip ${clipId} ne sont plus celles qui ont servi à son export : les deux sorties peuvent ne pas porter la même, et rien ne permet de le vérifier. Aucune empreinte n'est posée, l'export suivant les refera. Relancer l'export.`,
        )
      }
      await écrireEmpreinte(chemins.empreinte, empreinte)
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

  // Un clip dont le ratio natif retombe à 9:16 n'a plus de variante à produire,
  // et l'ancienne resterait à côté du nouveau MP4 en ressemblant à une livraison
  // à jour — alors que `RenderResult` annonce qu'il n'y en a pas.
  // (relevé par Copilot)
  if (chemins.variant9x16 === null) {
    fs.rmSync(cheminVariante(clip.projectId, clipId), { force: true })
  }

  // **Le titre et la description se relisent en base, pour la même raison que le
  // statut.** `clip` est l'instantané d'avant l'encodage, qui a duré des minutes :
  // écrire le `.txt` depuis lui livrerait la description que l'utilisateur vient
  // de corriger pendant ce temps. La relecture et l'écriture se suivent sans
  // point d'attente — voir `écrireTexteDePublication`, qui porte l'arbitrage
  // entre ce chemin-ci et celui du `PATCH`.
  écrireTexteDePublication(db, clipId, clip, chemins.texts)

  // **Le montage a-t-il bougé pendant l'encodage ?** Si oui, les fichiers qu'on
  // vient de produire décrivent un cadre que personne ne veut plus : on les
  // retire et on échoue franchement, plutôt que de les laisser sur le disque où
  // l'export suivant les prendrait pour bons. C'est le prix d'un modèle où la
  // présence du fichier fait foi.
  if (écarterRenduPérimé(db, clipId, chemins, clip, framingSnapshot)) {
    throw new Error(
      `Le clip ${clipId} a été modifié pendant son export : les fichiers produits décrivaient le montage d'avant et ont été écartés. Relancer l'export.`,
    )
  }

  // Le statut ne bouge qu'une fois les fichiers sur le disque : le poser avant
  // l'encodage protégerait un clip qui n'existe pas.
  marquerExporté(db, clipId, clip, framingSnapshot)

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
 * `rendu` est le clip tel qu'il a été lu au début de l'export : son statut sert
 * à reconnaître une décision prise depuis, et ses cinq champs d'image à
 * reconnaître un montage qui a bougé — voir plus bas.
 *
 * `better-sqlite3` est synchrone : rien de ce processus ne s'intercale entre la
 * relecture et l'écriture. Et un clip supprimé pendant le rendu n'est pas
 * ressuscité, puisqu'on n'écrit que ce qu'on vient de lire.
 */
export function marquerExporté(
  db: Database.Database,
  clipId: string,
  rendu: Clip,
  framing: RenderedFraming,
): void {
  const àJour = getClip(db, clipId)
  if (àJour === undefined) return
  if (àJour.status === 'exported') return
  // **Toute décision prise pendant l'encodage l'emporte.** L'écart de statut
  // couvre tout ce que l'interface offre comme *décision* : écarter le clip, ou
  // rappuyer sur « Gardé », qui le ramène à `candidate`
  // (`src/lib/clip-status.ts`). (relevé par Copilot)
  if (àJour.status !== rendu.status) {
    console.warn(
      `Clip ${clipId} : passé de « ${rendu.status} » à « ${àJour.status} » pendant l'export. Les fichiers sont produits, la décision est conservée.`,
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
  if (leRenduEstPérimé(renderedShape(rendu, framing), renderedShape(àJour, renderedFraming(clipFraming(àJour))))) {
    console.warn(
      `Clip ${clipId} : le montage a changé pendant l'export. Les fichiers produits décrivent le montage d'avant, le statut n'est pas posé.`,
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
  cadrageDuRelu: (clip: Clip) => RenderedFraming = (clip) => renderedFraming(clipFraming(clip)),
): boolean {
  const àJour = getClip(db, clipId)
  if (àJour === undefined) return false
  // **Le cadrage d'après se recalcule sur le clip relu**, pas sur celui qu'on
  // avait : c'est tout l'objet du contrôle. Retirer un passage où un comédien
  // traverse le plateau peut faire retomber un 16:9 en 1:1 sans qu'aucun champ
  // du clip ne dise « cadrage », et les fichiers montreraient alors un cadre que
  // plus personne ne veut.
  if (!leRenduEstPérimé(renderedShape(rendu, framing), renderedShape(àJour, cadrageDuRelu(àJour))))
    return false

  // **L'empreinte part la première.** Elle est ce qui certifie les autres : un
  // échec au milieu de cette boucle doit laisser des fichiers sans empreinte —
  // donc à refaire — et jamais une empreinte sans les fichiers qu'elle décrit,
  // qui ferait sauter l'export suivant sur une livraison amputée.
  for (const chemin of [chemins.empreinte, chemins.mp4, chemins.variant9x16, chemins.texts]) {
    if (chemin !== null) fs.rmSync(chemin, { force: true })
  }
  if (àJour.status === 'exported') putClip(db, { ...àJour, status: 'kept' })
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
export function leRenduEstPérimé(rendu: FormeRendue, àJour: FormeRendue): boolean {
  const mêmesSegments =
    rendu.segments.length === àJour.segments.length &&
    rendu.segments.every(
      (s, i) => s.start === àJour.segments[i].start && s.end === àJour.segments[i].end,
    )
  // **Le cadrage se compare en profondeur, comme les segments.** Un `!==` sur un
  // `cropX` unique suffisait quand il n'y en avait qu'un ; il y en a désormais un
  // par plan, et deux tableaux de crops identiques ne sont jamais le même objet.
  // Comparés par référence, ils seraient toujours différents — chaque appel
  // périmerait le rendu, l'export réencoderait à chaque passage, et `skipped`
  // ne serait plus jamais vrai.
  const sameFraming =
    rendu.framing.ratio === àJour.framing.ratio &&
    rendu.framing.shots.length === àJour.framing.shots.length &&
    rendu.framing.shots.every(
      (p, i) =>
        p.start === àJour.framing.shots[i].start &&
        p.end === àJour.framing.shots[i].end &&
        p.ratio === àJour.framing.shots[i].ratio &&
        p.cropX === àJour.framing.shots[i].cropX &&
        p.cropXNative === àJour.framing.shots[i].cropXNative,
    )
  return (
    !mêmesSegments ||
    !sameFraming ||
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
