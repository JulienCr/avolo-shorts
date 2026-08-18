/**
 * Les données de l'itération 0, en attendant les routes de la tâche 10.
 *
 * Tout ce fichier est **jetable** : il disparaîtra le jour où `api.ts` appellera
 * de vraies routes, et rien d'autre ne l'importe. Il est là pour que l'interface
 * se construise, se regarde et se corrige avant que le pipeline ne tourne — un
 * écran de tri qu'on ne peut ouvrir qu'après quarante minutes d'analyse ne se
 * corrige jamais.
 *
 * Le transcript est généré, pas recopié : il faut un millier de mots pour que la
 * virtualisation ait un sens, et mille mots écrits à la main dans un fichier de
 * dépôt seraient un fichier de dépôt de mille mots. Les phrases, elles, sont
 * écrites : du texte plausible d'une soirée d'improvisation, parce qu'un corpus
 * en « lorem ipsum » ne dit rien de la mise en page réelle — ni la longueur des
 * mots, ni les accents, ni les apostrophes.
 *
 * L'état vit en mémoire du module. Garder et écarter survivent donc à une
 * navigation, pas à un rechargement complet. C'est assumé : la persistance est
 * le travail de SQLite (tâche 6), pas d'une fixture.
 */

import { normalizeSegments, type Clip, type Segment } from '@/core/edl'
import type { Word } from '@/core/transcript'
import type {
  CandidateClip,
  ClipDetail,
  ClipPatch,
  ProjectStatus,
  ProjectSummary,
} from '@/lib/api'
import type { TranscriptLine } from '@/lib/editing'

const PROJECT_ID = '2026-03-08-caro-mdlm'

const PROJET: ProjectSummary = {
  id: PROJECT_ID,
  title: 'LA SCÈNE AVOLO — 8 mars, Caro & MDLM',
  sourcePath: '/mnt/j/Drive partagés/Avolo/03_LA_SCENE_AVOLO/Replay/2026-03-08-caro-mdlm.mp4',
  durationSec: 10_212,
  createdAt: '2026-08-18T09:12:00+02:00',
}

/**
 * Le corpus. Des répliques d'une soirée d'improvisation : un présentateur, deux
 * équipes, un public qui donne des thèmes.
 */
