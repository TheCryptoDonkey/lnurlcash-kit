import {
  InsufficientValueError,
  RequestRefusedError,
  ServiceRejectedError
} from './errors.js'
import {fetchNoteInfo, rotateNote, type SettledNote} from './client.js'
import {noteSignature, requireNoteK1, resolveNoteInput, withNewK1} from './note.js'
import {verifyNoteSignature} from './signature.js'
import {serverOf} from './urls.js'
import type {LnurlcashOptions} from './transport.js'

// ---- accepting a note as payment ----
//
// Every server that takes a bearer note for something - an HTTP 402 rail, a
// paywall, a vending machine - makes the same sequence of decisions, and
// gets them wrong in the same ways. This is that sequence, written once.
//
// The order matters, and the last step is the one people leave out:
//
//   1. the input parses as a note at all
//   2. its mint is one this server accepts
//   3. an informational GET, for the AUTHORITATIVE value and the mint's key
//      (a note URL's own `amount` is a claim by whoever encoded it)
//   4. the signature, where the server demands one
//   5. the value covers the price
//   6. ROTATE, which is the settlement
//
// Step 6 is not bookkeeping after the fact. Rotating burns the offered
// secret and mints a replacement only this server knows, in one atomic
// request at the mint: it transfers ownership and rejects a replay in the
// same call, because the second presentation of the same note finds it
// already spent. A server that checks a note's value and grants access
// without rotating has verified a photograph of a banknote.

export type SettleForValueOptions = {
  // Mint hosts this server accepts, as hosts ("mint.example",
  // "127.0.0.1:8899") or as any URL at them. An empty list accepts nothing:
  // a note is a claim on one specific operator, and "any mint" is not a
  // policy a server can hold by accident.
  mints: string[]
  // The price, in msat. The note's authoritative value must be at least
  // this. Overpayment is the payer's business, and stays with the server -
  // split the note before presenting it if that matters.
  minMsat: number
  // Demand offline proof that the mint issued this note for this amount
  // before spending a round trip on it. Off by default: most mints sign,
  // but a mint with no funding source cannot, and the informational GET is
  // authoritative either way.
  requireSignature?: boolean
}

export type SettledForValue = {
  note: SettledNote
  // The full note URL for the replacement, ready to store, melt or hand to
  // a sweep. Carries the authoritative amount and the fresh signature.
  newUrl: string
}

const normaliseHost = (value: string): string =>
  serverOf(value.trim().replace(/^@/, '')).toLowerCase()

// Settles a note offered as payment, or throws saying why not.
//
//   ServiceRejectedError    refused by THIS server: an unaccepted mint, or a
//                           signature that is missing or does not verify
//     InsufficientValueError  worth less than minMsat, with both numbers
//     NoteSpentError          the mint refused the rotate: already spent, or
//                             presented twice
//   RequestRefusedError     the input is not a note this library will fetch
//   AmbiguousMutationError  the rotate's outcome is UNKNOWN. Persist
//                           err.newSecrets BEFORE anything else and probe:
//                           if it landed, that secret is the only copy of
//                           the money and this server now owns it.
//
// Nothing is burned by any refusal before the rotate, so a note this
// function rejects is still the payer's, intact.
export const settleNoteForValue = async (
  noteUrl: string,
  {mints, minMsat, requireSignature = false}: SettleForValueOptions,
  options: LnurlcashOptions = {}
): Promise<SettledForValue> => {
  const url = resolveNoteInput(noteUrl)
  if (!url) {
    // Nothing was sent and nothing was touched, which is exactly what
    // RequestRefusedError means.
    throw new RequestRefusedError(
      'That is not a bearer note this library will fetch.'
    )
  }
  const host = serverOf(url).toLowerCase()
  const accepted = mints.map(normaliseHost)
  if (!accepted.includes(host)) {
    throw new ServiceRejectedError(
      accepted.length === 0
        ? 'This server accepts no mints.'
        : `Notes from ${host} are not accepted here.`
    )
  }
  const k1 = requireNoteK1(url)
  // The value the SERVICE states, never the one the URL claims.
  const info = await fetchNoteInfo(url, options)
  if (requireSignature) {
    const signature = noteSignature(url)
    if (!signature) {
      throw new ServiceRejectedError('This note carries no signature.')
    }
    if (!info.mintPubkey) {
      throw new ServiceRejectedError(
        'The mint published no signing key to check this note against.'
      )
    }
    // Over the AUTHORITATIVE amount. A note whose URL inflates its value
    // fails here, because the mint signed the true one.
    if (
      !verifyNoteSignature(k1, info.maxWithdrawable, signature, info.mintPubkey)
    ) {
      throw new ServiceRejectedError("This note's signature does not verify.")
    }
  }
  if (info.maxWithdrawable < minMsat) {
    throw new InsufficientValueError(info.maxWithdrawable, minMsat)
  }
  // Settlement. The replacement secret is generated HERE and disclosed only
  // as its hash, so the payer - who still holds the secret they presented -
  // cannot spend the note again, and neither can anyone who logged the URL
  // in transit.
  const rotated = await rotateNote(info.callback, k1, options)
  return {
    note: {
      k1: rotated.k1,
      amountMsat: info.maxWithdrawable,
      signature: rotated.signature,
      callback: info.callback
    },
    newUrl: withNewK1(url, rotated.k1, info.maxWithdrawable, rotated.signature)
  }
}
