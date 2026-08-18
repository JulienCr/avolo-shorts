import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  analyserMarqueTemps,
  cheminTemporaire,
  choisirEncodeur,
  créerJournal,
  produireArtefact,
} from '@/server/ffmpeg'

/**
 * Ce qui est testable de `src/server/ffmpeg.ts` sans ffmpeg : la lecture de son
 * flux stderr et le choix de l'encodeur. L'exécution elle-même ne l'est pas, et
 * ce n'est pas grave — c'est exactement pourquoi les argv sont construits dans
 * `src/core/`, où ils sont vérifiés au caractère près.
 */

describe('analyserMarqueTemps', () => {
  it('lit une marque de temps ordinaire', () => {
    expect(analyserMarqueTemps('frame= 240 fps=120 q=28.0 size=1kB time=00:00:08.00 speed=13.8x')).toBe(8)
  })

  it('rend la dernière marque du morceau, pas la première', () => {
    // Un morceau de flux contient plusieurs réécritures : la plus récente fait foi.
    expect(analyserMarqueTemps('time=00:00:01.00\rtime=00:01:00.50\rtime=00:02:03.25')).toBe(123.25)
  })

  it('compose heures, minutes et secondes', () => {
    expect(analyserMarqueTemps('time=01:38:57.00')).toBe(3600 + 38 * 60 + 57)
  })

  it('accepte plus de deux chiffres d heures', () => {
    expect(analyserMarqueTemps('time=100:00:00.00')).toBe(360_000)
  })

  it("rend null sur une marque négative — c'est ce que ffmpeg annonce avant sa première image", () => {
    // `-577014:32:22.77`, soit INT64_MIN divisé par un million. Prise au mot,
    // elle donnerait une barre d'avancement qui commence à moins l'infini.
    expect(analyserMarqueTemps('frame=0 time=-577014:32:22.77 bitrate=N/A')).toBeNull()
  })

  it('une marque négative n annule pas une marque valide qui la suit', () => {
    expect(analyserMarqueTemps('time=-577014:32:22.77\rtime=00:00:04.00')).toBe(4)
  })

  it('rend null sur time=N/A et sur un morceau sans marque', () => {
    expect(analyserMarqueTemps('frame=0 time=N/A bitrate=N/A')).toBeNull()
    expect(analyserMarqueTemps('[libx264 @ 0x55] using cpu capabilities: MMX2 SSE2Fast')).toBeNull()
  })

  it("ne conserve pas d'état entre deux appels", () => {
    // La regex porte le drapeau `g` : un `exec` en boucle sur une constante de
    // module reprendrait à `lastIndex` et raterait la marque du morceau suivant.
    const morceau = 'time=00:00:05.00'
    expect(analyserMarqueTemps(morceau)).toBe(5)
    expect(analyserMarqueTemps(morceau)).toBe(5)
  })
})

describe('créerJournal', () => {
  it('recolle une ligne coupée entre deux morceaux', () => {
    const j = créerJournal()
    j.ajouter('[libx264] mauvaise ')
    j.ajouter('nouvelle\n')
    expect(j.lignes()).toEqual(['[libx264] mauvaise nouvelle'])
  })

  it('rend la queue non terminée, celle qui porte souvent le message final', () => {
    const j = créerJournal()
    j.ajouter('Conversion failed!')
    expect(j.lignes()).toEqual(['Conversion failed!'])
  })

  it('replie les lignes de statistiques les unes sur les autres', () => {
    // Sans ce repli, deux heures d'encodage noieraient les avertissements sous
    // des milliers de réécritures de la même ligne.
    const j = créerJournal(5)
    j.ajouter('[warn] mux overhead\n')
    for (let i = 0; i < 500; i++) j.ajouter(`frame=${i} time=00:00:0${i % 10}.00\r`)
    expect(j.lignes()).toEqual(['[warn] mux overhead', 'frame=499 time=00:00:09.00'])
  })

  it("ne replie pas deux lignes de statistiques séparées par un avertissement", () => {
    const j = créerJournal()
    j.ajouter('frame=1 time=00:00:01.00\r[warn] ici\nframe=2 time=00:00:02.00\r')
    expect(j.lignes()).toEqual(['frame=1 time=00:00:01.00', '[warn] ici', 'frame=2 time=00:00:02.00'])
  })

  it('garde les dernières lignes et jette les plus anciennes', () => {
    const j = créerJournal(3)
    for (let i = 1; i <= 10; i++) j.ajouter(`[warn] ligne ${i}\n`)
    expect(j.lignes()).toEqual(['[warn] ligne 8', '[warn] ligne 9', '[warn] ligne 10'])
  })

  it('ignore les lignes vides et rend un texte prêt pour un message d erreur', () => {
    const j = créerJournal()
    j.ajouter('a\n\n\r\nb\n')
    expect(j.texte()).toBe('a\nb')
  })
})