const REPLIQUES = [
  "Bonsoir et bienvenue à LA SCÈNE AVOLO, on est ravis de vous voir aussi nombreux ce soir.",
  "Comme d'habitude on va vous demander des thèmes, et comme d'habitude vous allez nous en donner d'impossibles.",
  "Première catégorie : mixte, à la manière d'un documentaire animalier, durée trois minutes.",
  "Le thème que vous nous avez donné, et je le lis tel quel : « le dernier tube de dentifrice ».",
  "Voilà. Trois minutes sur un tube de dentifrice, on y va.",
  "Regardez-le. Il est là, immobile, posé au bord du lavabo depuis onze jours.",
  "Il ne bouge plus. Il attend. Il sait.",
  "À cette période de l'année, le tube de dentifrice entre dans sa phase la plus vulnérable.",
  "Chaque matin la main descend, appuie, et repart avec un peu moins que la veille.",
  "Ce que le tube ignore, c'est qu'il reste très exactement quatre pressions.",
  "Quatre. Pas cinq. J'ai compté.",
  "Et à l'autre bout de la salle de bain, tapi derrière le miroir, son prédateur naturel.",
  "Le colocataire qui rachète jamais rien.",
  "Il approche. Il ne dit pas bonjour. Il n'a jamais dit bonjour.",
  "Vous n'êtes pas obligés d'applaudir maintenant, mais je vous préviens, ça va être dur de résister.",
  "Deuxième catégorie : comparée, chantée, deux joueurs, sans contrainte de temps.",
  "Le thème : « ce que je n'ai pas dit à ma sœur ».",
  "On prend trente secondes pour se concerter, ne partez pas.",
  "Je n'ai pas dit à ma sœur que j'avais gardé la lettre.",
  "Elle l'a écrite un dimanche, elle avait douze ans, elle voulait quitter la maison.",
  "Elle l'a mise sous mon oreiller au lieu de celui de maman, et je crois que c'était pas une erreur.",
  "Vingt ans plus tard elle en parle jamais, et moi non plus.",
  "Mais elle est là, dans la boîte à chaussures, entre deux tickets de cinéma.",
  "Et le jour où elle demandera, je saurai exactement où elle est.",
  "Alors ça, si c'est pas de la chanson, je sais pas ce que c'est.",
  "Le jury nous fait signe. On passe au vote.",
  "Troisième catégorie, et là je vous préviens, on est sur du lourd.",
  "Impro libre, quatre joueurs, à la manière de rien du tout.",
  "Le thème vient du deuxième rang, il est écrit en tout petit, attendez.",
  "« Le service après-vente des télésièges ». Merci, monsieur, c'est très gentil.",
  "Bonjour, service après-vente, Sylvie à votre écoute.",
  "Alors non, monsieur, le télésiège ne se retourne pas.",
  "Ce n'est pas prévu par le constructeur, et honnêtement ce n'est prévu par personne.",
  "Vous êtes en haut. C'est déjà bien. Beaucoup de gens rêveraient d'être en haut.",
  "Non, je ne peux pas vous passer un responsable, je suis le responsable.",
  "Je suis le responsable depuis quatorze ans et vous êtes le premier à demander ça.",
  "Enfin, le premier de la semaine.",
  "Monsieur, votre forfait couvre la montée. La descente relève de votre responsabilité personnelle.",
  "C'est écrit au dos. En dessous. En italique. En allemand.",
  "Je vous remercie de votre appel et je vous souhaite une excellente fin de saison.",
  "On applaudit très fort, parce qu'ils l'ont vraiment mérité celle-là.",
  "Petite pause de dix minutes, le bar est ouvert, et il est ouvert pour nous aussi.",
  "On repart, et on repart avec une catégorie qu'on n'a jamais jouée ici.",
  "Poursuite, sans parole, trois joueurs, deux minutes trente.",
  "Le thème que vous avez proposé : « l'ascenseur du deuxième ».",
  "Sans parole, je précise. Donc si vous entendez un mot, c'est une faute et le jury la sifflera.",
  "On y va. Musique.",
  "Il faut imaginer trois personnes qui se connaissent de vue depuis six ans.",
  "Six ans de bonjour. Six ans de bouton du deuxième.",
  "Et ce matin-là, le bouton du deuxième ne s'allume pas.",
  "Le premier appuie. Rien. Le deuxième appuie plus fort. Rien.",
  "Le troisième, qui n'a jamais rien dit à personne, tend le bras.",
  "Il appuie. Ça s'allume.",
  "Et là, pour la première fois en six ans, les deux autres le regardent vraiment.",
  "Le jury va délibérer, mais je pense qu'on a tous compris.",
  "Catégorie suivante, et on change complètement de registre.",
  "Mixte, à la manière d'un discours de mariage qui part mal, quatre minutes.",
  "Le thème, et je m'excuse d'avance auprès du deuxième rang : « la belle-mère ».",
  "Chers amis, chère famille, chère Martine.",
  "Je voulais commencer par une anecdote, mais on m'a fortement conseillé de ne pas.",
  "Alors je vais commencer par une deuxième anecdote, qui est en fait la même mais racontée autrement.",
  "Quand j'ai rencontré Martine, elle m'a dit une phrase que je n'ai jamais oubliée.",
  "Elle m'a dit : « on verra ».",
  "Ça fait onze ans. On voit.",
  "Martine, si tu m'entends, et je sais que tu m'entends parce que tu entends tout.",
  "Je voulais te dire que le canapé, c'était pas moi.",
  "Voilà. C'est dit. On peut passer au dessert.",
  "Alors ça c'est ce qu'on appelle un final, mesdames et messieurs.",
  "Dernière catégorie de la soirée, et c'est vous qui l'avez choisie.",
  "Comparée, à la manière d'un tutoriel, deux joueurs, deux minutes.",
  "Le thème : « apprendre à mentir à son chien ».",
  "Alors aujourd'hui on va voir ensemble une technique très simple.",
  "Vous prenez la laisse. Vous la regardez. Et vous ne la prenez pas.",
  "Votre chien, lui, a déjà mis son manteau, mentalement.",
  "C'est là que tout se joue. Ne croisez pas son regard.",
  "Si vous croisez son regard, vous sortez. Il n'y a pas d'exception.",
  "Bon, moi je sors tous les soirs à vingt-deux heures, donc voilà où j'en suis.",
  "Merci à tous d'être venus, merci aux joueurs, merci au jury qu'on n'aime pas.",
  "On se retrouve le mois prochain, même endroit, même heure, thèmes toujours aussi impossibles.",
  "Bonne soirée à tous, rentrez bien, et n'oubliez pas de racheter du dentifrice.",
]

