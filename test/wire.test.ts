// The vectors describe what goes on the wire and what comes back. This
// suite holds the library to both, with no real network involved: a stub
// fetch stands in for the SERVICE, so a case can be exactly as hostile as
// the vector says it is.

import {describe, expect, it} from 'vitest'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {
  AmbiguousMintError,
  NoteSpentError,
  NoteUnknownError,
  PendingNoteError,
  ProtocolError,
  RequestRefusedError,
  ServiceRejectedError,
  fetchInvoiceVerification,
  fetchNoteInfo,
  fetchPayRequest,
  meltNote,
  mergeNotes,
  mergeNotesWithHash,
  requestInvoice,
  rotateNoteWithHash,
  splitNote,
  splitNoteWithHash
} from '../src/index.js'

const require = createRequire(import.meta.url)
const load = (name: string): any =>
  JSON.parse(
    readFileSync(require.resolve(`lnurlcash-conformance/vectors/${name}`), 'utf8')
  )

const jsonFetch = (body: unknown, status = 200): typeof fetch =>
  async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: {'content-type': 'application/json'}
    })

const rawFetch = (body: string, status = 200): typeof fetch =>
  async () => new Response(body, {status})

const capturingFetch = (seen: string[]): typeof fetch => async input => {
  seen.push(input.toString())
  return new Response(JSON.stringify({status: 'OK'}), {
    headers: {'content-type': 'application/json'}
  })
}

const params = (url: string): [string, string][] =>
  [...new URL(url).searchParams.entries()].sort()

describe('callback request vectors', () => {
  const vectors = load('callbacks.json')

  for (const c of vectors.cases) {
    it(`builds the request for: ${c.name}`, async () => {
      const seen: string[] = []
      const opts = {fetch: capturingFetch(seen)}
      const p = c.params

      if (c.op === 'melt') {
        await meltNote(c.callback, p.k1[0], p.pr, opts)
      } else if (c.op === 'rotate') {
        await rotateNoteWithHash(c.callback, p.k1[0], p.h, opts)
      } else if (c.op === 'split') {
        await splitNoteWithHash(c.callback, p.k1, p.amountMsat, p.h, p.h2, opts)
      } else if (c.op === 'merge') {
        await mergeNotesWithHash(c.callback, p.k1, p.h, opts)
      }

      expect(seen).toHaveLength(1)
      expect(params(seen[0]!)).toEqual(
        [...c.expectQuery].sort((a: string[], b: string[]) =>
          a[0]! === b[0]! ? a[1]!.localeCompare(b[1]!) : a[0]!.localeCompare(b[0]!)
        )
      )
    })
  }

  // The remaining rejected vectors - a melt with several k1, a melt with an
  // amount, a rotate with no h, a split with no h2 - are not expressible
  // through this library at all: meltNote takes exactly one k1 and no
  // amount, and the hash arguments are required parameters. The one case
  // that IS expressible is an empty note list, so it gets a real assertion.
  it('refuses a mutation naming no note', async () => {
    const seen: string[] = []
    const opts = {fetch: capturingFetch(seen)}
    await expect(
      mergeNotes('https://mint.example/w/cb', [], opts)
    ).rejects.toBeInstanceOf(RequestRefusedError)
    await expect(
      splitNote('https://mint.example/w/cb', [], 1000, opts)
    ).rejects.toBeInstanceOf(RequestRefusedError)
    expect(seen).toHaveLength(0)
  })
})

describe('response classification vectors', () => {
  const vectors = load('responses.json')
  const K1 = 'a'.repeat(64)
  const H = 'b'.repeat(64)
  const CB = 'https://mint.example/w/cb'

  const drive = (c: any) => {
    if (c.transportError) {
      return rotateNoteWithHash(CB, K1, H, {
        fetch: async () => {
          throw new TypeError('network error')
        }
      })
    }
    if (c.timeout) {
      return rotateNoteWithHash(CB, K1, H, {
        fetch: async () => {
          const err = new Error('timed out')
          err.name = 'TimeoutError'
          throw err
        }
      })
    }
    const stub =
      c.bodyRaw !== undefined
        ? rawFetch(c.bodyRaw, c.http)
        : jsonFetch(c.body, c.http)
    return rotateNoteWithHash(CB, K1, H, {fetch: stub})
  }

  for (const c of vectors.cases) {
    it(`classifies as ${c.expect}: ${c.name}`, async () => {
      if (c.expect === 'ok') {
        const result = await drive(c)
        if (c.signature) expect(result.signature).toBe(c.signature)
        return
      }
      const err = await drive(c).catch(e => e)
      if (c.expect === 'pending') expect(err).toBeInstanceOf(PendingNoteError)
      else if (c.expect === 'spent') expect(err).toBeInstanceOf(NoteSpentError)
      else if (c.expect === 'unknown') expect(err).toBeInstanceOf(NoteUnknownError)
      else if (c.expect === 'ambiguous') expect(err).toBeInstanceOf(AmbiguousMintError)
      else if (c.expect === 'error') {
        expect(err).toBeInstanceOf(ServiceRejectedError)
        // a definitive refusal for some other reason must not be mistaken
        // for one of the note-specific outcomes a holder acts on
        expect(err).not.toBeInstanceOf(PendingNoteError)
        expect(err).not.toBeInstanceOf(NoteSpentError)
        expect(err).not.toBeInstanceOf(NoteUnknownError)
      }
    })
  }

  it('returns both signatures from a split', async () => {
    const c = vectors.cases.find((v: any) => v.body?.sig2)
    const result = await splitNoteWithHash(
      CB,
      [K1],
      5000,
      H,
      'c'.repeat(64),
      {fetch: jsonFetch(c.body)}
    )
    expect(result.signature).toBe(c.signature)
    expect(result.changeSignature).toBe(c.changeSignature)
  })

  it('returns a melt proof when the service offers one', async () => {
    const c = vectors.cases.find((v: any) => v.body?.verify && v.body?.pr)
    const result = await meltNote(CB, K1, 'lnbc210n1pjq', {
      fetch: jsonFetch(c.body)
    })
    expect(result.verify).toBe(c.body.verify)
    expect(result.pr).toBe(c.body.pr)
  })
})

