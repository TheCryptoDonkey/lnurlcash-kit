import {
  AmbiguousMintError,
  AmbiguousMutationError,
  NoteSpentError,
  NoteUnknownError,
  PendingNoteError,
  ProtocolError,
  RequestRefusedError,
  ServiceRejectedError,
  classifyNoteError
} from './errors.js'
import {lnurlFetch, resolveOptions, type LnurlcashOptions} from './transport.js'
import {hashK1} from './secrets.js'
import {noteK1, withNewK1} from './note.js'
import {decodeBolt11AmountMsat} from './bolt11.js'
import {parseMintFee, type MintFee} from './fees.js'

// ---- the informational GET ----

export type WithdrawRequestInfo = {
  tag: 'withdrawRequest'
  callback: string
  k1: string
  minWithdrawable: number
  maxWithdrawable: number
  defaultDescription?: string
  mintPubkey?: string
}

// LUD-03 step one. Never burns, rotates or alters the note. maxWithdrawable
// is the only authoritative statement of what the note is worth; the URL's
// own `amount` is a claim the SERVICE ignores here.
//
// This necessarily puts k1 on the wire, so a caller still holding the note
// afterwards SHOULD rotate it.
export const fetchNoteInfo = async (
  url: string,
  options: LnurlcashOptions = {}
): Promise<WithdrawRequestInfo> => {
  const opts = resolveOptions(options)
  // `sig` is only meaningful to a holder inspecting the note locally - the
  // SERVICE already knows what it signed - so it is dropped rather than
  // sent along for nothing. k1 and amount are left as they are.
  const reqUrl = new URL(url)
  reqUrl.searchParams.delete('sig')
  let body: any
  try {
    body = await lnurlFetch(reqUrl, opts)
  } catch (err) {
    if (err instanceof ServiceRejectedError) throw classifyNoteError(err.reason)
    throw err
  }
  if (
    body?.tag !== 'withdrawRequest' ||
    typeof body.callback !== 'string' ||
    typeof body.k1 !== 'string' ||
    typeof body.maxWithdrawable !== 'number' ||
    !Number.isFinite(body.maxWithdrawable) ||
    body.maxWithdrawable < 0 ||
    (body.minWithdrawable !== undefined &&
      (typeof body.minWithdrawable !== 'number' ||
        !Number.isFinite(body.minWithdrawable) ||
        body.minWithdrawable < 0 ||
        body.minWithdrawable > body.maxWithdrawable))
  ) {
    throw new ProtocolError('Not a withdrawRequest (unexpected response).')
  }
  // Spec MUST: the response's k1 is the bearer secret itself, never a
  // derived or opaque id. A SERVICE returning something else for the k1 it
  // was queried with is non-compliant - or the note was rotated by
  // somebody else, which matters even more.
  const queried = noteK1(url)
  if (queried && body.k1.toLowerCase() !== queried) {
    throw new ProtocolError(
      "The service echoed back a different k1 than was queried - the note may have been redeemed elsewhere, or the service isn't spec-compliant."
    )
  }
  return body as WithdrawRequestInfo
}

// After an AmbiguousMutationError: did the burn actually happen? Probes one
// of the input k1s with an informational GET.
//
//   'live'    still outstanding. The request never landed, so the fresh
//             secrets minted nothing and can be discarded.
//   'gone'    the SERVICE reports it spent or unknown. The burn landed, and
//             the carried secrets are the only money left.
//   'unknown' the probe itself failed. No information - keep everything.
export const probeBurnedNote = async (
  url: string,
  options: LnurlcashOptions = {}
): Promise<'live' | 'gone' | 'unknown'> => {
  try {
    await fetchNoteInfo(url, options)
    return 'live'
  } catch (err) {
    if (err instanceof NoteSpentError || err instanceof NoteUnknownError) {
      return 'gone'
    }
    return 'unknown'
  }
}

// ---- the mint address (experimental) ----

export type MintAddressInfo = {
  tag: 'withdrawRequest'
  callback: string
  minWithdrawable: number
  maxWithdrawable: number
  defaultDescription?: string
  // The wire field is `mintPubkey`, LUD-25's term for a note's signing key.
  // Renamed here because at THIS endpoint it is never a note's key, always
  // the SERVICE's own node identity - it sits alongside the other node
  // fields for that reason.
  nodePubkey?: string
  payLink: string
  nodeAlias?: string
  nodeUri?: string
  nodeColor?: string
  nodeCapacityMsat?: number
  nodeNumChannels?: number
  nodeNumPeers?: number
}