/**
 * Un générateur déterministe : la fixture doit être la même à chaque
 * rafraîchissement, sinon les positions changent sous les yeux et rien n'est
 * comparable d'une passe à l'autre.
 */
function bruit(graine: number): number {
  const x = Math.sin(graine * 12.9898) * 43_758.545_3
  return x - Math.floor(x)
}

/** Le transcript commence quarante minutes après le début du replay. */
const DEPART = 2_400

/**
 * Les silences de la soirée, en secondes, indexés par la réplique qui les
 * précède : une catégorie qui se termine, un vote, l'entracte.
 *
 * Sans eux le transcript serait un ruban continu, et les candidats se
 * suivraient à la seconde près — ce qu'aucun replay ne ressemble.
 */
const TROUS: Record<number, number> = { 14: 95, 25: 70, 41: 420, 54: 80, 67: 75, 76: 60 }

function construireLignes(): TranscriptLine[] {
  const lignes: TranscriptLine[] = []
  let t = DEPART

  REPLIQUES.forEach((replique, iReplique) => {
    if (iReplique > 0) t += TROUS[iReplique - 1] ?? 0

    const debut = t
    const mots: Word[] = []
    replique.split(' ').forEach((mot, iMot) => {
      const graine = iReplique * 97 + iMot
      // Un mot long se dit plus longtemps qu'un mot court : sans ça, les mots
      // barrés et les segments tombent sur une grille régulière qui ne
      // ressemble à aucun transcript réel.
      const duree = 0.18 + mot.length * 0.035 + bruit(graine) * 0.12
      mots.push({ word: mot, start: Number(t.toFixed(3)), end: Number((t + duree).toFixed(3)) })
      t += duree + 0.05
    })
    t += 0.4

    lignes.push({
      id: `l${iReplique}`,
      start: debut,
      end: mots[mots.length - 1].end,
      words: mots,
    })
  })

  return lignes
}

const LIGNES = construireLignes()

/** Tous les mots, à plat — c'est ce qui permet de caler les segments sur des mots. */
const MOTS: Word[] = LIGNES.flatMap((l) => l.words)

/**
 * Un candidat, décrit par des index de mots plutôt que par des secondes : les
 * bornes tombent ainsi toujours sur des frontières de mots, comme le fait
 * `snapToWords` sur les vraies sorties du modèle.
 */
type Proposition = {
  id: string
  titre: string
  description: string
  /** Un ou plusieurs intervalles `[premier mot, dernier mot]`, bornes incluses. */
  mots: [number, number][]
  ratio: Clip['ratio']
  cropX: number
  status: Clip['status']
}

