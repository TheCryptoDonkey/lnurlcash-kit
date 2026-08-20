// Everything here runs against the conformance repo's mock mint - a real
// HTTP server that can be told to misbehave. The happy paths matter, but
// the adversarial modes are the reason this suite exists: a library that
// only works against a well-behaved SERVICE has not been tested at all.

import {afterEach, describe, expect, it} from 'vitest'
import {createMockMint} from 'lnurlcash-conformance/mock-mint'
import {bytesToHex} from '@noble/hashes/utils.js'
import {sha256} from '@noble/hashes/sha2.js'
import {hexToBytes} from '@noble/hashes/utils.js'
import {
  AmbiguousMintError,
  AmbiguousMutationError,
  NoteSpentError,
  NoteUnknownError,
  PendingNoteError,
  ProtocolError,
  RequestRefusedError,
  ServiceRejectedError,
  buildNoteUrl,
  fetchInvoiceVerification,
  fetchMintAddress,
  fetchNoteInfo,
  fetchPayRequest,
  hashK1,
  meltNote,
  mergeNotes,
  probeBurnedNote,
  requestInvoice,
  rotateNote,
  settleNote,
  splitNote,
  verifyNoteSignature
} from '../src/index.js'

type Mint = Awaited<ReturnType<typeof createMockMint>>

const mints: Mint[] = []
const mint = async (options: Record<string, unknown> = {}): Promise<Mint> => {
  const m = await createMockMint(options)
  mints.push(m)
  return m
}

afterEach(async () => {
  await Promise.all(mints.splice(0).map(m => m.close()))
})

const secret = (seed: string) => bytesToHex(sha256(hexToBytes('00'.repeat(31) + seed)))
const noteUrl = (m: Mint, k1: string, amountMsat?: number) =>
  buildNoteUrl(`${m.url}/w`, k1, amountMsat)

describe('the informational GET', () => {
  it('reports what a note is worth, and never burns it', async () => {
    const m = await mint()
    const k1 = secret('01')
    m.state.creditNote(k1, 21000)

    const info = await fetchNoteInfo(noteUrl(m, k1))
    expect(info.maxWithdrawable).toBe(21000)
    expect(info.k1).toBe(k1)
    expect(m.state.noteState(k1)).toBe('outstanding')

    // and again - an informational GET is idempotent
    expect((await fetchNoteInfo(noteUrl(m, k1))).maxWithdrawable).toBe(21000)
  })

  it('treats maxWithdrawable as authoritative over the URL\'s own claim', async () => {
    const m = await mint()
    const k1 = secret('02')
    m.state.creditNote(k1, 21000)
    // the note URL claims a hundred times its real value
    const info = await fetchNoteInfo(noteUrl(m, k1, 2_100_000))
    expect(info.maxWithdrawable).toBe(21000)
  })

  it('does not send the signature back to the service', async () => {
    const m = await mint()
    const k1 = secret('03')
    m.state.creditNote(k1, 21000)
    const seen: string[] = []
    const spyFetch: typeof fetch = (input, init) => {
      seen.push(input.toString())
      return fetch(input as string, init)
    }
    await fetchNoteInfo(`${noteUrl(m, k1, 21000)}&sig=${'ab'.repeat(65)}`, {
      fetch: spyFetch
    })
    expect(seen[0]).not.toContain('sig=')
    expect(seen[0]).toContain(`k1=${k1}`)
  })

  it('refuses a service that echoes back a different k1', async () => {
    const m = await mint({echoWrongK1: true})
    const k1 = secret('04')
    m.state.creditNote(k1, 21000)
    await expect(fetchNoteInfo(noteUrl(m, k1))).rejects.toBeInstanceOf(ProtocolError)
  })

  it('distinguishes an unknown note from a spent one', async () => {
    const m = await mint()
    const known = secret('05')
    m.state.creditNote(known, 21000)
    await expect(fetchNoteInfo(noteUrl(m, secret('06')))).rejects.toBeInstanceOf(
      NoteUnknownError
    )

    const info = await fetchNoteInfo(noteUrl(m, known))
    await rotateNote(info.callback, known)
    await expect(fetchNoteInfo(noteUrl(m, known))).rejects.toBeInstanceOf(
      NoteSpentError
    )
  })
})

