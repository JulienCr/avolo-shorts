import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Primitive de verrou de fichier extraite de l'ordonnanceur de publication
 * (`src/server/publication/scheduler.ts`), generalisee a N emplacements pour
 * servir de semaphore inter-processus (jetons GPU / CPU / reseau, PR
 * suivante). Le comportement a un seul emplacement (`slots: 1`) reste
 * identique bit a bit a l'ancien verrou de publication.
 */
export type SlotOptions = { lockDir: string; name: string; slots: number; staleMs: number }
export type SlotHandle = { slot: number; owner: string }

type LockPayload = { pid: number; since: number; owner: string }

const RECLAIM_GUARD_STALE_MS = 60 * 1000

function lockFilename(name: string, slot: number, slots: number): string {
  return slots === 1 ? `.${name}.lock` : `.${name}.${slot}.lock`
}

function reclaimFilename(name: string, slot: number, slots: number): string {
  return slots === 1 ? `.${name}.reclaim` : `.${name}.${slot}.reclaim`
}

function lockPath(o: SlotOptions, slot: number): string {
  return path.join(o.lockDir, lockFilename(o.name, slot, o.slots))
}

function reclaimGuardPath(o: SlotOptions, slot: number): string {
  return path.join(o.lockDir, reclaimFilename(o.name, slot, o.slots))
}

function tryCreateLock(file: string, payload: LockPayload): boolean {
  let fd: number
  try {
    fd = fs.openSync(file, 'wx')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
  // `wx` a reussi : le fichier est a nous, sans conteste. Si l'ecriture ou
  // la fermeture leve ensuite (disque plein, E/S), le laisser en place
  // ferait paraitre le verrou pris pendant toute sa duree de peremption
  // sans qu'aucune passe ne s'execute — le supprimer avant de relever est
  // sur, puisque personne d'autre n'a pu le creer entretemps (relu en revue).
  try {
    fs.writeSync(fd, JSON.stringify(payload))
    fs.closeSync(fd)
    return true
  } catch (error) {
    fs.rmSync(file, { force: true })
    throw error
  }
}

function readLock(file: string): LockPayload | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as LockPayload
  } catch {
    return null
  }
}

/**
 * L'instant pose par le titulaire, ou l'horodatage du fichier si le JSON est
 * incomplet — un processus tue entre `openSync` et l'ecriture ne doit pas
 * laisser un verrou qui parait frais a chaque lecture : `now` changerait a
 * chaque appel, l'horodatage du fichier non (relu en revue).
 */
function lockFileSince(file: string, now: number): number {
  const existing = readLock(file)
  if (existing !== null) return existing.since
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return now
  }
}

/**
 * `process.kill(pid, 0)` n'envoie aucun signal, il sonde seulement
 * l'existence du processus. `EPERM` dit qu'il existe mais appartient a un
 * autre utilisateur — l'information est ambigue, et le defaut prudent face a
 * une ambiguite est de le croire vivant plutot que de risquer une reprise
 * sur un faux mort (decision de l'orchestrateur, pas une deduction locale).
 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * Reprend le verrou d'un emplacement : le renomme vers un nom a soi puis en
 * recree un frais par `wx`. Appele **seulement** sous le verrou de reprise
 * de cet emplacement, donc jamais par deux processus a la fois — c'est ce
 * qui rend ce couple non-atomique sur, l'exclusivite vient d'ailleurs.
 */
function reclaimStaleLock(file: string, owner: string, payload: LockPayload, holderPid: number | undefined): boolean {
  const evicted = `${file}.${owner}.evicted`
  try {
    fs.renameSync(file, evicted)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // Le titulaire a relache entretemps : rien a reprendre, on recree direct.
    return tryCreateLock(file, payload)
  }
  console.warn(`Verrou de publication périmé (posé il y a plus de 30 min, pid ${holderPid ?? '?'} mort) : repris.`)
  fs.rmSync(evicted, { force: true })
  return tryCreateLock(file, payload)
}

/**
 * Prise atomique (`wx`) sur un emplacement donne ; reprise d'un verrou
 * perime seulement si son pid n'est plus vivant, sous un second verrou `wx`
 * dedie a la reprise (decision de l'orchestrateur, apres deux tentatives
 * insuffisantes).
 *
 * **Ni une paire suppression-puis-creation, ni un simple `renameSync`, ne
 * suffisent** (relu en revue, a trois reprises) : dans les deux cas, un
 * second processus qui a lui aussi observe le meme verrou perime peut
 * encore agir entre l'eviction du premier et sa recreation — y compris en
 * renommant le verrou **neuf** que le premier vient de reposer, puisque
 * `renameSync` ne verifie pas ce qu'il deplace. Le verrou de reprise ferme
 * cette fenetre : `wx` garantit qu'un seul processus l'obtient, donc un
 * seul est jamais a l'interieur de la sequence qui evince puis recree —
 * qui reverifie l'age et la vivacite du pid **sous** ce verrou plutot que
 * de faire confiance a ce qu'il a observe avant de l'obtenir.
 *
 * **L'age seul ne suffit pas non plus** pour le verrou principal (relu en
 * revue) : une passe qui depasse `staleMs` de bonne foi verrait sinon son
 * verrou vole par le reveil suivant pendant qu'elle travaille encore. Le pid
 * vivant l'emporte sur l'age, quel qu'il soit.
 *
 * **Le verrou de reprise, lui, se contente de l'age** — une minute suffit,
 * et rien de plus n'est necessaire : il n'est jamais tenu a travers un
 * envoi, seulement le temps d'une poignee d'appels systeme, donc son seul
 * risque est un processus tue en plein milieu, pas une lenteur legitime.
 */