// Best-effort discovery only. This endpoint is experimental and carries no
// LUD number, so most SERVICEs - including ones this library otherwise
// works with perfectly - simply will not have it. Treat a rejection as "no
// extra information available" and fall back to fetchPayRequest, which is
// the only functional path to actually mint.
export const fetchMintAddress = async (
  url: string,
  options: LnurlcashOptions = {}
): Promise<MintAddressInfo> => {
  const body = await lnurlFetch(url, resolveOptions(options))
  if (
    body?.tag !== 'withdrawRequest' ||
    typeof body.callback !== 'string' ||
    typeof body.payLink !== 'string' ||
    typeof body.maxWithdrawable !== 'number'
  ) {
    throw new ProtocolError('Not a mint address response (unexpected shape).')
  }
  const {mintPubkey, ...rest} = body
  return {...rest, nodePubkey: mintPubkey} as MintAddressInfo
}

// ---- the mutating callback ----

export type WithdrawSuccessResponse = {
  status: 'OK'
  sig?: string
  sig2?: string
  // LUD-25 melt proof (optional): present only on a melt, and only where
  // the SERVICE advertises it
  pr?: string
  verify?: string
}

const callbackRequest = async (
  callback: string,
  params: [string, string][],
  options: LnurlcashOptions
): Promise<WithdrawSuccessResponse> => {
  const opts = resolveOptions(options)
  let cbUrl: URL
  try {
    cbUrl = new URL(callback)
  } catch {
    throw new RequestRefusedError('The service provided an invalid callback URL.')
  }
  // Nothing to operate on. Worth refusing here rather than letting it
  // become a callback with no k1, whose meaning is entirely up to the
  // SERVICE - and which, if a SERVICE chose to read it generously, could
  // burn something the caller never named.
  if (!params.some(([key]) => key === 'k1')) {
    throw new RequestRefusedError(
      'At least one k1 is required - there is no note to operate on.'
    )
  }
  // append, never set: a merge repeats the k1 parameter, and a callback may
  // already carry parameters of its own
  for (const [key, value] of params) cbUrl.searchParams.append(key, value)
  let body: any
  try {
    body = await lnurlFetch(cbUrl, opts)
  } catch (err) {
    if (err instanceof ServiceRejectedError) {
      // a k1 already mid-melt rejects every other callback naming it with
      // this exact reason string, verbatim per spec
      if (err.reason === 'pending') throw new PendingNoteError(err.reason)
      throw classifyNoteError(err.reason)
    }
    // an ambiguous transport failure must reach callers with its type
    // intact, never reclassified from its message text
    throw err
  }
  if (body?.status !== 'OK') {
    throw new AmbiguousMintError(
      'The service did not confirm the operation - it may still have been applied.'
    )
  }
  return body as WithdrawSuccessResponse
}

export type MeltResult = {
  // LUD-25 melt proof (optional): a LUD-21 style URL proving this exact
  // outgoing payment settled. Absent unless the SERVICE advertises it.
  verify?: string
  // the invoice being paid, echoed back alongside the proof, so a later
  // settled report can be bound to THIS melt rather than another payment
  pr?: string
}

// Melt: burn a single note, the SERVICE pays `pr` of exactly its value.
// Merge several notes first to melt them together - LUD-25 dropped
// multi-k1 melt.
//
// {"status":"OK"} here means the payment is now IN FLIGHT. It does not mean
// the note is spent. The SERVICE pays asynchronously and only finalises the
// burn once the payment settles, restoring the note to outstanding if it
// fails. A melt failure is therefore never reported through this call - it
// is only observable as the note becoming spendable again. Callers should
// treat this as "melt requested".
export const meltNote = async (
  callback: string,
  k1: string,
  pr: string,
  options: LnurlcashOptions = {}
): Promise<MeltResult> => {
  const body = await callbackRequest(
    callback,
    [
      ['k1', k1],
      ['pr', pr.trim()]
    ],
    options
  )
  return {
    verify: body.verify,
    pr: typeof body.pr === 'string' ? body.pr : undefined
  }
}

// ---- hash-parameterised primitives ----
//
// The mint call behind rotate, split and merge, taking a hash the caller
// already holds rather than generating one. This is what a hardware wallet
// drives: the device's own RNG produces the secret and the hash, and the
// secret never enters the calling process at all. The generating variants
// below are simply the software-wallet case of these.

export type HashedMutationResult = {signature?: string}

export const rotateNoteWithHash = async (
  callback: string,
  k1: string,
  h: string,
  options: LnurlcashOptions = {}
): Promise<HashedMutationResult> => {
  const body = await callbackRequest(
    callback,
    [
      ['k1', k1],
      ['h', h]
    ],
    options
  )
  return {signature: body.sig}
}

export type HashedSplitResult = {
  signature?: string
  changeSignature?: string
}

