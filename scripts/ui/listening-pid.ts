/**
 * The PID listening on `port`, without `lsof`: on this box, `lsof` returns
 * an empty result with no error for a port that IS listening — the Docker
 * network namespaces it tries to list make it lose its socket cache
 * (`WARNING: can't stat() nsfs file system /run/docker/netns/…`, measured
 * here). `/proc/net/tcp{,6}` gives the inode of the listening socket, then
 * a scan of `/proc/<pid>/fd` gives the PID holding it — same information,
 * without depending on an external binary.
 */

import fs from 'node:fs'

/** @throws if no socket listening on `port` appears in `/proc/net/tcp{,6}`. */
export function listeningInode(port: number): string {
  const hex = port.toString(16).toUpperCase().padStart(4, '0')
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    const lines = fs.readFileSync(table, 'utf8').split('\n').slice(1)
    for (const line of lines) {
      const cols = line.trim().split(/\s+/)
      if (cols.length < 10) continue
      const localPort = cols[1].split(':')[1]
      const state = cols[3]
      if (localPort === hex && state === '0A') return cols[9]
    }
  }
  throw new Error(`no process is listening on port ${port}.`)
}

/** @throws if no `/proc/<pid>/fd` holds a descriptor to `socket:[inode]`. */
export function pidHoldingInode(inode: string): number {
  const target = `socket:[${inode}]`
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    let fds: string[]
    try {
      fds = fs.readdirSync(`/proc/${entry}/fd`)
    } catch {
      continue
    }
    for (const fd of fds) {
      let link: string
      try {
        link = fs.readlinkSync(`/proc/${entry}/fd/${fd}`)
      } catch {
        continue
      }
      if (link === target) return Number(entry)
    }
  }
  throw new Error(`no process found for the listening socket (inode ${inode}).`)
}

/** @param port Listening port, as a string (from a URL or argv). */
export function listeningPid(port: string): number {
  return pidHoldingInode(listeningInode(Number(port)))
}
