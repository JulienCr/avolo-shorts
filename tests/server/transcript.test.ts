import { describe, it, expect } from 'vitest'
import { cheminsCudnn, environnementWorker, racineVenv } from '@/server/steps/transcript'

/**
 * Ce qui se teste du worker sans GPU : l'environnement qu'on lui pose.
 *
 * C'est peu, et c'est pourtant ce qui décide qu'il démarre ou non. Sans le
 * correctif CTranslate2 — le `LD_LIBRARY_PATH` du `run-wsl.sh` du diariseur —,
 * le chargement du modèle échoue sur une bibliothèque cuDNN introuvable, et le
 * message ne nomme ni Python, ni le venv, ni pip.
 */

describe('racineVenv', () => {
  it('remonte de l interpréteur au venv', () => {
    expect(racineVenv('/home/julien/dev/rythmo-impro/diarizer/venv/bin/python')).toBe(
      '/home/julien/dev/rythmo-impro/diarizer/venv',
    )
  })
})

describe('cheminsCudnn', () => {
  it('lit la version de Python dans le venv au lieu de la coder en dur', () => {
    // `run-wsl.sh` écrit `3.10` parce que c'est celle de sa machine. Un venv
    // reconstruit en 3.11 ferait échouer le chargement du modèle.
    expect(cheminsCudnn('/venv', ['python3.11', 'pkgconfig'])).toEqual([
      '/venv/lib/python3.11/site-packages/nvidia/cudnn/lib',
    ])
  })

  it('liste toutes les versions présentes plutôt que d en deviner une', () => {
    expect(cheminsCudnn('/venv', ['python3.12', 'python3.10'])).toEqual([
      '/venv/lib/python3.10/site-packages/nvidia/cudnn/lib',
      '/venv/lib/python3.12/site-packages/nvidia/cudnn/lib',
    ])
  })

  it('retombe sur 3.10 quand le dossier lib est illisible', () => {
    // Un chemin inexistant dans `LD_LIBRARY_PATH` est ignoré par l'éditeur de
    // liens : la supposition ne coûte rien, et si elle est bonne elle sauve.
    expect(cheminsCudnn('/venv', [])).toEqual([
      '/venv/lib/python3.10/site-packages/nvidia/cudnn/lib',
    ])
  })
})

describe('environnementWorker', () => {
  it('pose les deux variables sans lesquelles rien ne démarre', () => {
    const env = environnementWorker({ cudnn: ['/venv/cudnn'], base: {} })
    expect(env.TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD).toBe('1')
    expect(env.LD_LIBRARY_PATH).toBe('/venv/cudnn')
  })

  it('place cuDNN devant le chemin existant, qu il conserve', () => {
    const env = environnementWorker({ cudnn: ['/venv/cudnn'], base: { LD_LIBRARY_PATH: '/usr/lib' } })
    expect(env.LD_LIBRARY_PATH).toBe('/venv/cudnn:/usr/lib')
  })

  it("ne laisse pas de segment vide — un ':' final désigne le dossier courant", () => {
    const env = environnementWorker({ cudnn: ['/venv/cudnn'], base: { LD_LIBRARY_PATH: '' } })
    expect(env.LD_LIBRARY_PATH).toBe('/venv/cudnn')
    expect(env.LD_LIBRARY_PATH).not.toMatch(/:$/)
  })

  it('conserve le reste de l environnement', () => {
    const env = environnementWorker({ cudnn: [], base: { PATH: '/usr/bin', HOME: '/home/julien' } })
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/home/julien')
  })

  it("n'ajoute pas de HF_TOKEN : sans pyannote, les modèles d'alignement sont publics", () => {
    // Le jeton et l'accord sur le Hub ne sont exigés que par pyannote, dont
    // l'itération 0 se passe (spec §17).
    const env = environnementWorker({ cudnn: [], base: {} as Record<string, string | undefined> })
    expect(env.HF_TOKEN).toBeUndefined()
    expect(Object.keys(env).sort()).toEqual(['LD_LIBRARY_PATH', 'TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD'])
  })
})
