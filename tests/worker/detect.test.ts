import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * Les deux décisions de `worker/detect.py` qu'un consommateur TypeScript ne
 * peut pas voir : ce que le fichier écrit dans `score`, et ce que le worker
 * accepte comme seuil de scène.
 *
 * **Python évalué depuis Vitest, plutôt qu'une suite pytest de plus.** Le dépôt
 * a une commande de test et une seule, et `detect.py` n'a que quatre fonctions à
 * éprouver. Un second harnais coûterait son installation, sa place dans le CI et
 * son propre vieillissement pour ces quatre fonctions-là. Ici Python n'est qu'un
 * évaluateur : il rend du JSON, les assertions restent du côté du dépôt.
 *
 * **Aucun de ces tests ne charge torch ni ultralytics.** Les imports lourds de
 * `detect.py` sont dans `main()`, précisément pour qu'un `--help` réponde tout
 * de suite ; importer le module ne coûte donc que la bibliothèque standard, et
 * `worker/venv` — 7,8 Go, absent d'un checkout frais — n'est pas nécessaire.
 */

const RACINE = path.resolve(import.meta.dirname, '..', '..')

/**
 * Évalue `code` avec `detect` importé, et rend ce que le code imprime en JSON.
 *
 * `python3` du système, pas celui de `worker/venv` : ce qui est éprouvé ici ne
 * dépend que de la bibliothèque standard, et exiger le venv rendrait la suite
 * intestable sur une machine qui n'a pas encore lancé `setup.sh`.
 */
function évaluer(code: string): unknown {
  const préambule = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(path.join(RACINE, 'worker'))})`,
    'import detect',
  ].join('\n')
  let sortie: string
  try {
    sortie = execFileSync('python3', ['-c', `${préambule}\n${code}`], { encoding: 'utf8' })
  } catch (cause) {
    const détail = cause instanceof Error ? cause.message : String(cause)
    throw new Error(`python3 n'a pas pu évaluer worker/detect.py : ${détail}`, { cause })
  }
  return JSON.parse(sortie)
}

/**
 * **Le score écrit ne dépasse jamais le score mesuré.**
 *
 * `src/core/framing.ts` ne garde que les boîtes dont le score atteint 0,5, seuil
 * **inclusif**. Un arrondi au plus proche à trois décimales faisait ressortir une
 * détection à 0,4996 sous la forme `0.5`, qui passait le filtre : le seuil ne
 * valait plus ce qu'il annonçait, et rien ne pouvait le montrer — ni le fichier,
 * ni le cadrage, ni l'image.
 *
 * L'arrondi lui-même n'est pas en cause : il tient la taille du fichier — trente
 * mille boîtes sur une émission — et sa lisibilité. C'est le **sens** de
 * l'arrondi qui l'était. Vers le bas, la valeur écrite est un minorant de la
 * vraie, donc un seuil inclusif posé sur un multiple du millième dit exactement
 * ce qu'il dit. (relevé sur la PR #31, ticket #40)
 */
describe('detect.py — le score écrit dans analysis.json', () => {
  it('n’arrondit pas une détection sous le seuil jusqu’au seuil', () => {
    expect(évaluer('print(json.dumps(detect.arrondi_vers_le_bas(0.4996, 3)))')).toBe(0.499)
    expect(évaluer('print(json.dumps(detect.arrondi_vers_le_bas(0.4999, 3)))')).toBe(0.499)
  })

  it('laisse intact un score qui atteint vraiment le seuil', () => {
    // Le cas symétrique, et celui qui interdit de « régler le problème » en
    // déplaçant le seuil du consommateur : une détection à 0,5 est au-dessus du
    // seuil, et doit le rester.
    expect(évaluer('print(json.dumps(detect.arrondi_vers_le_bas(0.5, 3)))')).toBe(0.5)
    expect(évaluer('print(json.dumps(detect.arrondi_vers_le_bas(0.5004, 3)))')).toBe(0.5)
    expect(évaluer('print(json.dumps(detect.arrondi_vers_le_bas(1.0, 3)))')).toBe(1)
  })

  it('garde trois décimales, ce pour quoi l’arrondi existe', () => {
    // Sans arrondi du tout, `json.dump` écrirait les dix-sept chiffres du
    // flottant : la taille du fichier est l'autre moitié de la décision.
    expect(évaluer('print(json.dumps(detect.arrondi_vers_le_bas(0.876543, 3)))')).toBe(0.876)
  })

  /**
   * Et la preuve que c'est bien branché : un helper juste et jamais appelé
   * n'aurait rien fermé.
   */
  it('écrit ce score-là dans les boîtes, pas un autre', () => {
    const boîtes = évaluer(
      [
        'class Tenseur:',
        '    def __init__(self, v): self.v = v',
        '    def tolist(self): return self.v',
        'class Boîtes:',
        '    def __init__(self, xyxy, conf):',
        '        self.xyxy = Tenseur(xyxy)',
        '        self.conf = Tenseur(conf)',
        'class Résultat:',
        '    def __init__(self, b): self.boxes = b',
        'r = Résultat(Boîtes([[96.0, 54.0, 288.0, 486.0]], [0.4996]))',
        'print(json.dumps(detect.boîtes_du_lot([r], 0, 2.0, 960, 540)))',
      ].join('\n'),
    ) as { score: number }[]
    expect(boîtes).toHaveLength(1)
    expect(boîtes[0].score).toBe(0.499)
  })
})

