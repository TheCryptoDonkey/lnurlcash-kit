import {base64urlnopad, bech32} from '@scure/base'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, utf8ToBytes} from '@noble/hashes/utils.js'
import {ProtocolError} from './errors.js'
import {isLightningAddress} from './urls.js'

// ---- payment requests ----
//
// "Send me 500 sat" today means handing over a Lightning Address, which is a
// mint-and-zap round trip through the mint's node for something neither
// party needed a node for. A payment request names the amount, the mints the
// payee will accept and where to deliver, and the payer's wallet splits a
// note and sends it straight across. Wallet to wallet; the mint only ever
// sees a split.
//
// The object is the same charge request an HTTP 402 lnurlcash rail serves,
// plus the transport fields a wallet-to-wallet send needs, so one encoder
// covers both:
//
//   {"v": 1, "id": "<16 hex>", "amount": "500", "currency": "sat",
//    "methodDetails": {"mints": ["mint.example"]},
//    "to": "npub1..." | "name@domain", "memo": "lunch",
//    "expires": 1756000000}
//
// Encoded as `lnurlcashreq1` followed by base64url of the JCS-canonical
// JSON, which is the NUT-18 `creqA` idiom with our own prefix. Canonical
// because a request is a thing people copy, quote back and match against a
// record of what they asked for: two encodings of the same request must be
// the same string, or none of that works.
//
// Amounts here are SAT, in decimal ASCII, and they are the one exception to
// this library's msat-everywhere rule. That is deliberate: the field is
// shared with the 402 rail and the Cashu payment method, both of which count
// in whole units, and inventing a second spelling would be worse than the
// exception. Use paymentRequestAmountMsat rather than multiplying by hand.

export const PAYMENT_REQUEST_PREFIX = 'lnurlcashreq1'

export type PaymentRequestMethodDetails = {
  // Mint hosts the payee will accept a note from. At least one, and a payer
  // holding notes at none of them cannot pay this request without moving
  // funds first.
  mints: string[]
  // Optional: the signing keys those mints publish, so a payer can check a
  // note's issuer offline before sending it on.
  mintPubkeys?: string[]
}

export type PaymentRequest = {
  v: 1
  // 16 hex characters. The payee matches an incoming note back to the
  // request it settles, so this needs to be unguessable enough that a third
  // party cannot claim someone else's request was paid: 8 random bytes.
  id: string
  // Whole sats, decimal ASCII, no leading zeros. A wallet pays exactly this
  // times 1000 msat. Sub-sat requests are not a thing.
  amount: string
  currency: 'sat'
  methodDetails: PaymentRequestMethodDetails
  // Where to deliver: a Nostr npub, or a Lightning Address shaped string.
  // Absent on a charge request served over HTTP, where the response itself
  // is the transport.
  to?: string
  memo?: string
  // Unix seconds. A request past this must not be paid.
  expires?: number
}

// A hostile or accidental blob is refused before it is decoded, let alone
// parsed. A real request is a couple of hundred characters; this is roomy.
const MAX_ENCODED_LENGTH = 4096

const AMOUNT_RE = /^(?:0|[1-9][0-9]*)$/
const ID_RE = /^[0-9a-f]{16}$/
const NPUB_RE = /^npub1[023456789acdefghjklmnpqrstuvwxyz]{58}$/

// Shape is not enough: a request naming a destination that no relay can
// route to is a request nobody can pay, and a mistyped npub passes any
// regex. bech32 carries a checksum, so decode it - the same decoder this
// library already uses for LNURLs, no Nostr dependency needed.
const isNpub = (value: string): boolean => {
  if (!NPUB_RE.test(value)) return false
  try {
    const {prefix, words} = bech32.decode(value as `${string}1${string}`)
    return prefix === 'npub' && bech32.fromWords(words).length === 32
  } catch {
    return false
  }
}