export const splitNoteWithHash = async (
  callback: string,
  k1s: string[],
  amountMsat: number,
  h: string,
  h2: string,
  options: LnurlcashOptions = {}
): Promise<HashedSplitResult> => {
  const body = await callbackRequest(
    callback,
    [
      ...k1s.map((k1): [string, string] => ['k1', k1]),
      ['amount', String(amountMsat)],
      ['h', h],
      ['h2', h2]
    ],
    options
  )
  return {signature: body.sig, changeSignature: body.sig2}
}

export const mergeNotesWithHash = async (
  callback: string,
  k1s: string[],
  h: string,
  options: LnurlcashOptions = {}
): Promise<HashedMutationResult> => {
  const body = await callbackRequest(
    callback,
    [...k1s.map((k1): [string, string] => ['k1', k1]), ['h', h]],
    options
  )
  return {signature: body.sig}
}

// ---- the generating primitives ----

export type RotateResult = {k1: string; signature?: string}

// Rotate: burn k1, receive a fresh secret of the same value. This closes
// the window in which any previous holder - or a logged URL, or a SERVICE
// that generated the original preimage - could still redeem the note. It is
// also how a caller obtains a compact, offline-verifiable copy of a note
// that does not have one yet, such as immediately after minting.
//
// Per LUD-25 the WALLET generates that fresh secret and discloses only its
// hash. The SERVICE never sees, generates or persists it, which is what
// closes the prior-holder exposure a SERVICE-generated replacement would
// otherwise reopen on every single rotate.
export const rotateNote = async (
  callback: string,
  k1: string,
  options: LnurlcashOptions = {}
): Promise<RotateResult> => {
  const opts = resolveOptions(options)
  const newK1 = opts.randomSecret()
  try {
    const result = await rotateNoteWithHash(callback, k1, hashK1(newK1), options)
    return {k1: newK1, signature: result.signature}
  } catch (err) {
    // the request may have landed - the fresh secret is then the only copy
    // of the rotated note, so it rides the error rather than vanishing
    if (err instanceof AmbiguousMintError) {
      throw new AmbiguousMutationError((err as Error).message, [newK1])
    }
    throw err
  }
}

export type SplitResult = {
  k1: string
  signature?: string
  change: string
  changeSignature?: string
}

// Split: burn one or many notes, mint one worth `amountMsat` and one
// carrying the remainder of their combined value. Both secrets are
// generated here and disclosed as h and h2. Splitting several notes at
// once needs no prior merge - they are all burned in the one request.
export const splitNote = async (
  callback: string,
  k1s: string[],
  amountMsat: number,
  options: LnurlcashOptions = {}
): Promise<SplitResult> => {
  const opts = resolveOptions(options)
  const newK1 = opts.randomSecret()
  const changeK1 = opts.randomSecret()
  try {
    const result = await splitNoteWithHash(
      callback,
      k1s,
      amountMsat,
      hashK1(newK1),
      hashK1(changeK1),
      options
    )
    return {
      k1: newK1,
      signature: result.signature,
      change: changeK1,
      changeSignature: result.changeSignature
    }
  } catch (err) {
    // both fresh secrets are the only copies of both outputs
    if (err instanceof AmbiguousMintError) {
      throw new AmbiguousMutationError((err as Error).message, [newK1, changeK1])
    }
    throw err
  }
}

// Merge: burn all given notes, mint one worth their sum.
export const mergeNotes = async (
  callback: string,
  k1s: string[],
  options: LnurlcashOptions = {}
): Promise<RotateResult> => {
  const opts = resolveOptions(options)
  const newK1 = opts.randomSecret()
  try {
    const result = await mergeNotesWithHash(callback, k1s, hashK1(newK1), options)
    return {k1: newK1, signature: result.signature}
  } catch (err) {
    if (err instanceof AmbiguousMintError) {
      throw new AmbiguousMutationError((err as Error).message, [newK1])
    }
    throw err
  }
}

export type SettledNote = {
  k1: string
  amountMsat: number
  signature?: string
  callback: string
}

