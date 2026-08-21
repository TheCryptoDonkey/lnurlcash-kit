// Known-answer tests for the note derivation scheme.
//
// Every expected value here was computed with node:crypto's HMAC and
// PBKDF2, not with the library's own @noble primitives, so a mistake in one
// implementation cannot hide behind the same mistake in the other. The
// mnemonics are the standard BIP39 test vectors; the seeds are derived from
// them here rather than pasted in, so the whole chain from words to secret
// is visible in one file. The kit itself never sees a mnemonic - it takes
// seed bytes - and depends on no wordlist.

import {describe, expect, it} from 'vitest'
import {pbkdf2Sync} from 'node:crypto'
import {hexToBytes} from '@noble/hashes/utils.js'
import {
  deriveNoteRoot,
  deriveNoteSecret,
  derivedSecretSource,
  hashK1,
  isPreimage
} from '../src/index.js'

// BIP39: PBKDF2-HMAC-SHA512 over the NFKD mnemonic, salt "mnemonic" plus
// the passphrase (empty here), 2048 rounds, 64 bytes out.
const seedOf = (mnemonic: string): Uint8Array =>
  new Uint8Array(
    pbkdf2Sync(mnemonic.normalize('NFKD'), 'mnemonic', 2048, 64, 'sha512')
  )

const ABANDON = `${'abandon '.repeat(11)}about`
const LEGAL =
  'legal winner thank year wave sausage worth useful legal winner thank yellow'

describe('note derivation', () => {
  it('derives the documented seed from the standard mnemonic', () => {
    expect(Buffer.from(seedOf(ABANDON)).toString('hex')).toBe(
      '5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc1' +
        '9a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4'
    )
  })

  it('derives the root from the seed', () => {
    expect(Buffer.from(deriveNoteRoot(seedOf(ABANDON))).toString('hex')).toBe(
      '948f8f49347549cf2726e8b53f673a4185379344d2d7ba8877d3ded45d34d127'
    )
    expect(Buffer.from(deriveNoteRoot(seedOf(LEGAL))).toString('hex')).toBe(
      '73852fd013b85de34c02e7f500e8fec0c23ebab547fb77f3049bfb00716cc956'
    )
  })

  const cases: Array<[string, string, number, string]> = [
    [
      ABANDON,
      'mint.example',
      0,
      '1f6016c80339b45dfdd1b3877c1a97d74b063cad54c4ccb866be39ed25ee2ab0'
    ],
    [
      ABANDON,
      'mint.example',
      1,
      '6ae92498a3e68865b49e49a483622c3ac0459ca00b0acf6696ab2b8c555c6d3c'
    ],
    [
      ABANDON,
      'mint.example',
      2,
      'b712e9adfb0aadd6718516df2cabdf17ed3367a1945ddaca59d82c7beadd14de'
    ],
    [
      ABANDON,
      'mint.example',
      19,
      'c9dfb7f0c5cf30917685813d664dad1978445ff1a3fd77065316ac884955ea74'
    ],
    [
      ABANDON,
      'mint.example',
      20,
      '4b52d280d8d3b2c8508c4222a111b6d4ee95c2aed5b1271bb66a25b6f71d288e'
    ],
    // a host carrying a port is a different host, exactly as serverOf spells it
    [
      ABANDON,
      '127.0.0.1:8899',
      0,
      '489cf7b0b427ddcd084cfb81290e8a575a5b831d13d42ee061f3e612d85acc29'
    ],
    [
      ABANDON,
      '127.0.0.1:8899',
      20,
      '7322a4427d39956a46b068f340d6bc4feded4bea86668d6ae873ba44d00e89c6'
    ],
    [
      LEGAL,
      'mint.example',
      0,
      'f193488e16f4121fb56f310492b2be7cfce636474642f17517c972ae448c866a'
    ]
  ]

  for (const [mnemonic, host, index, expected] of cases) {
    it(`derives ${host}:${index} from "${mnemonic.split(' ')[0]}..."`, () => {
      const k1 = deriveNoteSecret(deriveNoteRoot(seedOf(mnemonic)), host, index)
      expect(k1).toBe(expected)
      // a derived secret is indistinguishable from a random one on the wire
      expect(isPreimage(k1)).toBe(true)
      expect(hashK1(k1)).toHaveLength(64)
    })
  }

  it('separates hosts and seeds', () => {
    const root = deriveNoteRoot(seedOf(ABANDON))
    expect(deriveNoteSecret(root, 'mint.example', 0)).not.toBe(
      deriveNoteSecret(root, 'mint.example:443', 0)
    )
    expect(deriveNoteSecret(root, 'mint.example', 0)).not.toBe(
      deriveNoteSecret(deriveNoteRoot(seedOf(LEGAL)), 'mint.example', 0)
    )
  })

  it('refuses an index that is not a non-negative integer', () => {
    const root = deriveNoteRoot(seedOf(ABANDON))
    expect(() => deriveNoteSecret(root, 'mint.example', -1)).toThrow(RangeError)
    expect(() => deriveNoteSecret(root, 'mint.example', 1.5)).toThrow(RangeError)
    expect(() => deriveNoteSecret(root, 'mint.example', NaN)).toThrow(RangeError)
  })

  it('accepts any seed length - the kit is not tied to BIP39', () => {
    expect(deriveNoteRoot(hexToBytes('00'.repeat(32)))).toHaveLength(32)
    expect(deriveNoteRoot(new Uint8Array(0))).toHaveLength(32)
  })
})

describe('derivedSecretSource', () => {
  const root = deriveNoteRoot(seedOf(ABANDON))

  it('walks the indices in order and reports the next unused one', () => {
    const source = derivedSecretSource(root, 'mint.example', 0)
    expect(source.index()).toBe(0)
    expect(source()).toBe(deriveNoteSecret(root, 'mint.example', 0))
    expect(source.index()).toBe(1)
    expect(source()).toBe(deriveNoteSecret(root, 'mint.example', 1))
    // a split draws twice from the one source
    expect(source()).toBe(deriveNoteSecret(root, 'mint.example', 2))
    expect(source.index()).toBe(3)
  })

  it('resumes from a persisted counter', () => {
    const source = derivedSecretSource(root, 'mint.example', 19)
    expect(source()).toBe(
      'c9dfb7f0c5cf30917685813d664dad1978445ff1a3fd77065316ac884955ea74'
    )
    expect(source.index()).toBe(20)
  })

  it('is a RandomSecret, so it drops straight into the client options', () => {
    const source = derivedSecretSource(root, 'mint.example', 0)
    const asRandomSecret: () => string = source
    expect(isPreimage(asRandomSecret())).toBe(true)
  })

  it('refuses a starting index that is not a non-negative integer', () => {
    expect(() => derivedSecretSource(root, 'mint.example', -1)).toThrow(
      RangeError
    )
  })
})