describe('rotate', () => {
  it('burns the old secret and mints a new one the service never saw', async () => {
    const m = await mint()
    const k1 = secret('10')
    m.state.creditNote(k1, 21000)
    const info = await fetchNoteInfo(noteUrl(m, k1))

    const rotated = await rotateNote(info.callback, k1)
    expect(rotated.k1).not.toBe(k1)
    expect(m.state.noteState(k1)).toBe('burned')
    // the service stored the new note under the hash it was given, and
    // cannot have learned the secret behind it
    expect(m.state.noteState(rotated.k1)).toBe('outstanding')
    expect(m.state.notes.has(hashK1(rotated.k1))).toBe(true)

    const after = await fetchNoteInfo(noteUrl(m, rotated.k1))
    expect(after.maxWithdrawable).toBe(21000)
  })

  it('verifies the signature the service issues for the new note', async () => {
    const m = await mint()
    const k1 = secret('11')
    m.state.creditNote(k1, 21000)
    const info = await fetchNoteInfo(noteUrl(m, k1))
    const rotated = await rotateNote(info.callback, k1)

    expect(rotated.signature).toBeTruthy()
    expect(
      verifyNoteSignature(rotated.k1, 21000, rotated.signature!, m.state.pubkey)
    ).toBe(true)
    // and does not verify for a value the mint never signed
    expect(
      verifyNoteSignature(rotated.k1, 21001, rotated.signature!, m.state.pubkey)
    ).toBe(false)
  })

  it('verifies a signature whose recovery id is at the other end', async () => {
    const m = await mint({signatureLayout: 'leading'})
    const k1 = secret('12')
    m.state.creditNote(k1, 21000)
    const info = await fetchNoteInfo(noteUrl(m, k1))
    const rotated = await rotateNote(info.callback, k1)
    expect(
      verifyNoteSignature(rotated.k1, 21000, rotated.signature!, m.state.pubkey)
    ).toBe(true)
  })

  it('works against a service that issues no signatures at all', async () => {
    const m = await mint({signatures: false})
    const k1 = secret('13')
    m.state.creditNote(k1, 21000)
    const info = await fetchNoteInfo(noteUrl(m, k1))
    const rotated = await rotateNote(info.callback, k1)
    expect(rotated.signature).toBeUndefined()
    expect(m.state.noteState(rotated.k1)).toBe('outstanding')
  })

  it('ignores a secret a non-compliant service tries to hand back', async () => {
    const m = await mint({serverGeneratedSecrets: true})
    const k1 = secret('14')
    m.state.creditNote(k1, 21000)
    const info = await fetchNoteInfo(noteUrl(m, k1))
    const rotated = await rotateNote(info.callback, k1)
    // the mint offered 'aaaa...' as the new secret. Taking it would hand
    // the mint a permanent copy of the note it just issued.
    expect(rotated.k1).not.toBe('a'.repeat(64))
    expect(m.state.notes.has(hashK1(rotated.k1))).toBe(true)
  })
})

