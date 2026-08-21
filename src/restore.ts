import {NoteSpentError, NoteUnknownError, PendingNoteError} from './errors.js'
import {fetchNoteInfo} from './client.js'
import {buildNoteUrl} from './note.js'
import {deriveNoteSecret} from './secrets.js'
import type {LnurlcashOptions} from './transport.js'

// ---- restore from a seed ----
//
// A wallet whose secrets are derived (see secrets.ts) can rebuild itself
// from the seed and the mint alone: walk the indices, ask the SERVICE what
// each derived secret is worth, and stop once a run of them is unknown.
// The SERVICE is not told anything it does not already hold - it stores
// every note under sha256(k1) and is simply being asked about its own
// records, one note at a time.
//
// Two things this is not. It is not a way to discover which mints a wallet
// used: the caller supplies the host, because a mint cannot be guessed from
// a seed. And it is not free of exposure - every k1 walked goes on the
// wire, so a note found here SHOULD be rotated straight after, which also
// gets it the signature a restored note never has.

export type RestoredNote = {
  index: number
  k1: string
  // What the SERVICE says the note is worth, in msat. `null` for a pending
  // note: a melt is in flight on it and the SERVICE will not state a value
  // until that resolves. The note may yet come back, and it may not.
  amountMsat: number | null
  state: 'live' | 'pending'
}

export type RestoreResult = {
  found: RestoredNote[]
  // The next unused index for this host: one past the highest index the
  // SERVICE recognised, or `start` if it recognised none. This is the
  // counter a wallet resumes from, and it deliberately counts SPENT indices
  // as used - re-deriving a burned note's secret would mint a duplicate id.
  next: number
}

export type RestoreOptions = {
  // How many consecutive unknown indices end the walk. Cashu's NUT-13 uses
  // 20 and wallets have been built against that number for years; a gap
  // only appears when a wallet bumped its counter and then failed before
  // the wire call, which is rare and never happens twenty times in a row.
  gap?: number
  // Where to resume from. A wallet that already restored to index 40 passes
  // 40 rather than walking those forty again.
  start?: number
}

// Reads only. Nothing here rotates, melts or otherwise touches a note, so a
// restore that is interrupted has changed nothing and can simply be run
// again. An unexpected failure - the mint down, a response that is not a
// withdrawRequest - is thrown rather than swallowed: a half-walked run that
// reported `next` as though it had finished would leave the wallet
// re-deriving secrets the mint has already issued notes at.
export const restoreNotes = async (
  baseUrl: string,
  root: Uint8Array,
  host: string,
  {gap = 20, start = 0}: RestoreOptions = {},
  options: LnurlcashOptions = {}
): Promise<RestoreResult> => {
  if (!Number.isSafeInteger(gap) || gap < 1) {
    throw new RangeError(`The gap limit must be a positive integer, not ${gap}.`)
  }
  const found: RestoredNote[] = []
  let lastUsed: number | null = null
  let unknownRun = 0
  for (let index = start; unknownRun < gap; index++) {
    const k1 = deriveNoteSecret(root, host, index)
    try {
      const info = await fetchNoteInfo(buildNoteUrl(baseUrl, k1), options)
      found.push({index, k1, amountMsat: info.maxWithdrawable, state: 'live'})
      lastUsed = index
      unknownRun = 0
    } catch (err) {
      if (err instanceof PendingNoteError) {
        // Alive, value unstated. Recorded so the caller can reconcile it
        // later rather than losing the index to the gap counter.
        found.push({index, k1, amountMsat: null, state: 'pending'})
        lastUsed = index
        unknownRun = 0
      } else if (err instanceof NoteSpentError) {
        // Spent is still used. The note is gone, but the index is not free.
        lastUsed = index
        unknownRun = 0
      } else if (err instanceof NoteUnknownError) {
        unknownRun++
      } else {
        throw err
      }
    }
  }
  return {found, next: lastUsed === null ? start : lastUsed + 1}
}