describe('withdrawRequest response vectors', () => {
  const vectors = load('withdraw-info.json')

  for (const c of vectors.accepted) {
    it(`accepts: ${c.name}`, async () => {
      const info = await fetchNoteInfo(vectors.queriedUrl, {
        fetch: jsonFetch(c.body)
      })
      expect(info.maxWithdrawable).toBe(c.maxWithdrawable)
    })
  }

  for (const c of vectors.rejected) {
    it(`rejects: ${c.name}`, async () => {
      await expect(
        fetchNoteInfo(vectors.queriedUrl, {fetch: jsonFetch(c.body)})
      ).rejects.toBeInstanceOf(ProtocolError)
    })
  }

  it('never puts the signature on the wire', async () => {
    const seen: string[] = []
    await fetchNoteInfo(vectors.queriedUrl, {
      fetch: async input => {
        seen.push(input.toString())
        return new Response(JSON.stringify(vectors.accepted[0].body), {
          headers: {'content-type': 'application/json'}
        })
      }
    })
    for (const field of vectors.requestMustNotSend) {
      expect(seen[0]).not.toContain(`${field}=`)
    }
    for (const field of vectors.requestMustSendUnchanged) {
      expect(seen[0]).toContain(`${field}=`)
    }
  })
})

describe('payRequest vectors', () => {
  const vectors = load('pay-request.json')

  for (const c of vectors.accepted) {
    it(`accepts: ${c.name}`, async () => {
      const pay = await fetchPayRequest('https://mint.example/.well-known/lnurlp/mint', {
        fetch: jsonFetch(c.body)
      })
      expect(pay.withdrawLink ?? null).toBe(c.withdrawLink)
      expect(pay.mintFee ?? null).toEqual(c.mintFee)
    })
  }

  for (const c of vectors.rejected) {
    it(`rejects: ${c.name}`, async () => {
      await expect(
        fetchPayRequest('https://mint.example/.well-known/lnurlp/mint', {
          fetch: jsonFetch(c.body)
        })
      ).rejects.toBeInstanceOf(ProtocolError)
    })
  }

  for (const c of vectors.invoice.accepted) {
    it(`accepts an invoice: ${c.name}`, async () => {
      const result = await requestInvoice('https://mint.example/p/cb', c.requestedMsat, {
        fetch: jsonFetch(c.body)
      })
      expect(result.pr).toBe(c.body.pr)
      expect(result.disposable).toBe(c.disposable)
      expect(result.verify ?? null).toBe(c.verify ?? null)
    })
  }

  for (const c of vectors.invoice.rejected) {
    it(`rejects an invoice: ${c.name}`, async () => {
      await expect(
        requestInvoice('https://mint.example/p/cb', c.requestedMsat, {
          fetch: jsonFetch(c.body)
        })
      ).rejects.toBeInstanceOf(ProtocolError)
    })
  }

  for (const c of vectors.verify.accepted) {
    it(`accepts a verify response: ${c.name}`, async () => {
      const result = await fetchInvoiceVerification('https://mint.example/verify/ab', {
        fetch: jsonFetch(c.body)
      })
      expect(result.settled).toBe(c.settled)
      expect(result.preimage).toBe(c.preimage)
    })
  }

  for (const c of vectors.verify.rejected) {
    it(`rejects a verify response: ${c.name}`, async () => {
      await expect(
        fetchInvoiceVerification('https://mint.example/verify/ab', {
          fetch: jsonFetch(c.body)
        })
      ).rejects.toBeInstanceOf(ProtocolError)
    })
  }
})


