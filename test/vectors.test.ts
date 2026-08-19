// Every assertion here comes from lnurlcash-conformance. Nothing in this
// file states what the protocol is - the vectors do, and this suite only
// binds them to the library's functions. A disagreement means one of the
// two is wrong, which is the entire point of keeping them separate.

import {describe, expect, it} from 'vitest'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {
  applyMintFee,
  decodeBolt11AmountMsat,
  formatFeePercent,
  fromBech32Lnurl,
  grossUpForMintFee,
  isAllowedServiceUrl,
  isBolt11Invoice,
  isPreimage,
  buildNoteUrl,
  lightningAddressUsername,
  mintAddressUrl,
  noteDeclaredAmount,
  noteK1,
  noteSignature,
  noteSignatureDigest,
  noteSignatureMessage,
  parseMintFee,
  resolveLnurlInput,
  resolveMintInput,
  resolveNoteInput,
  sameInvoice,
  toBech32Lnurl,
  verifyNoteSignature,
  withNewK1,
  withoutK1
} from '../src/index.js'
import {bytesToHex} from '@noble/hashes/utils.js'

const require = createRequire(import.meta.url)
const load = (name: string): any =>
  JSON.parse(
    readFileSync(require.resolve(`lnurlcash-conformance/vectors/${name}`), 'utf8')
  )

describe('signature vectors', () => {
  const vectors = load('signature.json')

  it('has cases to run', () => {
    expect(vectors.cases.length).toBeGreaterThan(5)
  })

  for (const c of vectors.cases) {
    it(`${c.valid ? 'accepts' : 'rejects'}: ${c.name}`, () => {
      expect(
        verifyNoteSignature(c.k1, c.amountMsat, c.signature, c.mintPubkey)
      ).toBe(c.valid)
    })
  }

  for (const c of vectors.cases.filter((c: any) => c.message !== null)) {
    it(`derives the signed message and digest for: ${c.name}`, () => {
      expect(noteSignatureMessage(c.k1, c.amountMsat)).toBe(c.message)
      expect(bytesToHex(noteSignatureDigest(c.k1, c.amountMsat))).toBe(c.digest)
    })
  }

  it('rejects a signature from the right key over the wrong note', () => {
    const valid = vectors.cases.find((c: any) => c.valid)
    expect(
      verifyNoteSignature(
        'c'.repeat(64),
        valid.amountMsat,
        valid.signature,
        valid.mintPubkey
      )
    ).toBe(false)
  })
})

describe('bech32 vectors', () => {
  const vectors = load('bech32.json')

  for (const c of vectors.encode) {
    it(`round-trips ${c.url.slice(0, 48)}`, () => {
      expect(toBech32Lnurl(c.url)).toBe(c.lnurl)
      expect(fromBech32Lnurl(c.lnurl)).toBe(c.url)
    })
  }

  for (const c of vectors.decodeInvalid) {
    it(`refuses to decode (${c.why})`, () => {
      expect(fromBech32Lnurl(c.input)).toBeNull()
    })
  }

  it('decodes either casing to the same URL', () => {
    const {lower, upper, url} = vectors.caseInsensitive
    expect(fromBech32Lnurl(lower)).toBe(url)
    expect(fromBech32Lnurl(upper)).toBe(url)
  })
})

describe('url admission vectors', () => {
  const vectors = load('url-admission.json')

  for (const url of vectors.allowed) {
    it(`allows ${url}`, () => {
      expect(isAllowedServiceUrl(url)).toBe(true)
    })
  }

  for (const c of vectors.rejected) {
    it(`rejects ${c.url || '(empty)'} - ${c.why}`, () => {
      expect(isAllowedServiceUrl(c.url)).toBe(false)
    })
  }
})

