// Payment requests: the encoding, and the validator that decides what
// counts as one. A request is a thing people copy, quote back and match
// against a record of what they asked for, so the encoding has to be
// canonical: two encodings of the same request must be the same string.

import {describe, expect, it} from 'vitest'
import {base64urlnopad} from '@scure/base'
import {
  decodePaymentRequest,
  encodePaymentRequest,
  isPaymentRequest,
  PAYMENT_REQUEST_PREFIX,
  paymentRequestAmountMsat,
  ProtocolError,
  type PaymentRequest
} from '../src/index.js'

const minimal: PaymentRequest = {
  v: 1,
  id: '0123456789abcdef',
  amount: '500',
  currency: 'sat',
  methodDetails: {mints: ['mint.example']}
}

const full: PaymentRequest = {
  ...minimal,
  // a real bech32 npub: the checksum is checked, not just the shape
  to: 'npub1qurswpc8qurswpc8qurswpc8qurswpc8qurswpc8qurswpc8qursnvjvl7',
  memo: 'lunch',
  expires: 1_756_000_000
}

const bodyOf = (encoded: string): string =>
  new TextDecoder().decode(
    base64urlnopad.decode(encoded.slice(PAYMENT_REQUEST_PREFIX.length))
  )

describe('encoding', () => {
  it('is the prefix plus base64url of canonical JSON', () => {
    const encoded = encodePaymentRequest(minimal)
    expect(encoded.startsWith('lnurlcashreq1')).toBe(true)
    expect(bodyOf(encoded)).toBe(
      '{"amount":"500","currency":"sat","id":"0123456789abcdef",' +
        '"methodDetails":{"mints":["mint.example"]},"v":1}'
    )
  })

  it('sorts keys, so the same request encodes to the same string', () => {
    const shuffled = {
      methodDetails: {mints: ['mint.example']},
      currency: 'sat',
      amount: '500',
      v: 1,
      id: '0123456789abcdef'
    } as PaymentRequest
    expect(encodePaymentRequest(shuffled)).toBe(encodePaymentRequest(minimal))
  })

  it('round-trips every field', () => {
    const encoded = encodePaymentRequest(full)
    expect(decodePaymentRequest(encoded, {now: 0})).toEqual(full)
    expect(encodePaymentRequest(decodePaymentRequest(encoded, {now: 0}))).toBe(
      encoded
    )
  })

  it('round-trips a memo that is not ASCII', () => {
    const request = {...minimal, memo: 'café ☕ 🍜'}
    expect(decodePaymentRequest(encodePaymentRequest(request))).toEqual(request)
  })

  it('drops nothing and adds nothing on a round trip through a wallet', () => {
    const withKeys: PaymentRequest = {
      ...minimal,
      methodDetails: {
        mints: ['mint.example', '127.0.0.1:8899'],
        mintPubkeys: [`02${'ab'.repeat(32)}`]
      }
    }
    expect(decodePaymentRequest(encodePaymentRequest(withKeys))).toEqual(withKeys)
  })

  it('is short enough for one static QR', () => {
    // alphanumeric-mode QR tops out well above this; the point is that a
    // request stays a scannable code rather than an animated one
    expect(encodePaymentRequest(full).length).toBeLessThan(300)
  })

  it('refuses to encode something that is not a valid request', () => {
    expect(() =>
      encodePaymentRequest({...minimal, amount: '0'} as PaymentRequest)
    ).toThrow(ProtocolError)
  })
})