const PROPOSITIONS: Proposition[] = [
  {
    id: 'c01',
    titre: 'Le dernier tube de dentifrice',
    description: 'Documentaire animalier sur un tube en fin de vie. Le colocataire arrive à la fin.',
    mots: [[79, 181]],
    ratio: '1:1',
    cropX: 0.5,
    status: 'candidate',
  },
  {
    id: 'c02',
    titre: 'Il reste quatre pressions',
    description: 'La chute la plus courte de la soirée, et la plus nette.',
    mots: [[116, 147]],
    ratio: '9:16',
    cropX: 0.52,
    status: 'candidate',
  },
  {
    id: 'c03',
    titre: 'La lettre de ma sœur',
    description: "Impro chantée. Le public s'arrête de bouger au bout de vingt secondes.",
    mots: [[233, 330]],
    ratio: '4:5',
    cropX: 0.46,
    status: 'kept',
  },
  {
    id: 'c04',
    titre: 'Le service après-vente des télésièges',
    description: 'Sylvie ne passera pas de responsable. Sylvie est le responsable.',
    mots: [
      [388, 459],
      [466, 503],
    ],
    ratio: 'auto',
    cropX: 0.5,
    status: 'candidate',
  },
  {
    id: 'c05',
    titre: "C'est écrit au dos, en allemand",
    description: 'Deux phrases, aucun montage nécessaire.',
    mots: [[466, 488]],
    ratio: '9:16',
    cropX: 0.58,
    status: 'candidate',
  },
  {
    id: 'c06',
    titre: "L'ascenseur du deuxième",
    description: 'Poursuite sans parole. Trois joueurs, six ans de bonjour, un bouton.',
    mots: [[585, 658]],
    ratio: '1:1',
    cropX: 0.5,
    status: 'candidate',
  },
  {
    id: 'c07',
    titre: 'Pour la première fois en six ans',
    description: 'La fin de la poursuite. Rien ne se dit, tout se voit.',
    mots: [[628, 658]],
    ratio: '4:5',
    cropX: 0.44,
    status: 'candidate',
  },
  {
    id: 'c08',
    titre: 'Chère Martine',
    description: "Discours de mariage. Onze ans qu'on voit.",
    mots: [
      [706, 770],
      [786, 803],
    ],
    ratio: 'auto',
    cropX: 0.5,
    status: 'candidate',
  },
  {
    id: 'c09',
    titre: "Le canapé, c'était pas moi",
    description: 'Le final du discours, isolé.',
    mots: [[786, 803]],
    ratio: '9:16',
    cropX: 0.5,
    status: 'discarded',
  },
  {
    id: 'c10',
    titre: 'Apprendre à mentir à son chien',
    description: "Tutoriel. La technique ne marche pas, et c'est le sujet.",
    mots: [[847, 916]],
    ratio: '1:1',
    cropX: 0.54,
    status: 'candidate',
  },
  {
    id: 'c11',
    titre: 'Ne croisez pas son regard',
    description: 'Le passage isolé du tutoriel, deux phrases.',
    mots: [[879, 901]],
    ratio: '16:9',
    cropX: 0.5,
    // Un clip déjà rendu : c'est le seul statut où la carte et le bouton
    // divergeaient, et il n'existait dans aucune fixture.
    status: 'exported',
  },
]

function segmentsDepuisMots(id: string, intervalles: [number, number][]): Segment[] {
  const bornes = intervalles.map(([a, b]) => {
    // Lever, et non ignorer. Un index hors bornes ignoré rendait un candidat
    // amputé — ou vide — que l'écran de tri affichait sans un mot : la fixture
    // mentait exactement là où elle sert à vérifier.
    if (!MOTS[a] || !MOTS[b]) {
      throw new Error(`Fixture ${id} : mots ${a}-${b} hors du transcript (${MOTS.length} mots)`)
    }
    return { start: MOTS[a].start, end: MOTS[b].end }
  })
  return normalizeSegments(bornes)
}

function construireClips(): Map<string, CandidateClip> {
  const clips = new Map<string, CandidateClip>()

  for (const p of PROPOSITIONS) {
    const segments = segmentsDepuisMots(p.id, p.mots)
    const debut = segments[0].start
    const fin = segments[segments.length - 1].end
    const apercu = LIGNES.filter((l) => l.end > debut && l.start < fin)
      .slice(0, 3)
      .map((l) => l.words.map((w) => w.word).join(' '))
      .join(' ')

    clips.set(p.id, {
      id: p.id,
      projectId: PROJECT_ID,
      segments,
      ratio: p.ratio,
      cropX: p.cropX,
      captions: true,
      branding: true,
      title: p.titre,
      description: p.description,
      status: p.status,
      pass: 1,
      preview: apercu,
      // La vignette est extraite du proxy par la tâche 12, étape 1. Le proxy
      // n'existe pas encore : `null`, et l'interface a un repli.
      thumbnailUrl: null,
    })
  }

  return clips
}

const CLIPS = construireClips()