describe('input resolution vectors', () => {
  const vectors = load('input-resolution.json')

  for (const c of vectors.lnurl) {
    it(`resolves lnurl input ${JSON.stringify(c.input).slice(0, 56)}`, () => {
      expect(resolveLnurlInput(c.input)).toBe(c.expect)
    })
  }

  for (const c of vectors.mint) {
    it(`resolves mint input ${JSON.stringify(c.input).slice(0, 56)}`, () => {
      expect(resolveMintInput(c.input)).toBe(c.expect)
    })
  }

  for (const c of vectors.note) {
    it(`resolves note input ${JSON.stringify(c.input).slice(0, 56)}`, () => {
      expect(resolveNoteInput(c.input)).toBe(c.expect)
    })
  }

  for (const c of vectors.mintAddressUrl) {
    it(`mirrors ${c.payUrl} to the withdraw side`, () => {
      expect(mintAddressUrl(c.payUrl)).toBe(c.expect)
    })
  }

  for (const c of vectors.lightningAddressUsername) {
    it(`extracts the username from ${c.payUrl}`, () => {
      expect(lightningAddressUsername(c.payUrl)).toBe(c.expect)
    })
  }
})

describe('note url vectors', () => {
  const vectors = load('note-url.json')

  for (const c of vectors.parse) {
    it(`parses ${c.url.slice(0, 56)}`, () => {
      expect(noteK1(c.url)).toBe(c.k1)
      expect(noteDeclaredAmount(c.url)).toBe(c.declaredAmountMsat)
      expect(noteSignature(c.url)).toBe(c.signature)
    })
  }

  for (const c of vectors.build) {
    it(`builds a note on ${c.withdrawLink}`, () => {
      expect(
        c.amountMsat === null
          ? buildNoteUrl(c.withdrawLink, c.k1)
          : buildNoteUrl(c.withdrawLink, c.k1, c.amountMsat)
      ).toBe(c.expect)
    })
  }

  for (const c of vectors.withNewK1) {
    it('swaps in a new secret', () => {
      expect(withNewK1(c.url, c.k1, c.amountMsat, c.signature ?? undefined)).toBe(
        c.expect
      )
    })
  }

  for (const c of vectors.withoutK1) {
    it('blanks the secret for a device-held note', () => {
      expect(withoutK1(c.url, c.amountMsat, c.signature ?? undefined)).toBe(
        c.expect
      )
    })
  }
})

describe('fee vectors', () => {
  const vectors = load('fees.json')

  for (const c of vectors.parse) {
    it(`parses metadata ${c.metadata.slice(0, 56)}`, () => {
      expect(parseMintFee(c.metadata)).toEqual(c.expect)
    })
  }

  for (const c of vectors.apply) {
    it(`applies ${JSON.stringify(c.fee)} to ${c.grossMsat}`, () => {
      expect(applyMintFee(c.grossMsat, c.fee)).toBe(c.expect)
    })
  }

  for (const c of vectors.grossUp) {
    it(`grosses ${c.netMsat} up through ${JSON.stringify(c.fee)}`, () => {
      expect(grossUpForMintFee(c.netMsat, c.fee)).toBe(c.expect)
    })
  }

  it('grosses up to the exact minimum, for every fee and amount', () => {
    const {fees, netAmountsMsat} = vectors.grossUpRoundTrip
    for (const fee of fees) {
      for (const net of netAmountsMsat) {
        const gross = grossUpForMintFee(net, fee)
        expect(applyMintFee(gross, fee)).toBe(net)
        expect(applyMintFee(gross - 1, fee)).toBeLessThan(net)
      }
    }
  })

  for (const c of vectors.formatPercent) {
    it(`formats ${c.ppm} ppm`, () => {
      expect(formatFeePercent(c.ppm)).toBe(c.expect)
    })
  }
})

describe('bolt11 vectors', () => {
  const vectors = load('bolt11.json')

  for (const c of vectors.decodeAmountMsat) {
    it(`decodes the amount from ${c.pr || '(empty)'}`, () => {
      expect(decodeBolt11AmountMsat(c.pr)).toBe(c.expect)
    })
  }

  for (const c of vectors.isInvoice) {
    it(`${c.expect ? 'recognises' : 'rejects'} ${c.pr || '(empty)'}`, () => {
      expect(isBolt11Invoice(c.pr)).toBe(c.expect)
    })
  }

  for (const c of vectors.sameInvoice) {
    it(`compares ${c.a} with ${c.b}`, () => {
      expect(sameInvoice(c.a, c.b)).toBe(c.expect)
    })
  }

  for (const c of vectors.isPreimage) {
    it(`${c.expect ? 'accepts' : 'rejects'} preimage ${c.value.slice(0, 12) || '(empty)'}`, () => {
      expect(isPreimage(c.value)).toBe(c.expect)
    })
  }
})