// Resolves what a split's change note or a merge's output is ACTUALLY
// worth, then rotates it before further use.
//
// Neither response carries an amount - the spec's only source of truth for
// a note's value is an informational GET - and a SERVICE that charges fees
// may have deducted from a split's change or refunded into a merge's
// result. Using a naively computed pre-fee amount instead pairs a wrong
// `amount` with a signature the SERVICE issued for the true one, so the
// note looks unsigned even though it is not.
//
// That GET puts k1 on the wire in turn, so a rotate follows, best-effort: a
// SERVICE that cannot rotate keeps the exposed k1 and its original
// signature rather than failing the whole operation.
export const settleNote = async (
  baseUrl: string,
  k1: string,
  expectedAmountMsat: number,
  signature: string | undefined,
  options: LnurlcashOptions = {}
): Promise<SettledNote> => {
  const info = await fetchNoteInfo(
    withNewK1(baseUrl, k1, expectedAmountMsat, signature),
    options
  )
  try {
    const rotated = await rotateNote(info.callback, k1, options)
    return {
      k1: rotated.k1,
      amountMsat: info.maxWithdrawable,
      signature: rotated.signature,
      callback: info.callback
    }
  } catch {
    return {
      k1,
      amountMsat: info.maxWithdrawable,
      signature,
      callback: info.callback
    }
  }
}

// ---- minting via LUD-06 payRequest ----

export type PayRequestInfo = {
  tag: 'payRequest'
  callback: string
  minSendable: number
  maxSendable: number
  metadata: string
  // LUD-25: present when paying this mints a bearer note - the payment
  // preimage of the invoice becomes a valid k1 at this raw LUD-17 withdraw
  // endpoint
  withdrawLink?: string
  // Rarely present here in practice: a WALLET that pays the invoice can
  // recover the SERVICE's node id from its own BOLT-11 signature, so the
  // spec only has a SERVICE publish mintPubkey where there is no invoice to
  // recover it from. Nothing forbids including it anyway.
  mintPubkey?: string
  // parsed from metadata - absent means the SERVICE advertised none, which
  // the spec says to read as fee-free rather than unknown
  mintFee?: MintFee
}

export const fetchPayRequest = async (
  url: string,
  options: LnurlcashOptions = {}
): Promise<PayRequestInfo> => {
  const body = await lnurlFetch(url, resolveOptions(options))
  if (body?.tag !== 'payRequest' || typeof body.callback !== 'string') {
    throw new ProtocolError('Not a payRequest (unexpected response).')
  }
  const mintFee =
    typeof body.metadata === 'string' ? parseMintFee(body.metadata) : null
  return {...body, mintFee: mintFee ?? undefined} as PayRequestInfo
}

export type InvoiceResult = {
  pr: string
  // LUD-21 (optional): a URL to poll for this invoice's settlement
  verify?: string
  // LUD-11: false means the SERVICE wants the payRequest LNURL or Lightning
  // Address itself kept and reused - not this one invoice, which is spent
  // once paid regardless. Per spec, absent MUST be read as true, so only an
  // explicit false counts.
  disposable: boolean
}

export const requestInvoice = async (
  payCallback: string,
  amountMsat: number,
  options: LnurlcashOptions = {}
): Promise<InvoiceResult> => {
  const cbUrl = new URL(payCallback)
  cbUrl.searchParams.set('amount', String(amountMsat))
  const body = await lnurlFetch(cbUrl, resolveOptions(options))
  if (typeof body?.pr !== 'string') {
    throw new ProtocolError('The service did not return an invoice.')
  }
  // A SERVICE answering an amount request with an invoice for a DIFFERENT
  // amount is broken or hostile. An amountless invoice passes through:
  // there is nothing to check it against here, and the SERVICE judges it
  // later.
  const invoiceMsat = decodeBolt11AmountMsat(body.pr)
  if (invoiceMsat !== null && invoiceMsat !== amountMsat) {
    throw new ProtocolError(
      `The service returned an invoice for ${invoiceMsat} msat, not the ${amountMsat} requested.`
    )
  }
  return {
    pr: body.pr,
    verify: typeof body.verify === 'string' ? body.verify : undefined,
    disposable: body.disposable !== false
  }
}

export type VerifyResult = {
  settled: boolean
  preimage: string | null
  pr: string
}

// LUD-21: polls whether an invoice has settled, via the URL requestInvoice
// optionally returned.
//
// For LNURLcash specifically, a settled invoice's preimage IS the bearer
// note's spend secret. A verify GET proves nothing about who is asking -
// only that they know the payment hash embedded in the URL, which travels
// inside the invoice itself. Anyone who saw the unpaid invoice can poll
// this and take the note the moment it settles. A caller that receives a
// preimage here MUST rotate immediately, and must not treat verify as
// having closed that exposure.
export const fetchInvoiceVerification = async (
  verifyUrl: string,
  options: LnurlcashOptions = {}
): Promise<VerifyResult> => {
  const body = await lnurlFetch(verifyUrl, resolveOptions(options))
  if (typeof body?.settled !== 'boolean' || typeof body?.pr !== 'string') {
    throw new ProtocolError('The service returned an unexpected verify response.')
  }
  return {
    settled: body.settled,
    preimage: typeof body.preimage === 'string' ? body.preimage : null,
    pr: body.pr
  }
}
