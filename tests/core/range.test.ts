import { describe, it, expect } from 'vitest'
import { parseRange } from '@/core/range'

describe('parseRange', () => {
  it('lit une plage fermée', () => {
    expect(parseRange('bytes=0-1023', 5000)).toEqual({ start: 0, end: 1023 })
  })

  it('lit une plage ouverte', () => {
    expect(parseRange('bytes=1024-', 5000)).toEqual({ start: 1024, end: 4999 })
  })

  it('borne au delà de la taille', () => {
    expect(parseRange('bytes=0-99999', 5000)).toEqual({ start: 0, end: 4999 })
  })

  it('rejette ce qui n est pas une plage', () => {
    expect(parseRange('bytes=abc', 5000)).toBeNull()
  })

  it('rejette une plage inversée', () => {
    expect(parseRange('bytes=900-100', 5000)).toBeNull()
  })

  it('sans en-tête, il n y a pas de plage', () => {
    expect(parseRange(null, 5000)).toBeNull()
  })

  // Le suffixe est la forme que prend « la fin du fichier » : un lecteur vidéo
  // s'en sert pour aller chercher le `moov` d'un MP4 dont l'index est en queue,
  // avant même de savoir quelle taille fait le fichier.
  describe('suffixe', () => {
    it('rend les N derniers octets', () => {
      expect(parseRange('bytes=-500', 5000)).toEqual({ start: 4500, end: 4999 })
    })

    it('rend le fichier entier quand il demande plus que la taille', () => {
      expect(parseRange('bytes=-99999', 5000)).toEqual({ start: 0, end: 4999 })
    })

    // RFC 7233 §2.1 : un suffixe de longueur nulle ne désigne aucun octet, donc
    // rien à servir. Sans ce cas, `bytes=-0` produisait `{start: 5000, end: 4999}`
    // — une plage vide envoyée en 206, que le lecteur attendrait indéfiniment.
    it('rejette un suffixe de longueur nulle', () => {
      expect(parseRange('bytes=-0', 5000)).toBeNull()
    })
  })

  describe('plages insatisfiables', () => {
    it('rejette un début au delà du dernier octet', () => {
      expect(parseRange('bytes=5000-', 5000)).toBeNull()
      expect(parseRange('bytes=99999-100000', 5000)).toBeNull()
    })

    // Un fichier vide n'a pas d'octet à servir : toute plage est insatisfiable.
    // Le cas arrive pour de vrai, avec un proxy dont l'encodage vient d'être
    // interrompu.
    it('rejette tout sur un fichier vide', () => {
      expect(parseRange('bytes=0-', 0)).toBeNull()
      expect(parseRange('bytes=-100', 0)).toBeNull()
    })
  })

  describe('formes refusées', () => {
    it('refuse une unité qui n est pas l octet', () => {
      expect(parseRange('items=0-10', 5000)).toBeNull()
      expect(parseRange('0-10', 5000)).toBeNull()
    })

    it('refuse un en-tête vide ou sans borne', () => {
      expect(parseRange('', 5000)).toBeNull()
      expect(parseRange('bytes=', 5000)).toBeNull()
      expect(parseRange('bytes=-', 5000)).toBeNull()
    })

    it('refuse les nombres qui n en sont pas', () => {
      expect(parseRange('bytes=1.5-2', 5000)).toBeNull()
      expect(parseRange('bytes=-1e3', 5000)).toBeNull()
      expect(parseRange('bytes=+0-10', 5000)).toBeNull()
      expect(parseRange('bytes=0x10-20', 5000)).toBeNull()
    })

    // Servir plusieurs plages exige une réponse `multipart/byteranges`, que
    // cette route ne produit pas. Répondre 416 le dit ; servir la première en
    // silence livrerait moins que ce qui a été demandé sans que le client
    // puisse le voir venir. Aucun `<video>` ne demande de multi-plage.
    it('refuse une demande de plusieurs plages', () => {
      expect(parseRange('bytes=0-100,200-300', 5000)).toBeNull()
    })
  })

  describe('tolérances', () => {
    // Le jeton d'unité est insensible à la casse, et les espaces autour de la
    // valeur d'en-tête ne sont pas signifiants. La casse ne vient pas d'une
    // phrase de la RFC 7233 mais de sa grammaire : elle écrit
    // `bytes-unit = "bytes"`, et une chaîne littérale en ABNF est insensible à
    // la casse par définition (RFC 5234 §2.3). La version précédente de ce
    // commentaire citait RFC 7230 §3.2.6, qui définit ce qu'est un jeton et ne
    // dit rien de sa casse. (relevé par Copilot)
    it('accepte la casse et les espaces autour', () => {
      expect(parseRange('  Bytes=0-1023  ', 5000)).toEqual({ start: 0, end: 1023 })
      expect(parseRange('bytes = 1024 - 2047', 5000)).toEqual({ start: 1024, end: 2047 })
    })

    // Un nombre de 400 chiffres ne tient pas dans un flottant : `Number` rend
    // `Infinity`. Les comparaisons restent justes — l'imprécision des entiers
    // commence à 2^53, soit 9 Po, très au-delà de toute taille de fichier — et
    // la borne fait son travail.
    it('borne un nombre plus grand que ce qu un flottant sait porter', () => {
      expect(parseRange(`bytes=0-${'9'.repeat(400)}`, 5000)).toEqual({ start: 0, end: 4999 })
      expect(parseRange(`bytes=${'9'.repeat(400)}-`, 5000)).toBeNull()
    })
  })

  describe('taille invalide', () => {
    // La taille vient d'un `stat`, mais rien dans la signature ne l'impose. Une
    // taille absurde ne doit pas produire une plage absurde.
    it('rejette une taille négative ou non entière', () => {
      expect(parseRange('bytes=0-10', -1)).toBeNull()
      expect(parseRange('bytes=0-10', 1.5)).toBeNull()
      expect(parseRange('bytes=0-10', Number.NaN)).toBeNull()
      expect(parseRange('bytes=0-10', Number.POSITIVE_INFINITY)).toBeNull()
    })
  })
})
