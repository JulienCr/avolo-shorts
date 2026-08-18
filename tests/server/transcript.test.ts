import { describe, it, expect } from 'vitest'
import {
  cheminsCudnn,
  environnementWorker,
  épurerMandataire,
  racineVenv,
} from '@/server/steps/transcript'

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

  it('redécoupe le chemin hérité : un segment vide au milieu compte aussi', () => {
    // La première version ne regardait que la valeur héritée entière, donc
    // `/usr/lib::/opt/lib:` la traversait telle quelle — avec ses deux segments
    // vides, chacun désignant le dossier courant. (relevé par Copilot)
    const env = environnementWorker({
      cudnn: ['/venv/cudnn'],
      base: { LD_LIBRARY_PATH: '/usr/lib::/opt/lib:' },
    })
    expect(env.LD_LIBRARY_PATH).toBe('/venv/cudnn:/usr/lib:/opt/lib')
    expect((env.LD_LIBRARY_PATH ?? '').split(':').filter((s) => s === '')).toEqual([])
  })

  it("conserve ce sans quoi un processus ne tourne pas", () => {
    const env = environnementWorker({ cudnn: [], base: { PATH: '/usr/bin', HOME: '/home/julien' } })
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/home/julien')
  })

  it("n'ajoute pas de HF_TOKEN : sans diarisation, aucun jeton n'est exigé", () => {
    const env = environnementWorker({ cudnn: [], base: {} })
    expect(env.HF_TOKEN).toBeUndefined()
    expect(Object.keys(env).sort()).toEqual(['LD_LIBRARY_PATH', 'TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD'])
  })

  it('ne transmet que la liste blanche : le worker n a besoin d aucun secret', () => {
    // Le chemin de fuite n'est pas théorique : le stderr du worker est remonté
    // par `onLog`, que la tâche 10 exposera à un client HTTP. Il suffit qu'une
    // bibliothèque Python vide son environnement dans une trace.
    // (relevé par Aristarque)
    const env = environnementWorker({
      cudnn: [],
      base: {
        GEMINI_API_KEY: 'secret',
        HF_TOKEN: 'secret',
        AWS_SECRET_ACCESS_KEY: 'secret',
        DB_PASSWORD: 'secret',
        // Les deux qui ont enterré la liste noire : un mot de passe dans
        // l'autorité d'une URL ne ressemble ni à KEY, ni à TOKEN, ni à SECRET.
        // (relevé par Copilot)
        DATABASE_URL: 'postgres://user:motdepasse@hôte/base',
        REDIS_URL: 'redis://:motdepasse@hôte:6379',
        // Et n'importe quel nom qu'on n'a pas prévu.
        DEPLOIEMENT_JETON_INTERNE: 'secret',
        PATH: '/usr/bin',
        HOME: '/home/julien',
      },
    })
    for (const nom of [
      'GEMINI_API_KEY',
      'HF_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
      'DB_PASSWORD',
      'DATABASE_URL',
      'REDIS_URL',
      'DEPLOIEMENT_JETON_INTERNE',
    ]) {
      expect(env[nom]).toBeUndefined()
    }
    expect(JSON.stringify(env)).not.toContain('motdepasse')
    // Et rien d'utile n'est parti avec.
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/home/julien')
  })

  it('laisse passer les caches de modèles, sans quoi huit gigaoctets repartent', () => {
    const env = environnementWorker({
      cudnn: [],
      base: {
        HF_HOME: '/cache/hf',
        TORCH_HOME: '/cache/torch',
        XDG_CACHE_HOME: '/cache/xdg',
        CUDA_VISIBLE_DEVICES: '0',
        HTTPS_PROXY: 'http://mandataire:3128',
      },
    })
    expect(env.HF_HOME).toBe('/cache/hf')
    expect(env.TORCH_HOME).toBe('/cache/torch')
    expect(env.XDG_CACHE_HOME).toBe('/cache/xdg')
    expect(env.CUDA_VISIBLE_DEVICES).toBe('0')
    expect(env.HTTPS_PROXY).toBe('http://mandataire:3128')
  })

  it("épure l'autorité des URLs de mandataire, qui portaient le secret par la bande", () => {
    // Nommer une variable dans une liste blanche dit qu'on veut *ce réglage*,
    // pas qu'on veut le secret qui voyage avec. (relevé par Aristarque)
    const env = environnementWorker({
      cudnn: [],
      base: {
        HTTP_PROXY: 'http://utilisateur:motdepasse@mandataire:3128',
        https_proxy: 'https://utilisateur:motdepasse@mandataire:3129',
        NO_PROXY: 'localhost,127.0.0.1',
      },
    })
    expect(JSON.stringify(env)).not.toContain('motdepasse')
    expect(env.HTTP_PROXY).toBe('http://mandataire:3128/')
    expect(env.https_proxy).toBe('https://mandataire:3129/')
    // Une liste d'hôtes n'a pas d'autorité : elle traverse intacte.
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1')
  })
})

describe('épurerMandataire', () => {
  it('laisse intacte une URL sans identifiants', () => {
    expect(épurerMandataire('http://mandataire:3128')).toBe('http://mandataire:3128')
  })

  it("retire l'utilisateur et le mot de passe", () => {
    expect(épurerMandataire('http://u:m@h:3128')).toBe('http://h:3128/')
    expect(épurerMandataire('http://u@h:3128')).toBe('http://h:3128/')
  })

  it('traite aussi la forme sans schéma, qui porte le même secret', () => {
    expect(épurerMandataire('u:motdepasse@hôte:3128')).toBe('hôte:3128')
  })

  it('laisse passer ce qui ne ressemble à rien plutôt que de le jeter', () => {
    expect(épurerMandataire('localhost,127.0.0.1')).toBe('localhost,127.0.0.1')
  })
})