describe('transport discipline', () => {
  const K1 = 'a'.repeat(64)
  const H = 'b'.repeat(64)
  const CB = 'https://mint.example/w/cb'
  const OK = JSON.stringify({status: 'OK'})

  // First request 302s to `target`; anything reached afterwards answers OK.
  const redirectFetch = (target: string, seen: string[]): typeof fetch =>
    async input => {
      seen.push(input.toString())
      if (seen.length === 1) {
        return new Response(null, {status: 302, headers: {location: target}})
      }
      return new Response(OK, {headers: {'content-type': 'application/json'}})
    }

  it('follows a redirect that stays on an allowed URL', async () => {
    const seen: string[] = []
    await rotateNoteWithHash(CB, K1, H, {
      fetch: redirectFetch('https://mint2.example/w/cb', seen)
    })
    expect(seen).toHaveLength(2)
    expect(seen[1]).toContain('mint2.example')
  })

  it('resolves a relative redirect against the URL that issued it', async () => {
    const seen: string[] = []
    await rotateNoteWithHash(CB, K1, H, {fetch: redirectFetch('/w/cb2', seen)})
    expect(seen).toHaveLength(2)
    expect(seen[1]).toBe('https://mint.example/w/cb2')
  })

  it('refuses to follow a redirect onto cleartext', async () => {
    const seen: string[] = []
    const err = await rotateNoteWithHash(CB, K1, H, {
      fetch: redirectFetch('http://mint2.example/w/cb', seen)
    }).catch(e => e)
    expect(err).toBeInstanceOf(AmbiguousMintError)
    expect(seen).toHaveLength(1)
  })

  it('refuses to follow a redirect to a non-http scheme', async () => {
    const seen: string[] = []
    const err = await rotateNoteWithHash(CB, K1, H, {
      fetch: redirectFetch('data:application/json,{"status":"OK"}', seen)
    }).catch(e => e)
    expect(err).toBeInstanceOf(AmbiguousMintError)
    expect(seen).toHaveLength(1)
  })

  it('gives up on a redirect loop', async () => {
    const seen: string[] = []
    const err = await rotateNoteWithHash(CB, K1, H, {
      fetch: async input => {
        seen.push(input.toString())
        return new Response(null, {
          status: 302,
          headers: {location: 'https://mint.example/loop'}
        })
      }
    }).catch(e => e)
    expect(err).toBeInstanceOf(AmbiguousMintError)
    expect(seen.length).toBeLessThanOrEqual(7)
  })

  it('refuses a body that declares itself oversized', async () => {
    const err = await rotateNoteWithHash(CB, K1, H, {
      fetch: async () =>
        new Response(OK, {
          headers: {'content-type': 'application/json', 'content-length': '99999999'}
        })
    }).catch(e => e)
    expect(err).toBeInstanceOf(AmbiguousMintError)
    expect(err.message).toContain('oversized')
  })

  it('refuses a body that streams past the cap', async () => {
    const err = await rotateNoteWithHash(CB, K1, H, {
      fetch: async () =>
        new Response(' '.repeat(1_100_000), {
          headers: {'content-type': 'application/json'}
        })
    }).catch(e => e)
    expect(err).toBeInstanceOf(AmbiguousMintError)
    expect(err.message).toContain('oversized')
  })

  it('rejects a non-integer maxWithdrawable', async () => {
    await expect(
      fetchNoteInfo(`https://mint.example/w?k1=${K1}`, {
        fetch: jsonFetch({
          tag: 'withdrawRequest',
          callback: CB,
          k1: K1,
          minWithdrawable: 0,
          maxWithdrawable: 1000.5
        })
      })
    ).rejects.toBeInstanceOf(ProtocolError)
  })
})

describe('the default fetch and browser method semantics', () => {
  it('never calls the global fetch detached - a browser would throw Illegal invocation', async () => {
    // A stand-in for window.fetch: a method that, like every DOM method,
    // demands its receiver. Node and DOM test environments do not enforce
    // this, which is exactly why it must be simulated here.
    const original = globalThis.fetch
    class BrowserWindow {
      async fetch(this: unknown, _input: RequestInfo | URL, _init?: RequestInit): Promise<Response> {
        // WebIDL receiver rules: undefined/null coerces to the global,
        // the global itself is fine, ANY other object fails the brand
        // check - which is what `options.fetch(...)` used to hand it.
        if (this !== undefined && this !== null && this !== globalThis && !(this instanceof BrowserWindow)) {
          throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation")
        }
        return new Response(
          JSON.stringify({tag: 'payRequest', callback: 'https://mint.example/cb', minSendable: 1000, maxSendable: 2000, metadata: '[]'}),
          {status: 200, headers: {'content-type': 'application/json'}}
        )
      }
    }
    const fakeWindow = new BrowserWindow()
    globalThis.fetch = fakeWindow.fetch as typeof fetch
    try {
      const info = await fetchPayRequest('https://mint.example/.well-known/lnurlp/mint')
      expect(info.tag).toBe('payRequest')
    } finally {
      globalThis.fetch = original
    }
  })
})