/**
 * L'étendue d'origine de chaque clip, figée à la construction.
 *
 * C'est **elle** qui décide de la fenêtre de transcript, et non les segments
 * courants : retirer tous les mots d'un clip laisse une liste vide, et une
 * fenêtre dérivée de cette liste-là n'existerait plus. On perdrait le
 * transcript au moment précis où il faut le relire pour reconstruire le clip.
 * Voir la note sur `ClipDetail.lines` dans `api.ts`, qui en fait une exigence
 * pour la route de la tâche 10.
 */
const ETENDUES = new Map(
  [...CLIPS.values()].map((c) => [
    c.id,
    { start: c.segments[0].start, end: c.segments[c.segments.length - 1].end },
  ]),
)

export function fixtureProject(): ProjectSummary {
  return { ...PROJET }
}

export function fixtureProjectStatus(projectId: string): ProjectStatus {
  return {
    project: { ...PROJET, id: projectId },
    steps: { proxy: true, audio: true, transcript: true, candidates: true, renders: false },
    // Rien ne tourne : le pipeline n'est pas branché en itération 0 côté
    // interface. La forme est là, l'écran de tri sait l'afficher.
    running: null,
  }
}

export function fixtureCandidates(projectId: string): CandidateClip[] {
  return [...CLIPS.values()]
    .filter((c) => c.projectId === projectId)
    .map((c) => ({ ...c, segments: c.segments.map((s) => ({ ...s })) }))
}

/**
 * La marge de transcript montrée autour du clip.
 *
 * C'est ce dont on dispose pour **étendre** les bornes : sans marge, l'écran de
 * clip ne saurait qu'enlever. Deux minutes de chaque côté couvrent largement le
 * cas réel — le repérage cale déjà les bornes sur les mots (tâche 3) — et
 * donnent au passage assez de phrases pour que la virtualisation travaille.
 */
const CONTEXTE_S = 120

export function fixtureClipDetail(clipId: string): ClipDetail {
  const clip = CLIPS.get(clipId)
  if (!clip) throw new Error(`Clip inconnu : ${clipId}`)

  // Sur l'étendue d'origine, jamais sur `clip.segments` : un clip vidé de tous
  // ses mots n'en a plus, et lire `segments[0]` levait alors — le clip
  // paraissait introuvable au rechargement.
  const etendue = ETENDUES.get(clipId) ?? { start: 0, end: 0 }
  const debut = etendue.start - CONTEXTE_S
  const fin = etendue.end + CONTEXTE_S

  return {
    clip: { ...clip, segments: clip.segments.map((s) => ({ ...s })) },
    project: { ...PROJET },
    lines: LIGNES.filter((l) => l.end > debut && l.start < fin),
    // Le proxy arrive avec la tâche 11. Jusque-là le lecteur affiche son repli.
    proxyUrl: null,
  }
}

export function patchFixtureClip(clipId: string, patch: ClipPatch): Clip {
  const clip = CLIPS.get(clipId)
  if (!clip) throw new Error(`Clip inconnu : ${clipId}`)

  const suivant: CandidateClip = {
    ...clip,
    ...patch,
    // Comme la route de la tâche 10, étape 2 : les segments sont normalisés
    // **avant** écriture. L'interface ne peut donc pas stocker un chevauchement,
    // même si un geste en produisait un.
    segments: normalizeSegments(patch.segments ?? clip.segments),
  }
  CLIPS.set(clipId, suivant)

  // La route rend un `Clip`, pas un `CandidateClip` : `preview` et
  // `thumbnailUrl` sont des commodités de l'écran de tri, pas des champs du
  // clip. On les retire explicitement plutôt que par déstructuration, pour que
  // l'ajout d'un champ à `Clip` ne passe pas silencieusement à la trappe.
  const nu: Clip = {
    id: suivant.id,
    projectId: suivant.projectId,
    segments: suivant.segments,
    ratio: suivant.ratio,
    cropX: suivant.cropX,
    captions: suivant.captions,
    branding: suivant.branding,
    title: suivant.title,
    description: suivant.description,
    status: suivant.status,
    pass: suivant.pass,
  }
  return nu
}
