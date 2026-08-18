import { describe, expect, it } from 'vitest'

import type { Clip } from '@/core/edl'
import { differences, reconciliation } from '@/lib/enregistrement'

function clip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    projectId: 'p1',
    segments: [{ start: 10, end: 14.8 }],
    ratio: 'auto',
    cropX: 0.5,
    captions: true,
    branding: true,
    title: 'Un titre',
    description: '',
    status: 'candidate',
    pass: 1,
    ...overrides,
  }
}

describe('differences', () => {
  it('ne voit rien à écrire quand l’état local est celui du serveur', () => {
    const reference = clip()
    expect(differences(reference, [{ start: 10, end: 14.8 }], 'auto', 0.5)).toBeNull()
  })

  it('n’envoie que les champs qui ont bougé', () => {
    // Un patch qui répète les champs inchangés ferait écarter, côté serveur, des
    // valeurs que personne n'a touchées : l'ordre s'y compare champ par champ.
    const reference = clip()
    expect(differences(reference, [{ start: 10, end: 14.8 }], 'auto', 0.62)).toEqual({
      cropX: 0.62,
    })
  })

  it('voit une coupe interne, à bornes égales', () => {
    const reference = clip()
    const coupé = [
      { start: 10, end: 12 },
      { start: 13, end: 14.8 },
    ]
    expect(differences(reference, coupé, 'auto', 0.5)).toEqual({ segments: coupé })
  })

  it('voit un clip entièrement vidé', () => {
    expect(differences(clip(), [], 'auto', 0.5)).toEqual({ segments: [] })
  })
})

describe('reconciliation', () => {
  // Le contrat de `PatchClipResult` : `applied: false` veut dire « une écriture
  // plus récente a gagné ». Sans se remettre d'accord avec elle, l'état local
  // reste sur l'intention refusée, la comparaison suivante la retrouve, et
  // l'enregistrement différé la renvoie avec un jeton neuf — donc gagnant.
  it('adopte la valeur du serveur sur le champ refusé', () => {
    const gagnant = clip({ cropX: 0.9 })
    const àAdopter = reconciliation({ cropX: 0.3 }, gagnant, {
      segments: gagnant.segments,
      ratio: 'auto',
      cropX: 0.3,
    })
    expect(àAdopter).toEqual({ cropX: 0.9 })
  })

  it('ne touche pas un champ que l’utilisateur a modifié depuis l’envoi', () => {
    // Le refus décrit l'intention partie il y a un aller-retour réseau. Adopter
    // le serveur ici jetterait un geste postérieur, que rien n'a refusé.
    const gagnant = clip({ cropX: 0.9 })
    expect(
      reconciliation({ cropX: 0.3 }, gagnant, {
        segments: gagnant.segments,
        ratio: 'auto',
        cropX: 0.42,
      }),
    ).toBeNull()
  })

  it('ne touche pas un champ absent du patch refusé', () => {
    // `applied` est faux dès qu'**un** champ a été écarté ; les autres champs du
    // même patch sont écrits. Un champ que ce patch ne portait pas n'a donc rien
    // à voir avec ce refus.
    const gagnant = clip({ cropX: 0.9, ratio: '1:1' })
    expect(
      reconciliation({ cropX: 0.3 }, gagnant, {
        segments: gagnant.segments,
        ratio: 'auto',
        cropX: 0.3,
      }),
    ).toEqual({ cropX: 0.9 })
  })

  it('ne rend rien quand le serveur porte déjà la valeur locale', () => {
    // Le cas du patch partiellement appliqué : `applied` est faux à cause d'un
    // autre champ, et celui-ci est bien passé. Rendre `null` évite un rendu, et
    // surtout une écriture dans le store qui n'apprendrait rien.
    const gagnant = clip({ cropX: 0.3 })
    expect(
      reconciliation({ cropX: 0.3 }, gagnant, {
        segments: gagnant.segments,
        ratio: 'auto',
        cropX: 0.3,
      }),
    ).toBeNull()
  })

  it('adopte les segments du gagnant, comparés valeur par valeur', () => {
    const local = [
      { start: 10, end: 12 },
      { start: 13, end: 14.8 },
    ]
    const gagnant = clip({ segments: [{ start: 10, end: 14.8 }] })
    // L'intention refusée et l'état local sont deux tableaux distincts qui
    // décrivent le même montage : une comparaison d'identité ne verrait pas
    // qu'ils sont égaux et laisserait l'intention refusée repartir.
    expect(
      reconciliation({ segments: local.map((s) => ({ ...s })) }, gagnant, {
        segments: local,
        ratio: 'auto',
        cropX: 0.5,
      }),
    ).toEqual({ segments: gagnant.segments })
  })

  it('ignore les champs qui ne sont pas du montage', () => {
    // Le titre et la description ne vivent pas dans le store : les réconcilier
    // ici écrirait dans un état qui ne les porte pas.
    const gagnant = clip({ title: 'Le titre du serveur' })
    expect(
      reconciliation({ title: 'Mon titre' }, gagnant, {
        segments: gagnant.segments,
        ratio: 'auto',
        cropX: 0.5,
      }),
    ).toBeNull()
  })
})