describe('split and merge', () => {
  it('splits a note into an amount and its change', async () => {
    const m = await mint()
    const k1 = secret('20')
    m.state.creditNote(k1, 21000)
    const info = await fetchNoteInfo(noteUrl(m, k1))

    const result = await splitNote(info.callback, [k1], 5000)
    expect(m.state.noteState(k1)).toBe('burned')
    expect((await fetchNoteInfo(noteUrl(m, result.k1))).maxWithdrawable).toBe(5000)
    expect((await fetchNoteInfo(noteUrl(m, result.change))).maxWithdrawable).toBe(
      16000
    )
    expect(verifyNoteSignature(result.k1, 5000, result.signature!, m.state.pubkey)).toBe(true)
    expect(
      verifyNoteSignature(result.change, 16000, result.changeSignature!, m.state.pubkey)
    ).toBe(true)
  })

  it('splits several notes at once, with no prior merge', async () => {
    const m = await mint()
    const a = secret('21')
    const b = secret('22')
    m.state.creditNote(a, 21000)
    m.state.creditNote(b, 9000)
    const info = await fetchNoteInfo(noteUrl(m, a))

    const result = await splitNote(info.callback, [a, b], 25000)
    expect(m.state.noteState(a)).toBe('burned')
    expect(m.state.noteState(b)).toBe('burned')
    expect((await fetchNoteInfo(noteUrl(m, result.k1))).maxWithdrawable).toBe(25000)
    expect((await fetchNoteInfo(noteUrl(m, result.change))).maxWithdrawable).toBe(5000)
  })

  it('merges notes into their sum', async () => {
    const m = await mint()
    const parts = ['30', '31', '32'].map(secret)
    parts.forEach((k1, i) => m.state.creditNote(k1, 1000 * (i + 1)))
    const info = await fetchNoteInfo(noteUrl(m, parts[0]!))

    const merged = await mergeNotes(info.callback, parts)
    for (const part of parts) expect(m.state.noteState(part)).toBe('burned')
    expect((await fetchNoteInfo(noteUrl(m, merged.k1))).maxWithdrawable).toBe(6000)
  })

  it('refuses to send a mutation with no note named', async () => {
    const m = await mint()
    await expect(mergeNotes(`${m.url}/w/cb`, [])).rejects.toBeInstanceOf(
      RequestRefusedError
    )
    await expect(splitNote(`${m.url}/w/cb`, [], 1000)).rejects.toBeInstanceOf(
      RequestRefusedError
    )
  })

  it('settles an output against what it is actually worth', async () => {
    const m = await mint()
    const k1 = secret('33')
    m.state.creditNote(k1, 21000)
    const info = await fetchNoteInfo(noteUrl(m, k1))
    const result = await splitNote(info.callback, [k1], 5000)

    // the caller does not know the change is 16000 - only the service does
    const settled = await settleNote(noteUrl(m, k1), result.change, 0, result.changeSignature)
    expect(settled.amountMsat).toBe(16000)
    // and it was rotated on the way, so the GET-exposed secret is gone
    expect(settled.k1).not.toBe(result.change)
    expect(m.state.noteState(result.change)).toBe('burned')
  })
})

