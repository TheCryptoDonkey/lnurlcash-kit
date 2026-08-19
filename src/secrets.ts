import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'

// A note's id: the `h`/`h2` a WALLET discloses on a rotate, split or merge,
// and the key a SERVICE stores the note under. Never the secret itself.
export const hashK1 = (k1: string): string => bytesToHex(sha256(hexToBytes(k1)))

// LUD-25: for a rotate, split or merge, the WALLET - never the SERVICE -
// generates the replacement note's secret and discloses only its hash. A
// fresh 32 bytes, the same size a Lightning payment preimage is, though
// nothing is ever paid for it: it is simply drawn at random. The SERVICE
// never sees, generates or persists it.
//
// Replaceable so a hardware wallet can supply secrets from its own RNG,
// and so tests can be deterministic. A caller substituting this is taking
// responsibility for an unpredictable 32 bytes: anything guessable is a
// note anyone can spend.
export type RandomSecret = () => string

export const defaultRandomSecret: RandomSecret = () =>
  bytesToHex(crypto.getRandomValues(new Uint8Array(32)))

// A payment preimage, and therefore a note secret: 32 bytes hex.
export const isPreimage = (value: string): boolean =>
  /^[0-9a-fA-F]{64}$/.test(value.trim())