/**
 * **Un argument accepté qui ne fait rien est le défaut qu'on ferme, pas une
 * commodité.**
 *
 * Les frontières de plans se décident en deux temps : ffmpeg ne rapporte que les
 * images au-dessus d'un plancher de collecte (`--scene-floor`, 0,05), et Python
 * applique ensuite le seuil demandé (`--scene-threshold`, 0,4). Un seuil sous le
 * plancher portait donc sur des candidates qui n'avaient jamais été collectées :
 * l'argument était pris, et il n'avait aucun effet.
 *
 * **Refus plutôt qu'un `min()` silencieux.** Abaisser le plancher tout seul
 * reproduirait le défaut un cran plus bas : à seuil nul, `gt(scene, 0)` retient
 * à peu près chaque image d'une émission de deux heures, et `scores_de_scène`
 * ramasse cette sortie en mémoire d'un seul tenant. On refuse en nommant les
 * deux valeurs, ce qui laisse le choix — baisser le plancher aussi — à qui
 * cherche des coupes plus discrètes. C'est-à-dire à la prochaine itération sur
 * le détecteur. (relevé sur la PR #31, ticket #40)
 */
describe('detect.py — le seuil de scène face à son plancher de collecte', () => {
  const refus = (seuil: number, plancher: number): unknown =>
    évaluer(`print(json.dumps(detect.refus_du_seuil_de_scène(${seuil}, ${plancher})))`)

  it('ne dit rien du couple par défaut, ni d’un seuil posé pile sur le plancher', () => {
    expect(refus(0.4, 0.05)).toBeNull()
    // Égalité acceptée : le plancher ne tait alors que les images strictement
    // en dessous, celles que le seuil écarterait de toute façon.
    expect(refus(0.05, 0.05)).toBeNull()
  })

  it('refuse un seuil sous le plancher, en nommant les deux valeurs', () => {
    const message = refus(0.02, 0.05)
    expect(typeof message).toBe('string')
    expect(message).toContain('0.02')
    expect(message).toContain('0.05')
    // Le remède, pas seulement le grief : sans lui, le refus déplace la
    // devinette au lieu de la supprimer.
    expect(message).toContain('--scene-floor')
  })

  it('refuse un seuil nul ou négatif', () => {
    // C'est le `min()` que le refus évite : à zéro, abaisser le plancher pour
    // « honorer » la demande ferait collecter toute la vidéo.
    expect(typeof refus(0, 0)).toBe('string')
    expect(typeof refus(-1, 0.05)).toBe('string')
  })
})

/**
 * Le refus, tel que Node le rencontre : par un code de sortie et une ligne de
 * stderr, pas par une valeur de retour. Une fonction juste et jamais appelée
 * n'aurait rien fermé — c'est exactement le défaut que ce ticket ferme un cran
 * plus haut, dans `steps/analysis.ts`.
 *
 * Le contrôle est placé avant la passe ffmpeg et avant le chargement du modèle :
 * ces essais ne coûtent ni l'un ni l'autre.
 */
describe('detect.py — le refus, en ligne de commande', () => {
  let racine: string

  beforeEach(() => {
    racine = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-detect-'))
  })

  afterEach(() => {
    fs.rmSync(racine, { recursive: true, force: true })
  })

  const lancer = (seuil: string): { status: number | null; stderr: string } => {
    for (const nom of ['proxy.mp4', 'yolo11m.pt']) fs.writeFileSync(path.join(racine, nom), '')
    // `--ffmpeg /bin/false` : si le refus ne partait pas, la passe de scène
    // échouerait — ce qui est précisément le témoin du second essai.
    const r = spawnSync(
      'python3',
      [
        path.join(RACINE, 'worker', 'detect.py'),
        '--proxy', path.join(racine, 'proxy.mp4'),
        '--out', path.join(racine, 'analysis.json'),
        '--ffmpeg', '/bin/false',
        '--model', path.join(racine, 'yolo11m.pt'),
        '--proxy-size', '960x540',
        '--source-size', '1920x1080',
        '--duration', '10',
        '--scene-threshold', seuil,
      ],
      { encoding: 'utf8' },
    )
    return { status: r.status, stderr: r.stderr }
  }

  it('sort par 2 quand le seuil demandé est sous le plancher', () => {
    const { status, stderr } = lancer('0.02')
    expect(status).toBe(2)
    expect(stderr).toContain('--scene-floor')
    // Rien n'a été écrit : on refuse avant de faire quoi que ce soit.
    expect(fs.existsSync(path.join(racine, 'analysis.json'))).toBe(false)
  })

  it('laisse passer le seuil mesuré, et va jusqu’à la passe de scène', () => {
    // Le témoin : sans lui, un refus posé sur tous les seuils passerait le test
    // ci-dessus sans rien dire.
    const { status, stderr } = lancer('0.4')
    expect(status).not.toBe(2)
    expect(stderr).not.toContain('--scene-floor')
    expect(stderr).toContain('ffmpeg a échoué')
  })
})