describe('melt', () => {
  it('reports OK while the payment is still in flight', async () => {
    const m = await mint({meltNeverSettles: true})
    const k1 = secret('40')
    m.state.creditNote(k1, 21000)
    const info = await fetchNoteInfo(noteUrl(m, k1))

    const result = await meltNote(info.callback, k1, 'lnbc210n1pjqrstuvwxyz')
    expect(result.pr).toBe('lnbc210n1pjqrstuvwxyz')
    // OK does NOT mean spent - the note is reserved, not burned
    expect(m.state.noteState(k1)).toBe('pending')
  })

  it('locks every other operation out until the melt resolves', async () => {
    const m = await mint({meltNeverSettles: true})
    const k1 = secret('41')
    m.state.creditNote(k1, 21000)
    const info = await fetchNoteInfo(noteUrl(m, k1))
    await meltNote(info.callback, k1, 'lnbc210n1pjqrstuvwxyz')

    await expect(rotateNote(info.callback, k1)).rejects.toBeInstanceOf(PendingNoteError)
    await expect(
      meltNote(info.callback, k1, 'lnbc210n1pjqrstuvwxyz')
    ).rejects.toBeInstanceOf(PendingNoteError)
  })

  it('restores the note when the payment fails', async () => {
    const m = await mint({meltAlwaysFails: true})
    const k1 = secret('42')
    m.state.creditNote(k1, 21000)
    const info = await fetchNoteInfo(noteUrl(m, k1))
    await meltNote(info.callback, k1, 'lnbc210n1pjqrstuvwxyz')

    await new Promise(r => setTimeout(r, 60))
    // a failed melt is never reported through the callback - it is only
    // observable as the note becoming spendable again
    expect(m.state.noteState(k1)).toBe('outstanding')
    expect((await fetchNoteInfo(noteUrl(m, k1))).maxWithdrawable).toBe(21000)
  })

  it('burns the note once the payment settles, and proves it', async () => {
    const m = await mint()
    const k1 = secret('43')
    m.state.creditNote(k1, 21000)
    const info = await fetchNoteInfo(noteUrl(m, k1))
    const result = await meltNote(info.callback, k1, 'lnbc210n1pjqrstuvwxyz')

    await new Promise(r => setTimeout(r, 60))
    expect(m.state.noteState(k1)).toBe('burned')

    const proof = await fetchInvoiceVerification(result.verify!)
    expect(proof.settled).toBe(true)
    // the melt's preimage is not the note secret: the note that funded this
    // payment was already burned by the time the proof existed
    expect(proof.preimage).not.toBe(k1)
  })
})