function acquireOneSlot(
  o: SlotOptions,
  slot: number,
  now: number,
  isAlive: (pid: number) => boolean,
): { acquired: true; owner: string } | { acquired: false; since: number } {
  const file = lockPath(o, slot)
  const owner = `${process.pid}-${randomUUID()}`
  const payload: LockPayload = { pid: process.pid, since: now, owner }

  if (tryCreateLock(file, payload)) return { acquired: true, owner }

  const since = lockFileSince(file, now)
  if (now - since < o.staleMs) return { acquired: false, since }

  const guard = reclaimGuardPath(o, slot)
  const guardPayload: LockPayload = { pid: process.pid, since: now, owner }
  if (!tryCreateLock(guard, guardPayload)) {
    // Un autre processus reprend deja ce meme verrou perime, ou tient encore
    // son propre verrou de reprise recent : on se retire plutot que de
    // risquer la meme course en parallele du sien.
    const guardSince = lockFileSince(guard, now)
    if (now - guardSince < RECLAIM_GUARD_STALE_MS) return { acquired: false, since: lockFileSince(file, now) }
    // Le verrou de reprise lui-meme est perime — son titulaire est mort en
    // plein milieu d'une reprise, qui ne dure qu'une poignee d'appels
    // systeme : l'age seul suffit a le reprendre, aucun pid a verifier.
    fs.rmSync(guard, { force: true })
    if (!tryCreateLock(guard, guardPayload)) return { acquired: false, since: lockFileSince(file, now) }
  }
  try {
    // Reverifie **sous** le verrou de reprise, pas seulement avant : l'etat
    // observe en dehors peut avoir change pendant qu'on attendait `wx`.
    const stillSince = lockFileSince(file, now)
    if (now - stillSince < o.staleMs) return { acquired: false, since: stillSince }
    const holder = readLock(file)
    if (holder !== null && isAlive(holder.pid)) {
      console.warn(`Verrou de publication vieux de plus de 30 min mais pid ${holder.pid} toujours vivant : pas repris.`)
      return { acquired: false, since: stillSince }
    }
    if (reclaimStaleLock(file, owner, payload, holder?.pid)) return { acquired: true, owner }
    // Impossible en principe sous le verrou de reprise — personne d'autre ne
    // devrait pouvoir reposer un verrou frais pendant qu'on le tient — mais
    // on se retire plutot que de l'ecraser si ca arrivait quand meme.
    return { acquired: false, since: lockFileSince(file, now) }
  } finally {
    fs.rmSync(guard, { force: true })
  }
}

/** Tries every slot in order; `null` when all are held. Never waits. */
export function acquireSlot(o: SlotOptions, now: number, isAlive: (pid: number) => boolean): SlotHandle | null {
  for (let slot = 0; slot < o.slots; slot++) {
    const result = acquireOneSlot(o, slot, now, isAlive)
    if (result.acquired) return { slot, owner: result.owner }
  }
  return null
}

/**
 * Depuis quand un emplacement est tenu (ou son horodatage disque a defaut de
 * JSON valide) — ce qu'un appelant reporte a l'utilisateur quand `acquireSlot`
 * echoue faute d'emplacement libre.
 */
export function lockSince(o: SlotOptions, slot: number, now: number): number {
  return lockFileSince(lockPath(o, slot), now)
}

/**
 * Ne supprime que le verrou qu'on a pose soi-meme : un titulaire perime qui
 * se reveille apres avoir ete repris ne doit pas effacer le verrou frais du
 * processus qui a repris sa place (relu en revue).
 */
export function releaseSlot(o: SlotOptions, handle: SlotHandle): void {
  const file = lockPath(o, handle.slot)
  if (readLock(file)?.owner === handle.owner) fs.rmSync(file, { force: true })
}

/** Deletes slot files whose pid is dead. Returns how many were freed. */
export function sweepDeadSlots(o: SlotOptions, isAlive: (pid: number) => boolean): number {
  let freed = 0
  for (let slot = 0; slot < o.slots; slot++) {
    const file = lockPath(o, slot)
    const holder = readLock(file)
    if (holder !== null && !isAlive(holder.pid)) {
      fs.rmSync(file, { force: true })
      freed++
    }
  }
  return freed
}