const reject = (why: string): never => {
  throw new ProtocolError(`Not a valid payment request: ${why}`)
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// RFC 8785 JSON Canonicalization Scheme, over the value space a payment
// request occupies: objects, arrays, strings and safe integers. Keys sort by
// UTF-16 code unit, which is what JavaScript's own string comparison does,
// and there is no whitespace anywhere. No floats: a non-integer number would
// need JCS's full ECMAScript number serialisation, and nothing here has any
// business being fractional.
const canonicalise = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`
  if (isPlainObject(value)) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined)
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    const body = entries
      .map(([key, v]) => `${JSON.stringify(key)}:${canonicalise(v)}`)
      .join(',')
    return `{${body}}`
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) reject('a number that is not a safe integer')
    return String(value)
  }
  if (typeof value === 'string' || typeof value === 'boolean' || value === null) {
    return JSON.stringify(value)
  }
  return reject(`a value of type ${typeof value}`)
}

const validate = (value: unknown): PaymentRequest => {
  if (!isPlainObject(value)) reject('not an object')
  const raw = value as Record<string, unknown>
  const known = new Set([
    'v',
    'id',
    'amount',
    'currency',
    'methodDetails',
    'to',
    'memo',
    'expires'
  ])
  // Strict, matching the 402 charge-request schema this shares its shape
  // with. A field this version does not know is a field it cannot honour,
  // and quietly paying a request one did not fully understand is how a payer
  // pays the wrong person.
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) reject(`unrecognised field "${key}"`)
  }
  if (raw.v !== 1) reject('unsupported version')
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) {
    reject('id must be 16 lowercase hex characters')
  }
  if (typeof raw.amount !== 'string' || !AMOUNT_RE.test(raw.amount)) {
    reject('amount must be a whole number of sats, as a decimal string')
  }
  const sats = Number(raw.amount)
  if (!Number.isSafeInteger(sats) || sats < 1) {
    reject('amount must be at least 1 sat')
  }
  if (raw.currency !== 'sat') reject('currency must be "sat"')
  if (!isPlainObject(raw.methodDetails)) reject('methodDetails must be an object')
  const details = raw.methodDetails as Record<string, unknown>
  for (const key of Object.keys(details)) {
    if (key !== 'mints' && key !== 'mintPubkeys') {
      reject(`unrecognised methodDetails field "${key}"`)
    }
  }
  if (
    !Array.isArray(details.mints) ||
    details.mints.length === 0 ||
    !details.mints.every(mint => typeof mint === 'string' && mint.trim() !== '')
  ) {
    reject('methodDetails.mints must list at least one mint')
  }
  if (
    details.mintPubkeys !== undefined &&
    (!Array.isArray(details.mintPubkeys) ||
      !details.mintPubkeys.every(key => typeof key === 'string'))
  ) {
    reject('methodDetails.mintPubkeys must be a list of strings')
  }
  if (raw.to !== undefined) {
    if (typeof raw.to !== 'string') reject('to must be a string')
    const to = raw.to as string
    if (!isNpub(to) && !isLightningAddress(to)) {
      reject('to must be an npub or a Lightning Address')
    }
  }
  if (raw.memo !== undefined && typeof raw.memo !== 'string') {
    reject('memo must be a string')
  }
  if (
    raw.expires !== undefined &&
    (typeof raw.expires !== 'number' ||
      !Number.isSafeInteger(raw.expires) ||
      raw.expires < 0)
  ) {
    reject('expires must be a unix timestamp in whole seconds')
  }
  const request: PaymentRequest = {
    v: 1,
    id: raw.id as string,
    amount: raw.amount as string,
    currency: 'sat',
    methodDetails: {
      mints: [...(details.mints as string[])],
      ...(details.mintPubkeys === undefined
        ? {}
        : {mintPubkeys: [...(details.mintPubkeys as string[])]})
    },
    ...(raw.to === undefined ? {} : {to: raw.to as string}),
    ...(raw.memo === undefined ? {} : {memo: raw.memo as string}),
    ...(raw.expires === undefined ? {} : {expires: raw.expires as number})
  }
  return request
}

// What the payer owes, in this library's usual unit. Whole sats times 1000,
// exactly - never a rounded conversion, because there is nothing to round.
export const paymentRequestAmountMsat = (request: PaymentRequest): number =>
  Number(request.amount) * 1000

// ---- compatibility: the short form ----
//
// Before this format settled, an HTTP 402 rail emitted a shorter object
// under the same prefix: {"a": 21, "m": ["mint.example"], "u": "sat"} -
// amount as a NUMBER of sats, no version, no id. Two schemas under one
// prefix cannot both be right, and this one is the one the vectors pin, so
// nothing here ever EMITS the short form. It is read, though, because a
// decoder that returns nothing on a string it can plainly understand helps
// no one.
//
// A short-form challenge carries no id, and a PaymentRequest needs one, so
// it gets a deterministic one derived from its own canonical bytes: the
// same challenge always yields the same id, and nothing has to invent
// randomness while parsing.
const SHORT_FORM_KEYS = new Set(['a', 'm', 'u'])

const fromShortForm = (value: unknown): unknown => {
  if (!isPlainObject(value)) return value
  const raw = value as Record<string, unknown>
  if (raw.v !== undefined || raw.amount !== undefined) return value
  const keys = Object.keys(raw)
  if (keys.length === 0 || !keys.every(key => SHORT_FORM_KEYS.has(key))) {
    return value
  }
  if (typeof raw.a !== 'number' || !Number.isSafeInteger(raw.a)) return value
  if (!Array.isArray(raw.m)) return value
  const canonical = canonicalise(raw)
  return {
    v: 1,
    id: bytesToHex(sha256(utf8ToBytes(canonical))).slice(0, 16),
    amount: String(raw.a),
    currency: raw.u === undefined ? 'sat' : raw.u,
    methodDetails: {mints: raw.m}
  }
}

// Validates and encodes. Does not check the expiry: re-encoding a request
// that has already lapsed is a legitimate thing to do, and refusing to
// create one is not this function's judgement to make.
export const encodePaymentRequest = (request: PaymentRequest): string =>
  PAYMENT_REQUEST_PREFIX +
  base64urlnopad.encode(new TextEncoder().encode(canonicalise(validate(request))))

export type DecodeOptions = {
  // Unix seconds to judge `expires` against. Defaults to the clock. Pass 0
  // to decode without an expiry check, which is how a wallet shows a user
  // the request it is refusing to pay and why.
  now?: number
}

// Decodes, validates and refuses an expired request. Throws ProtocolError,
// never returns a partial object: half a payment request is worse than none.
export const decodePaymentRequest = (
  value: string,
  {now = Math.floor(Date.now() / 1000)}: DecodeOptions = {}
): PaymentRequest => {
  const trimmed = value.trim()
  if (trimmed.length > MAX_ENCODED_LENGTH) reject('far too long to be one')
  if (trimmed.slice(0, PAYMENT_REQUEST_PREFIX.length).toLowerCase() !==
      PAYMENT_REQUEST_PREFIX) {
    reject(`it does not start with ${PAYMENT_REQUEST_PREFIX}`)
  }
  let json: string
  try {
    json = new TextDecoder().decode(
      base64urlnopad.decode(trimmed.slice(PAYMENT_REQUEST_PREFIX.length))
    )
  } catch {
    return reject('the body is not base64url')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return reject('the body is not JSON')
  }
  const request = validate(fromShortForm(parsed))
  // At the expiry, not merely past it: a request that lapses this second has
  // lapsed. A payer whose clock is a moment behind the payee's would
  // otherwise send a note against a request the payee has already written
  // off, which is money in transit with nothing waiting for it.
  if (request.expires !== undefined && now > 0 && request.expires <= now) {
    reject('it expired')
  }
  return request
}

// For a scanner deciding what it is looking at. Deliberately ignores the
// expiry: an expired request IS a payment request, and telling the user it
// lapsed is a far better answer than "unrecognised input".
export const isPaymentRequest = (value: string): boolean => {
  try {
    decodePaymentRequest(value, {now: 0})
    return true
  } catch {
    return false
  }
}
