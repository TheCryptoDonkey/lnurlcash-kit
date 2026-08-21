# lnurlcash-kit

LNURLcash ([LUD-25 draft](https://github.com/lnurl/luds/pull/301)) bearer
notes for TypeScript: mint, rotate, split, merge, melt, and verify a note
offline.

```bash
npm install lnurlcash-kit
```

This is an early `0.x` release tracking a **draft** spec. Pin an exact
version.

## What a bearer note is

An ordinary [LUD-03](https://github.com/lnurl/luds/blob/luds/03.md)
withdrawRequest link whose `k1` **is** the asset:

```
lnurlw://mint.example/w?k1=<secret>&amount=<msat>
```

Whoever knows the `k1` controls the sats behind it, like a banknote. The
`amount` alongside it is only a claim by whoever encoded the note; the
authoritative value is always `maxWithdrawable` from an informational GET.

No new endpoint and no new encoding, so a wallet that has never heard of
LNURLcash sees a normal withdraw link and can still cash it out. Every
mutating operation is a GET on the `callback` from that withdrawRequest:

| Request | Result |
| --- | --- |
| `callback?k1=X&pr=<bolt11>` | **melt**: X burned once `pr` settles |
| `callback?k1=X&h=<sha256(X')>` | **rotate**: X burned, a note keyed by `h` minted |
| `callback?k1=X&amount=<msat>&h=..&h2=..` | **split**: X burned, notes keyed by `h` and `h2` minted |
| `callback?k1=X&k1=Y&h=<sha256(Z)>` | **merge**: all burned, one note keyed by `h` minted |

## Usage

```ts
import {
  resolveNoteInput,
  fetchNoteInfo,
  rotateNote,
  splitNote,
  meltNote,
  verifyNoteSignature
} from 'lnurlcash-kit'

// accepts a bech32 LNURL, an lnurlw:// URL, or a plain https one
const url = resolveNoteInput(scanned)
if (!url) throw new Error('not a note')

// what is it actually worth? Only the service can say.
const info = await fetchNoteInfo(url)
console.log(info.maxWithdrawable, 'msat')

// that GET put the secret on the wire, so rotate it
const fresh = await rotateNote(info.callback, info.k1)

// and check the mint really issued it, without asking anyone
if (info.mintPubkey && fresh.signature) {
  verifyNoteSignature(fresh.k1, info.maxWithdrawable, fresh.signature, info.mintPubkey)
}
```

Every request function takes options last — `fetch`, `timeoutMs`, `offline`,
`randomSecret`. `createClient(options)` binds one set once:

```ts
const client = createClient({timeoutMs: 10_000})
await client.rotateNote(callback, k1)
```

## The five things that will cost you money

Everything below is a bug class this library exists to close. If you write
your own client instead, write these first.

**1. Never let the service generate a replacement secret.** On rotate, split
and merge the *wallet* draws a fresh 32 bytes and discloses only
`sha256(secret)` as `h`. A service-issued replacement has, structurally,
been seen by that service — so a "rotate" that accepts one closes no
exposure at all. This library generates them and ignores any `k1` a
non-compliant service tries to hand back.

**2. A failed mutation is not a failure.** If a rotate times out, the
service may already have burned your input and minted the output. The fresh
secret in your process is then the only copy of that money in existence.
Every mutating call raises `AmbiguousMutationError` carrying `newSecrets` —
**persist them before doing anything else**, then use `probeBurnedNote` to
find out what happened:

```ts
try {
  const {k1} = await rotateNote(callback, oldK1)
} catch (err) {
  if (err instanceof AmbiguousMutationError) {
    await save(err.newSecrets)                    // first. always.
    const fate = await probeBurnedNote(noteUrl)
    // 'live'    -> nothing landed, the saved secrets are worthless
    // 'gone'    -> the burn landed, the saved secrets ARE the note
    // 'unknown' -> keep everything and try again later
  }
}
```

`RequestRefusedError` is the opposite and safe: nothing left the process.

**3. Your HTTP stack must not retry.** Every mutation is a GET, HTTP treats GET
as idempotent, and an LNURLcash mutation is not — the first attempt burns the
input. A retried mutation is answered "already spent", which reads as a
*definitive* rejection, so the fresh secret gets discarded along with the note
the service just minted. Node's `fetch` does not retry on its own, but a
browser will resend an idempotent request that failed on a stale pooled
connection, and any retry wrapper, service worker or proxy in front of this
will do the same. If you pass your own `fetch`, do not make it retry these.

This is not hypothetical: the same hazard broke the
[Kotlin](https://github.com/TheCryptoDonkey/lnurlcash-kotlin) and
[Go](https://github.com/TheCryptoDonkey/lnurlcash-go) siblings during
development, by two different mechanisms, and is now a named scenario in the
conformance vectors.

**4. A melt's `OK` means "in flight", not "spent".** The service pays
asynchronously and only burns the note once the payment settles, restoring
it if the payment fails. A failed melt is never reported back through the
callback — it is only observable as the note becoming spendable again. Other
operations on that `k1` raise `PendingNoteError` meanwhile; retry, never
read it as spent.

**5. Rotate the instant you claim a minted note.** The preimage that mints a
note is generated by the service, and if it serves
[LUD-21](https://github.com/lnurl/luds/blob/luds/21.md) `verify`, *anyone*
who saw the unpaid invoice can poll for it — the payment hash travels inside
the invoice. First rotater wins. A wallet that rotates on settlement wins by
construction; a human copying a preimage by hand does not.

## Offline verification

A service may sign each note with its Lightning node identity key, so a
holder can confirm issuer and amount with nothing but the note:

```
message = "LNURLcash:" || amount_msat || ":" || hex(sha256(k1))
digest  = sha256(sha256("Lightning Signed Message:" || message))
sig     = 65 bytes, r || s || recovery_id
```

`verifyNoteSignature` recovers the pubkey and compares it to `mintPubkey`.
It accepts the recovery id at either end, because lnurl-mint once emitted
the reverse layout and other implementations may still; trying both is safe,
since the wrong ordering recovers an unrelated key that cannot match.

The signature commits to the note's *hash*, not its secret — so you can
prove a mint issued a note, to expose one that will not honour it, without
handing over what would let anyone spend it.

## Scope

This library speaks the protocol. It does not store notes, hold keys, manage
a balance, pay invoices, or decide anything about your UI. Storage and key
management are yours, and they are where most of the remaining risk lives —
see [THREAT-MODEL.md](THREAT-MODEL.md).

Amounts are integers in **milli-satoshis**, everywhere, with no exceptions.

## Provenance

The protocol layer was extracted from
[lnurl-wallet](https://github.com/dni/lnurl-wallet), the LNURLcash reference
wallet by dni, rather than reimplemented — that code has been exercised
against a real mint and an adversarial mock, and a fresh rewrite would have
thrown that away to no one's benefit.

The reference implementations, both dni's, both MIT:

- [lnurl-mint](https://github.com/dni/lnurl-mint) — the reference service
- [lnurl-wallet](https://github.com/dni/lnurl-wallet) — the reference wallet

Everything else built on LNURLcash — the other wallets and mints, the
hardware vault, the sibling language ports — is indexed in
[awesome-lnurlcash](https://github.com/TheCryptoDonkey/awesome-lnurlcash).

Changes made on extraction are listed in [CHANGELOG.md](CHANGELOG.md); two
are behavioural fixes worth reading if you are porting from that code.

## Conformance

Tested against [lnurlcash-conformance](https://github.com/TheCryptoDonkey/lnurlcash-conformance):
language-neutral vectors plus a mock mint that can be told to misbehave —
drop a connection mid-mutation, sign in the wrong byte order, lie about a
note's value, never settle a melt. If you are writing an LNURLcash
implementation in any language, run those vectors before you run real sats
through it.

```bash
npm test
```

## License

MIT. See [LICENSE](LICENSE) for the attribution.
