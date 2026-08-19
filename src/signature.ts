import {sha256} from '@noble/hashes/sha2.js'
import {secp256k1} from '@noble/curves/secp256k1.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {hashK1} from './secrets.js'

// ---- LUD-25 offline verification ----
//
// A SERVICE may sign each note it issues with its Lightning node identity
// key - the same key it signs BOLT-11 invoices with - so a holder can
// confirm a note's issuer and amount without contacting anyone. Signed via
// the node's own signmessage RPC (lnd's /v1/signmessage, cln's
// signmessage), which wraps the message with this prefix and
// double-sha256s it before signing. That is deliberate reuse: any tool
// that already verifies a Lightning node's signed messages can verify a
// note, and neither backend can produce a bespoke raw-digest scheme
// anyway.
//
//   message = "LNURLcash:" || amount_msat (decimal ASCII) || ":" || hex(sha256(k1))
//   digest  = sha256(sha256("Lightning Signed Message:" || message))
//
// The signature commits to the note's HASH, not its secret, so a holder can
// prove issuance - to expose a mint that will not honour its own note, say -
// without revealing what would let anyone spend it.

const LIGHTNING_SIGNED_MESSAGE_PREFIX = utf8ToBytes('Lightning Signed Message:')

export const noteSignatureMessage = (k1: string, amountMsat: number): string =>
  `LNURLcash:${amountMsat}:${hashK1(k1)}`

export const noteSignatureDigest = (
  k1: string,
  amountMsat: number
): Uint8Array =>
  sha256(
    sha256(
      new Uint8Array([
        ...LIGHTNING_SIGNED_MESSAGE_PREFIX,
        ...utf8ToBytes(noteSignatureMessage(k1, amountMsat))
      ])
    )
  )

// Recovers the signer's pubkey from (k1, amountMsat, signature) and checks
// it against `mintPubkey` - true only if both match.
//
// The signature is 65 bytes, but which end carries the recovery id varies
// by implementation in practice: LUD-25 calls for r || s || recovery-id,
// the layout raw BOLT-11 signatures use, while lnurl-mint once forwarded
// its node's signmessage output unreordered as recovery-id || r || s. That
// is fixed upstream, but other implementations may still get it wrong.
// Trying both orderings costs nothing security-wise - recovering against
// the wrong one yields an unrelated pubkey that cannot match mintPubkey -
// and means a note verifies regardless of which convention issued it.
export const verifyNoteSignature = (
  k1: string,
  amountMsat: number,
  signatureHex: string,
  mintPubkeyHex: string
): boolean => {
  let wireSig: Uint8Array
  try {
    wireSig = hexToBytes(signatureHex)
  } catch {
    return false
  }
  if (wireSig.length !== 65) return false
  // a malformed k1 (non-hex) makes the hashing throw - an unverifiable
  // signature is a "no", never a crash
  let digest: Uint8Array
  try {
    digest = noteSignatureDigest(k1, amountMsat)
  } catch {
    return false
  }
  const target = mintPubkeyHex.trim().toLowerCase()
  const recoveryIdFirst = new Uint8Array([
    wireSig[64]!,
    ...wireSig.subarray(0, 64)
  ])
  for (const candidate of [recoveryIdFirst, wireSig]) {
    try {
      // prehash: false because `digest` is already the final double-sha256
      // the signer put its pen to. The library default would hash it again,
      // recovering against a value nothing ever signed - which never
      // matches a real signer's key, and is invisible in a test suite whose
      // mock signer makes the same mistake in the same direction.
      const recovered = secp256k1.recoverPublicKey(candidate, digest, {
        prehash: false
      })
      if (bytesToHex(recovered) === target) return true
    } catch {
      // not a valid recovery under this ordering - try the other
    }
  }
  return false
}
