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

### When a mint rotates its signing key

Rotating invalidates nothing. The notes already issued are still genuine and
their signatures still verify, but only against the key that made them, so a
wallet holding the new key alone would suddenly read every outstanding note
as forged. A mint publishes the keys it has retired as `previousPubkeys` on
its mint address, and verification takes the whole set:

```ts
const {nodePubkey, previousPubkeys = []} = await fetchMintAddress(addressUrl)
const check = verifyNoteSignatureAgainst(k1, amountMsat, sig, [
  nodePubkey,
  ...previousPubkeys
])
// check.pubkey names the key that signed. A note that verifies only against
// a retired one is worth rotating: the mint re-signs it under the current key.
```

`verifyNoteSignature` takes the same one-or-many argument and returns a plain
boolean. An empty list is a rejection, not a pass.

### What else a mint says about itself

`fetchMintAddress` reads the experimental discovery endpoint, and a mint may
publish a `name`, a `description`, `contact` details, a `tosUrl`, a `motd`,
its structured `fees` and its software `version` there. All optional, all
absent on most mints, and none of it is needed to spend a note. Surface the
MOTD when it changes: it is how an operator announces maintenance, a fee
change or a sunset date, and there is no other channel to a bearer holder.
The endpoint carries no LUD number, so treat a rejection as "no extra
information" and fall back to `fetchPayRequest`.

## Secrets

A note's `k1` is generated by the wallet, and LUD-25 says nothing about how.
Draw it from a CSPRNG and the note lives only in your wallet file: the mint
holds `sha256(k1)` and cannot tell you apart from a stranger, so a lost file
is lost money. Derive it from a seed instead and the wallet restores from
words alone.

```
root = HMAC-SHA256(key = utf8("lnurlcash-note-v1"), msg = seed)
k1_i = HMAC-SHA256(key = root,                      msg = utf8(host + ":" + index))
```

`seed` is raw bytes. A 64-byte BIP39 seed is what wallets use in practice,
but nothing here depends on BIP39, so a device with its own entropy store
derives the same way and no consumer carries a wordlist it does not need.
`host` is the mint host exactly as `serverOf` spells it, lowercase and with
the port where there is one, so `127.0.0.1:8899` and `mint.example` never
collide. `index` is decimal ASCII from 0. The output is 32 bytes of hex, the
size of a payment preimage, and the mint sees nothing different: it only
ever receives `sha256(k1)`.

Because the scheme is written down here rather than invented per wallet, the
same words restore the same notes in a *different* wallet. That
cross-wallet portability is the point of putting it in the kit, with
[a conformance vector](https://github.com/TheCryptoDonkey/lnurlcash-conformance)
for the ports.

```ts
import {deriveNoteRoot, derivedSecretSource, restoreNotes} from 'lnurlcash-kit'

const root = deriveNoteRoot(seed)          // seed: Uint8Array, yours to keep safe
const source = derivedSecretSource(root, 'mint.example', counter)

// hand it to any mutating call and the fresh secrets come from the seed
const {k1, change} = await splitNote(callback, [note], 40_000, {randomSecret: source})
saveCounter('mint.example', source.index())  // a split consumed two indices
```

Persist that counter in the **same write that stages the new records**, and
do it **before** the hash goes on the wire. A crash between the bump and the
request wastes an index, which costs nothing. A crash the other way round
re-derives a secret the mint has already seen, and the second note minted at
it collides with the first. This is the rule wallets get wrong.

Restoring walks the indices and asks the mint what each derived secret is
worth:

```ts
const {found, next} = await restoreNotes('https://mint.example/w', root, 'mint.example')
```

A live note is recorded, a spent index still counts as used (re-deriving it
would mint a duplicate), an unknown one counts towards the gap, and the walk
stops after 20 consecutive unknowns. `next` is the counter to resume from.
Restoring puts every `k1` it walks on the wire and a restored note carries no
signature, so rotate each one straight after: that closes the exposure and
gets the signature in the same call.

The seed is bearer material for every note the wallet will ever hold. Store
it the way you store the notes, and never log it.

## Taking a note as payment

A server that accepts bearer notes for something makes the same decisions
every time, in this order, and `settleNoteForValue` is that order written
once:

```ts
import {settleNoteForValue, InsufficientValueError} from 'lnurlcash-kit'

try {
  const {note, newUrl} = await settleNoteForValue(offered, {
    mints: ['mint.example'],   // hosts this server accepts. An empty list accepts nothing.
    minMsat: 21_000,           // the price
    requireSignature: false    // demand offline proof of issuance first
  })
  grantAccess()                // note.k1 is yours now; newUrl is a note to store or melt
} catch (err) {
  if (err instanceof InsufficientValueError) refuse(err.amountMsat, err.minMsat)
  else refuse()
}
```

1. the input parses as a note at all
2. its mint is one this server accepts (checked before any round trip, so an
   unaccepted mint is never contacted)
3. an informational GET for the **authoritative** value and the mint's key
4. the signature, where the server demands one, over the value the mint
   stated rather than the one the URL claims
5. that value covers the price
6. **rotate**

Step 6 is the settlement, not bookkeeping after it. Rotating burns the
secret the payer handed over and mints a replacement only this server knows,
in one atomic request: it transfers ownership and rejects a replay in the
same call, because a second presentation of the same note finds it spent. A
server that checks a note's value and grants access without rotating has
verified a photograph of a banknote.

Refusals are typed, and nothing is burned by any of them: `ServiceRejectedError`
for an unaccepted mint or a signature that will not verify,
`InsufficientValueError` (carrying both amounts) for a note worth too
little, `NoteSpentError` for one already spent or presented twice,
`PendingNoteError` for one with a melt in flight, which is worth retrying
rather than refusing outright. `AmbiguousMutationError` from the rotate is
the case to handle with care: persist `err.newSecrets` before anything else,
because if the request landed then that secret is the money and it is now
this server's.

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