describe('minting', () => {
  it('mints a note from a paid invoice and rotates it immediately', async () => {
    const m = await mint()
    const pay = await fetchPayRequest(`${m.url}/.well-known/lnurlp/mint`)
    expect(pay.withdrawLink).toBe(`lnurlw://127.0.0.1:${m.port}/w`)

    const invoice = await requestInvoice(pay.callback, 21000)
    expect(invoice.disposable).toBe(false)

    // pay it - the mock settles on demand, since nothing here is payable
    const paymentHash = [...m.state.invoices.keys()].at(-1)!
    const pending = m.state.invoices.get(paymentHash)!
    pending.settled = true

    const verified = await fetchInvoiceVerification(invoice.verify!)
    expect(verified.settled).toBe(true)
    // the preimage IS the note secret - which the mint necessarily saw
    const claimed = verified.preimage!
    m.state.creditNote(claimed, 21000)

    const info = await fetchNoteInfo(buildNoteUrl(pay.withdrawLink!, claimed))
    const rotated = await rotateNote(info.callback, claimed)
    // after rotating, the secret the mint generated is worthless
    expect(m.state.noteState(claimed)).toBe('burned')
    expect(m.state.noteState(rotated.k1)).toBe('outstanding')
  })

  it('reads an advertised mint fee', async () => {
    const m = await mint({baseFeeMsat: 1000, feePpm: 2000})
    const pay = await fetchPayRequest(`${m.url}/.well-known/lnurlp/mint`)
    expect(pay.mintFee).toEqual({baseFeeMsat: 1000, feePpm: 2000})
  })

  it('reads no fee from a mint that advertises none', async () => {
    const m = await mint()
    const pay = await fetchPayRequest(`${m.url}/.well-known/lnurlp/mint`)
    expect(pay.mintFee).toBeUndefined()
  })

  it('refuses an invoice for an amount it did not ask for', async () => {
    const m = await mint()
    const pay = await fetchPayRequest(`${m.url}/.well-known/lnurlp/mint`)
    const spyFetch: typeof fetch = async (input, init) => {
      const res = await fetch(input as string, init)
      const body = await res.json()
      // the service swaps in an invoice for a hundredth of the amount
      return new Response(JSON.stringify({...body, pr: 'lnbc21n1pjqrstuvwxyz'}), {
        headers: {'content-type': 'application/json'}
      })
    }
    await expect(
      requestInvoice(pay.callback, 21000, {fetch: spyFetch})
    ).rejects.toBeInstanceOf(ProtocolError)
  })

  it('finds the experimental mint address', async () => {
    const m = await mint()
    const address = await fetchMintAddress(`${m.url}/.well-known/lnurlw/mint`)
    expect(address.nodePubkey).toBe(m.state.pubkey)
    expect(address.payLink).toBe(`${m.url}/.well-known/lnurlp/mint`)
    // Against the real mock, unstubbed: the conformance mint advertises
    // nodeCapacity on the wire, so the rename has to survive a round trip
    // nobody here controls. The spied tests below prove the mapping in
    // isolation; this one proves it against what a mint actually sends.
    expect(address.nodeCapacityMsat).toBe(500_000_000)
    expect(address.nodeNumChannels).toBe(4)
    expect(address.nodeNumPeers).toBe(6)
  })

  it('reads the node stats a mint address advertises', async () => {
    const m = await mint()
    // lnurl-mint answers with nodeCapacity (msat), which this side exposes
    // as nodeCapacityMsat - a rename that only happens if it is mapped
    const spyFetch: typeof fetch = async (input, init) => {
      const res = await fetch(input as string, init)
      const body = await res.json()
      return new Response(
        JSON.stringify({
          ...body,
          nodeCapacity: 210_000_000,
          nodeNumChannels: 12,
          nodeNumPeers: 9
        }),
        {headers: {'content-type': 'application/json'}}
      )
    }
    const address = await fetchMintAddress(`${m.url}/.well-known/lnurlw/mint`, {
      fetch: spyFetch
    })
    expect(address.nodeCapacityMsat).toBe(210_000_000)
    expect(address.nodeNumChannels).toBe(12)
    expect(address.nodeNumPeers).toBe(9)
  })

  it('leaves the node stats undefined when a mint address omits them', async () => {
    const m = await mint()
    const spyFetch: typeof fetch = async (input, init) => {
      const res = await fetch(input as string, init)
      const {nodeCapacity, nodeNumChannels, nodeNumPeers, ...body} = await res.json()
      return new Response(JSON.stringify(body), {
        headers: {'content-type': 'application/json'}
      })
    }
    const address = await fetchMintAddress(`${m.url}/.well-known/lnurlw/mint`, {
      fetch: spyFetch
    })
    expect(address.nodeCapacityMsat).toBeUndefined()
    expect(address.nodeNumChannels).toBeUndefined()
  })

  it('reports a sunsetting mint\'s refusal as definitive', async () => {
    const m = await mint({sunset: true})
    const pay = await fetchPayRequest(`${m.url}/.well-known/lnurlp/mint`)
    await expect(requestInvoice(pay.callback, 21000)).rejects.toBeInstanceOf(
      ServiceRejectedError
    )
  })
})