describe('decoding', () => {
  it('accepts the prefix in any casing, since scanners rewrite it', () => {
    const encoded = encodePaymentRequest(minimal)
    const shouted =
      PAYMENT_REQUEST_PREFIX.toUpperCase() +
      encoded.slice(PAYMENT_REQUEST_PREFIX.length)
    expect(decodePaymentRequest(shouted)).toEqual(minimal)
    expect(decodePaymentRequest(`  ${encoded}  `)).toEqual(minimal)
  })

  const bad: Array<[string, string]> = [
    ['a bare LNURL', 'LNURL1DP68GURN8GHJ7'],
    ['the wrong prefix', `creqA${encodePaymentRequest(minimal).slice(13)}`],
    ['nothing at all', ''],
    ['a body that is not base64url', 'lnurlcashreq1!!!!!'],
    ['a body that is not JSON', `lnurlcashreq1${base64urlnopad.encode(
      new TextEncoder().encode('not json')
    )}`]
  ]

  for (const [name, input] of bad) {
    it(`refuses ${name}`, () => {
      expect(() => decodePaymentRequest(input)).toThrow(ProtocolError)
      expect(isPaymentRequest(input)).toBe(false)
    })
  }

  it('refuses a request far too long to be one', () => {
    expect(() =>
      decodePaymentRequest(PAYMENT_REQUEST_PREFIX + 'A'.repeat(5000))
    ).toThrow(ProtocolError)
  })

  const encodeRaw = (value: unknown): string =>
    PAYMENT_REQUEST_PREFIX +
    base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(value)))

  const invalid: Array<[string, unknown]> = [
    ['a version this library does not know', {...minimal, v: 2}],
    ['no id', {...minimal, id: undefined}],
    ['an id that is not 16 hex', {...minimal, id: 'nothexatall00000'}],
    ['an uppercase id', {...minimal, id: '0123456789ABCDEF'}],
    ['an amount that is a number', {...minimal, amount: 500}],
    ['an amount with a leading zero', {...minimal, amount: '0500'}],
    ['an amount of zero', {...minimal, amount: '0'}],
    ['a fractional amount', {...minimal, amount: '1.5'}],
    ['a negative amount', {...minimal, amount: '-5'}],
    ['a currency that is not sat', {...minimal, currency: 'msat'}],
    ['no methodDetails', {...minimal, methodDetails: undefined}],
    ['an empty mint list', {...minimal, methodDetails: {mints: []}}],
    ['a mint list that is not a list', {...minimal, methodDetails: {mints: 'mint.example'}}],
    ['a blank mint', {...minimal, methodDetails: {mints: ['  ']}}],
    [
      'mint keys that are not strings',
      {...minimal, methodDetails: {mints: ['mint.example'], mintPubkeys: [7]}}
    ],
    [
      'an unrecognised methodDetails field',
      {...minimal, methodDetails: {mints: ['mint.example'], swaps: true}}
    ],
    ['an unrecognised field', {...minimal, tip: '100'}],
    ['a destination that is neither an npub nor an address', {...minimal, to: 'me'}],
    [
      'a destination that looks like an npub but does not decode',
      {...minimal, to: `npub1${'q'.repeat(58)}`}
    ],
    ['a destination that is a bare domain', {...minimal, to: 'mint.example'}],
    ['a memo that is not a string', {...minimal, memo: 42}],
    ['a fractional expiry', {...minimal, expires: 1_756_000_000.5}],
    ['a negative expiry', {...minimal, expires: -1}],
    ['an array', [minimal]],
    ['a string', 'lunch'],
    ['null', null]
  ]

  for (const [name, value] of invalid) {
    it(`refuses ${name}`, () => {
      expect(() => decodePaymentRequest(encodeRaw(value), {now: 0})).toThrow(
        ProtocolError
      )
    })
  }

  it('accepts a Lightning Address as the destination', () => {
    const request = {...minimal, to: 'alice@mint.example'}
    expect(decodePaymentRequest(encodePaymentRequest(request))).toEqual(request)
  })
})

