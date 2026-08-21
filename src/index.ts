// lnurlcash-kit - LNURLcash (LUD-25) bearer notes for TypeScript.
//
// A bearer note is an ordinary LUD-03 withdrawRequest link whose k1 IS the
// asset:
//
//   lnurlw://mint.example/w?k1=<secret>&amount=<msat>
//
// Whoever knows the k1 controls the sats behind it, like a banknote. The
// `amount` alongside it is only a claim by whoever encoded the note; the
// authoritative value is always maxWithdrawable from an informational GET.
// No new endpoint and no new encoding, so a wallet that has never heard of
// LNURLcash sees a normal withdraw link and can still cash it out.
//
// Every mutating operation is a GET on the `callback` from that
// withdrawRequest:
//
//   callback?k1=X&pr=<bolt11>              melt
//   callback?k1=X&h=<sha256(X')>           rotate
//   callback?k1=X&amount=<msat>&h=..&h2=.. split
//   callback?k1=X&k1=Y&h=<sha256(Z)>       merge
//
// Draft spec: https://github.com/lnurl/luds/pull/301
//
// Reference implementations, both by dni and both MIT:
//   mint   https://github.com/dni/lnurl-mint
//   wallet https://github.com/dni/lnurl-wallet
//
// This library was extracted from that wallet's protocol layer.

export {
  isBech32Lnurl,
  toBech32Lnurl,
  fromBech32Lnurl,
  isAllowedServiceUrl,
  fromLud17,
  toLud17w,
  isLightningAddress,
  resolveMintInput,
  resolveLnurlInput,
  mintAddressUrl,
  lightningAddressUsername,
  serverOf
} from './urls.js'

export {
  noteK1,
  requireNoteK1,
  noteDeclaredAmount,
  noteSignature,
  resolveNoteInput,
  isValidNoteInput,
  buildNoteUrl,
  withNewK1,
  withoutK1
} from './note.js'

export {
  hashK1,
  isPreimage,
  defaultRandomSecret,
  type RandomSecret
} from './secrets.js'

export {
  verifyNoteSignature,
  noteSignatureMessage,
  noteSignatureDigest
} from './signature.js'

export {
  parseMintFee,
  applyMintFee,
  mintFeeBand,
  withinMintFeeBand,
  grossUpForMintFee,
  formatFeePercent,
  describeMintFee,
  type MintFee,
  type MintFeeBand
} from './fees.js'

export {
  isBolt11Invoice,
  sameInvoice,
  decodeBolt11AmountMsat
} from './bolt11.js'

export {
  LnurlcashError,
  RequestRefusedError,
  ProtocolError,
  ServiceRejectedError,
  PendingNoteError,
  NoteSpentError,
  NoteUnknownError,
  AmbiguousMintError,
  AmbiguousMutationError,
  classifyNoteError
} from './errors.js'

export {type LnurlcashOptions} from './transport.js'

export {
  fetchNoteInfo,
  probeBurnedNote,
  fetchMintAddress,
  meltNote,
  rotateNote,
  rotateNoteWithHash,
  splitNote,
  splitNoteWithHash,
  mergeNotes,
  mergeNotesWithHash,
  settleNote,
  fetchPayRequest,
  requestInvoice,
  fetchInvoiceVerification,
  type WithdrawRequestInfo,
  type MintAddressInfo,
  type WithdrawSuccessResponse,
  type MeltResult,
  type HashedMutationResult,
  type HashedSplitResult,
  type RotateResult,
  type SplitResult,
  type SettledNote,
  type PayRequestInfo,
  type InvoiceResult,
  type VerifyResult
} from './client.js'

import type {LnurlcashOptions} from './transport.js'
import * as client from './client.js'

// Every request function takes options as its last argument, so they can be
// used directly. createClient binds one set of options once, for callers
// who would otherwise thread the same object through every call site.
export const createClient = (options: LnurlcashOptions = {}) => ({
  fetchNoteInfo: (url: string) => client.fetchNoteInfo(url, options),
  probeBurnedNote: (url: string) => client.probeBurnedNote(url, options),
  fetchMintAddress: (url: string) => client.fetchMintAddress(url, options),
  meltNote: (callback: string, k1: string, pr: string) =>
    client.meltNote(callback, k1, pr, options),
  rotateNote: (callback: string, k1: string) =>
    client.rotateNote(callback, k1, options),
  rotateNoteWithHash: (callback: string, k1: string, h: string) =>
    client.rotateNoteWithHash(callback, k1, h, options),
  splitNote: (callback: string, k1s: string[], amountMsat: number) =>
    client.splitNote(callback, k1s, amountMsat, options),
  splitNoteWithHash: (
    callback: string,
    k1s: string[],
    amountMsat: number,
    h: string,
    h2: string
  ) => client.splitNoteWithHash(callback, k1s, amountMsat, h, h2, options),
  mergeNotes: (callback: string, k1s: string[]) =>
    client.mergeNotes(callback, k1s, options),
  mergeNotesWithHash: (callback: string, k1s: string[], h: string) =>
    client.mergeNotesWithHash(callback, k1s, h, options),
  settleNote: (
    baseUrl: string,
    k1: string,
    expectedAmountMsat: number,
    signature?: string
  ) => client.settleNote(baseUrl, k1, expectedAmountMsat, signature, options),
  fetchPayRequest: (url: string) => client.fetchPayRequest(url, options),
  requestInvoice: (payCallback: string, amountMsat: number) =>
    client.requestInvoice(payCallback, amountMsat, options),
  fetchInvoiceVerification: (verifyUrl: string) =>
    client.fetchInvoiceVerification(verifyUrl, options)
})

export type LnurlcashClient = ReturnType<typeof createClient>