describe('ambiguous outcomes', () => {
  it('preserves the fresh secret when a rotate\'s answer is lost', async () => {
    const m = await mint({dropAfterMutation: true})
    const k1 = secret('50')
    m.state.creditNote(k1, 21000)
    const callback = `${m.url}/w/cb`

    const err = await rotateNote(callback, k1).catch(e => e)
    expect(err).toBeInstanceOf(AmbiguousMutationError)
    expect(err.newSecrets).toHaveLength(1)

    // the mutation did land: the input is burned and the output exists,
    // keyed by the hash of a secret only the caller holds
    expect(m.state.noteState(k1)).toBe('burned')
    const rescued = err.newSecrets[0]
    expect(m.state.noteState(rescued)).toBe('outstanding')
    expect((await fetchNoteInfo(noteUrl(m, rescued))).maxWithdrawable).toBe(21000)
  })

  it('preserves both secrets when a split\'s answer is lost, in output order', async () => {
    const m = await mint({dropAfterMutation: true})
    const k1 = secret('51')
    m.state.creditNote(k1, 21000)

    const err = await splitNote(`${m.url}/w/cb`, [k1], 5000).catch(e => e)
    expect(err).toBeInstanceOf(AmbiguousMutationError)
    expect(err.newSecrets).toHaveLength(2)
    const [split, change] = err.newSecrets
    expect((await fetchNoteInfo(noteUrl(m, split))).maxWithdrawable).toBe(5000)
    expect((await fetchNoteInfo(noteUrl(m, change))).maxWithdrawable).toBe(16000)
  })

  it('probes a burned input to resolve the ambiguity', async () => {
    const m = await mint({dropAfterMutation: true})
    const k1 = secret('52')
    m.state.creditNote(k1, 21000)
    await rotateNote(`${m.url}/w/cb`, k1).catch(() => {})
    // gone: the burn landed, so the rescued secret is the only money left
    expect(await probeBurnedNote(noteUrl(m, k1))).toBe('gone')

    const live = await mint()
    const alive = secret('53')
    live.state.creditNote(alive, 21000)
    expect(await probeBurnedNote(noteUrl(live, alive))).toBe('live')

    // a probe that cannot reach the service resolves nothing
    expect(await probeBurnedNote(noteUrl(live, alive), {offline: true})).toBe(
      'unknown'
    )
  })

  it('treats a 200 that confirms nothing as ambiguous', async () => {
    const m = await mint({unconfirmedMutation: true})
    const k1 = secret('54')
    m.state.creditNote(k1, 21000)
    const err = await rotateNote(`${m.url}/w/cb`, k1).catch(e => e)
    expect(err).toBeInstanceOf(AmbiguousMutationError)
    expect(m.state.noteState(k1)).toBe('burned')
  })

  it('treats an unreadable response as ambiguous', async () => {
    const m = await mint({malformedJson: true})
    const k1 = secret('55')
    m.state.creditNote(k1, 21000)
    const err = await rotateNote(`${m.url}/w/cb`, k1).catch(e => e)
    expect(err).toBeInstanceOf(AmbiguousMutationError)
  })

  it('treats a timeout as ambiguous, not as failure', async () => {
    const m = await mint({slowMs: 200})
    const k1 = secret('56')
    m.state.creditNote(k1, 21000)
    const err = await rotateNote(`${m.url}/w/cb`, k1, {timeoutMs: 30}).catch(e => e)
    expect(err).toBeInstanceOf(AmbiguousMutationError)
  })

  it('treats a refused request as definitely not sent', async () => {
    const m = await mint()
    const k1 = secret('57')
    m.state.creditNote(k1, 21000)
    // offline mode is not ambiguity: nothing left the process
    const err = await rotateNote(`${m.url}/w/cb`, k1, {offline: true}).catch(e => e)
    expect(err).toBeInstanceOf(RequestRefusedError)
    expect(err).not.toBeInstanceOf(AmbiguousMintError)
    expect(m.state.noteState(k1)).toBe('outstanding')
  })

  it('refuses a callback URL it would not fetch', async () => {
    const m = await mint()
    const k1 = secret('58')
    m.state.creditNote(k1, 21000)
    await expect(
      rotateNote('http://evil.example/cb', k1)
    ).rejects.toBeInstanceOf(RequestRefusedError)
  })
})

describe('a service that lies about value', () => {
  it('cannot inflate a note past what it signed', async () => {
    const m = await mint({lieAboutValue: 1_000_000})
    const k1 = secret('60')
    const signature = m.state.creditNote(k1, 21000)

    const info = await fetchNoteInfo(noteUrl(m, k1))
    expect(info.maxWithdrawable).toBe(1_021_000)
    // the signature was issued over the true amount, so the inflated one
    // does not verify - an offline holder can catch this without asking
    expect(verifyNoteSignature(k1, info.maxWithdrawable, signature!, m.state.pubkey)).toBe(false)
    expect(verifyNoteSignature(k1, 21000, signature!, m.state.pubkey)).toBe(true)
  })
})