describe('choisirEncodeur', () => {
  const jamais = () => {
    throw new Error('la sonde ne doit pas tourner quand la valeur est explicite')
  }

  it('respecte une valeur explicite sans sonder', () => {
    expect(choisirEncodeur('x264', jamais)).toBe('x264')
    expect(choisirEncodeur('nvenc', jamais)).toBe('nvenc')
  })

  it('tolère la casse et les espaces', () => {
    expect(choisirEncodeur('  NVENC \n', jamais)).toBe('nvenc')
  })

  it('sonde sur auto, et sur une variable absente ou vide', () => {
    expect(choisirEncodeur('auto', () => true)).toBe('nvenc')
    expect(choisirEncodeur('auto', () => false)).toBe('x264')
    expect(choisirEncodeur(undefined, () => true)).toBe('nvenc')
    expect(choisirEncodeur('   ', () => false)).toBe('x264')
  })

  it('refuse une valeur inconnue au lieu de se rabattre en silence', () => {
    // Un repli discret diviserait la vitesse d'export par 2,3 (4,58x contre
    // 1,97x mesurés) sans que rien ne le signale.
    expect(() => choisirEncodeur('nvidia', jamais)).toThrow(/FFMPEG_ENCODER/)
  })
})

describe('cheminTemporaire', () => {
  it("garde l'extension, dont ffmpeg déduit son muxeur", () => {
    expect(cheminTemporaire('/projects/x/proxy.mp4', 42)).toBe('/projects/x/proxy.partiel-42.mp4')
  })

  it('reste dans le dossier de destination, pour que le renommage soit atomique', () => {
    expect(cheminTemporaire('/a/b/audio.wav', 7)).toBe('/a/b/audio.partiel-7.wav')
  })

  it('accepte un fichier sans extension', () => {
    expect(cheminTemporaire('/a/b/sortie', 7)).toBe('/a/b/sortie.partiel-7')
  })

  it('donne deux noms distincts à deux écritures du même processus', () => {
    // Rien n'interdit un `Promise.all([buildProxy(x), buildProxy(x)])` : sans
    // ce compteur, les deux ffmpeg écriraient dans le même fichier et le
    // renommage rendrait définitif un MP4 entrelacé.
    expect(cheminTemporaire('/p/proxy.mp4')).not.toBe(cheminTemporaire('/p/proxy.mp4'))
  })

  it('reste dans le dossier de destination même sans jeton', () => {
    expect(cheminTemporaire('/p/proxy.mp4')).toMatch(/^\/p\/proxy\.partiel-\d+-\d+\.mp4$/)
  })
})

describe('produireArtefact — la décision de sauter', () => {
  const racines: string[] = []
  const tmp = (): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-ffmpeg-'))
    racines.push(d)
    return d
  }

  afterEach(() => {
    for (const d of racines.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  // Le drapeau : `args` n'est appelé que si l'étape doit vraiment tourner. Il
  // lève, donc le seul fait qu'il soit appelé se voit — et aucun test ici
  // n'atteint ffmpeg.
  const jamais = () => {
    throw new Error("l'étape ne devait pas tourner")
  }

  it("ne lance rien quand l'artefact est déjà là", async () => {
    const dossier = tmp()
    const dst = path.join(dossier, 'proxy.mp4')
    fs.writeFileSync(dst, 'un proxy')
    await expect(produireArtefact({ dst, args: jamais })).resolves.toEqual({
      path: dst,
      skipped: true,
    })
  })

  it('force court-circuite la présence', async () => {
    const dossier = tmp()
    const dst = path.join(dossier, 'proxy.mp4')
    fs.writeFileSync(dst, 'un proxy')
    await expect(produireArtefact({ dst, force: true, args: jamais })).rejects.toThrow(
      /ne devait pas tourner/,
    )
  })

  it("lance l'étape quand l'artefact manque, et ne laisse pas de moignon", async () => {
    const dossier = tmp()
    const dst = path.join(dossier, 'sous-dossier', 'proxy.mp4')
    await expect(produireArtefact({ dst, args: jamais })).rejects.toThrow(/ne devait pas tourner/)
    // Le dossier a bien été créé, et rien de partiel n'y traîne.
    expect(fs.readdirSync(path.dirname(dst))).toEqual([])
  })
})
