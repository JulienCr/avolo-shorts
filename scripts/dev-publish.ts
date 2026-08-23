/**
 * Publication d'un clip déjà exporté, depuis la ligne de commande.
 *
 *     pnpm tsx scripts/dev-publish.ts clip_0001 --platforms=instagram
 *     pnpm tsx scripts/dev-publish.ts clip_0001 --platforms=instagram,tiktok --force
 *
 * Comme les autres `scripts/dev-*.ts`, c'est ce qui rend la publication
 * vérifiable de bout en bout sans passer par une interface — il n'y en a pas
 * encore : l'écran de clip garde son bouton « Publier » pour la PR qui
 * branchera `onLaunch` une fois #142 et #143 fusionnées. C'est aussi le
 * livrable qui répond, à lui seul, à « brancher l'export Instagram ».
 */

import { PLATFORMS, type Platform } from '@/core/publication'
import { closeDb, getClip, getDb, getPublications } from '@/server/db'
import { publicationAvailability } from '@/server/publication'
import { launchPublish } from '@/server/publication/service'
import { chargerEnv, quit } from './dev-common'

function parsePlatforms(arg: string | undefined): Platform[] {
  if (arg === undefined || arg === '') {
    throw new Error('--platforms=<liste> est requis, par exemple --platforms=instagram,tiktok')
  }
  const requested = arg.split(',').map((p) => p.trim())
  const invalid = requested.filter((p) => !PLATFORMS.includes(p as Platform))
  if (invalid.length > 0) {
    throw new Error(`Plateforme(s) inconnue(s) : ${invalid.join(', ')}. Valeurs possibles : ${PLATFORMS.join(', ')}.`)
  }
  // Même refus qu'à la frontière HTTP (`POST /api/clips/:id/publish`) : une
  // plateforme répétée atteindrait le connecteur avec deux `platform[]`
  // identiques et deux jeux de paramètres pour la même cible.
  const duplicates = requested.filter((p, i) => requested.indexOf(p) !== i)
  if (duplicates.length > 0) {
    throw new Error(`Plateforme(s) répétée(s) : ${[...new Set(duplicates)].join(', ')}.`)
  }
  return requested as Platform[]
}

async function main(): Promise<number> {
  await chargerEnv()

  const arguments_ = process.argv.slice(2)
  const force = arguments_.includes('--force')
  const platformsArg = arguments_.find((a) => a.startsWith('--platforms='))?.slice('--platforms='.length)
  const clipId = arguments_.find((a) => !a.startsWith('--'))
  if (clipId === undefined) {
    console.error(
      'Usage : pnpm tsx scripts/dev-publish.ts <identifiant de clip> --platforms=instagram[,tiktok,…] [--force]',
    )
    return 1
  }
  const platforms = parsePlatforms(platformsArg)

  const db = getDb()
  const clip = getClip(db, clipId)
  if (clip === undefined) {
    console.error(`Clip inconnu : ${clipId}`)
    return 1
  }

  console.log(`Clip       : ${clipId} (${clip.title === '' ? '(sans titre)' : clip.title})`)
  console.log(`Plateformes: ${platforms.join(', ')}${force ? ' (force)' : ''}`)

  // Diagnostic seulement : `launchPublish` ne se fie pas à ce relevé pour
  // décider — chaque plateforme réussit ou échoue seule (spec §6.4), la
  // vraie réponse du connecteur qui la prend fait foi (Meta ou Upload Post,
  // issue #146).
  const availability = await publicationAvailability()
  for (const platform of platforms) {
    const state = availability[platform]
    console.log(`  ${platform.padEnd(10)}: ${state.available ? 'connecté' : state.reason}`)
  }

  const { rows, settled } = launchPublish({ db, clip, platforms, force })
  console.log('Lancé      :')
  for (const row of rows) console.log(`  ${row.platform.padEnd(10)}: ${row.status}`)

  await settled

  const final = getPublications(db, clipId).filter((r) => platforms.includes(r.platform))
  console.log('Résultat   :')
  for (const row of final) {
    const url = row.remoteUrl === null ? '' : ` — ${row.remoteUrl}`
    const error = row.error === null ? '' : ` — ${row.error}`
    console.log(`  ${row.platform.padEnd(10)}: ${row.status}${url}${error}`)
  }
  // `in_progress` après le budget de sondage de `launchPublish` n'est pas un
  // succès : ce script sert à vérifier la chaîne de bout en bout, un code 0
  // dessus annoncerait une publication terminée qui ne l'est pas.
  const settledOk = final.every((r) => r.status === 'published' || r.status === 'submitted')
  return settledOk ? 0 : 1
}

main()
  .then((code) => {
    closeDb()
    quit(code)
  })
  .catch((error: unknown) => {
    closeDb()
    console.error(error instanceof Error ? error.message : error)
    quit(1)
  })