describe('expiry', () => {
  const expired = encodePaymentRequest({...full, expires: 1_600_000_000})

  it('refuses a request that has lapsed', () => {
    expect(() => decodePaymentRequest(expired)).toThrow(ProtocolError)
  })

  it('decodes one anyway when asked, so a wallet can say why it will not pay', () => {
    expect(decodePaymentRequest(expired, {now: 0}).expires).toBe(1_600_000_000)
  })

  it('still recognises an expired request as a payment request', () => {
    // "this request expired" is a far better answer than "unrecognised input"
    expect(isPaymentRequest(expired)).toBe(true)
  })

  it('treats an expiry of exactly now as lapsed', () => {
    const live = encodePaymentRequest({...full, expires: 1_756_000_000})
    // a payer whose clock is a moment behind the payee's would otherwise
    // send a note against a request the payee has already written off
    expect(() => decodePaymentRequest(live, {now: 1_756_000_000})).toThrow(
      ProtocolError
    )
  })

  it('accepts one that has not lapsed yet', () => {
    const live = encodePaymentRequest({...full, expires: 1_756_000_000})
    expect(decodePaymentRequest(live, {now: 1_755_999_999}).expires).toBe(
      1_756_000_000
    )
    // the second it lapses, it stops being payable
    expect(() => decodePaymentRequest(live, {now: 1_756_000_001})).toThrow(
      ProtocolError
    )
  })

  it('is not the same as a request with no expiry at all', () => {
    expect(decodePaymentRequest(encodePaymentRequest(minimal)).expires).toBeUndefined()
  })
})

describe('the amount', () => {
  it('is whole sats, and converts exactly to this library\'s usual unit', () => {
    expect(paymentRequestAmountMsat(minimal)).toBe(500_000)
    expect(paymentRequestAmountMsat({...minimal, amount: '1'})).toBe(1000)
    expect(paymentRequestAmountMsat({...minimal, amount: '21000000'})).toBe(
      21_000_000_000
    )
  })
})

// Before this format settled, an HTTP 402 rail emitted a shorter object
// under the same prefix. Two schemas under one prefix cannot both be right,
// and this one is the one the vectors pin, so the short form is read and
// never written.
describe('the short form a 402 rail once emitted', () => {
  const shortForm = (value: unknown): string =>
    PAYMENT_REQUEST_PREFIX +
    base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(value)))

  it('decodes it rather than refusing a string it can plainly read', () => {
    const request = decodePaymentRequest(
      shortForm({a: 21, m: ['mint.example.com'], u: 'sat'})
    )
    expect(request.amount).toBe('21')
    expect(request.currency).toBe('sat')
    expect(request.methodDetails.mints).toEqual(['mint.example.com'])
    expect(request.v).toBe(1)
    expect(paymentRequestAmountMsat(request)).toBe(21_000)
  })

  it('gives it a stable id derived from the challenge itself', () => {
    const encoded = shortForm({a: 21, m: ['mint.example.com'], u: 'sat'})
    const first = decodePaymentRequest(encoded).id
    expect(first).toMatch(/^[0-9a-f]{16}$/)
    // the same challenge always reads back as the same request
    expect(decodePaymentRequest(encoded).id).toBe(first)
    // a different one does not
    expect(
      decodePaymentRequest(shortForm({a: 22, m: ['mint.example.com'], u: 'sat'})).id
    ).not.toBe(first)
  })

  it('assumes sat when the unit is left out', () => {
    expect(
      decodePaymentRequest(shortForm({a: 500, m: ['mint.example']})).amount
    ).toBe('500')
  })

  it('never emits it', () => {
    const request = decodePaymentRequest(
      shortForm({a: 21, m: ['mint.example.com'], u: 'sat'})
    )
    const reencoded = encodePaymentRequest(request)
    expect(decodePaymentRequest(reencoded)).toEqual(request)
    // the long form, every time
    expect(bodyOf(reencoded)).toContain('"methodDetails"')
    expect(bodyOf(reencoded)).not.toContain('"m":')
  })

  it('still refuses a short form that is not one', () => {
    for (const value of [
      {a: '21', m: ['mint.example']},
      {a: 21, m: 'mint.example'},
      {a: 0, m: ['mint.example']},
      {a: 21, m: ['mint.example'], u: 'msat'},
      {a: 21, m: [], u: 'sat'},
      {a: 21}
    ]) {
      expect(() => decodePaymentRequest(shortForm(value))).toThrow(ProtocolError)
    }
  })
})
