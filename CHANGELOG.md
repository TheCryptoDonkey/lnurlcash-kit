# Changelog

Semantic versioning. While the LUD-25 draft is unmerged, `0.x` minor bumps
may carry breaking changes; pin an exact version.

## 0.1.2 - 2026-08-21

- `mintFeeBand` and `withinMintFeeBand`. LUD-25 states the mint fee as
  `base_fee_msat` plus a ppm cut and says nothing about rounding, and the
  two live implementations read that differently: dni's lnurl-mint - the
  reference, and what every public mint on the awesome list except moneyer
  runs - ceilings the fee to a whole sat on purpose so the mint is "never
  short a sat", while moneyer withholds the msat-exact amount.
- So `applyMintFee` is right about exactly one of them, and a wallet
  comparing a credited note against it warns spuriously against the other.
  Measured on real sats: 40,000 msat at a 1000 + 1000 ppm mint credited
  38,000, not the 38,960 the formula gives.
- `mintFeeBand` returns the range - the formula is the most a holder can be
  credited, the sat-ceilinged fee the least - and `withinMintFeeBand` is
  what a caller should compare against. `applyMintFee` is unchanged and
  still means the formula; it is now documented as the generous edge rather
  than the answer.
- Nothing here decides which reading is correct. That is a question for
  lnurl/luds#301.

## 0.1.1 - 2026-08-20

- `fetchMintAddress` now populates `nodeCapacityMsat`. The wire field is
  `nodeCapacity`, and the response was spread through unmapped, so the typed
  field was always `undefined` - inherited from lnurl-wallet, where the same
  bug hides the mint's channel capacity in the UI. `nodeNumChannels` and
  `nodeNumPeers` were never affected: those names match the wire.
- The conformance vectors now come from the published
  `lnurlcash-conformance` package rather than a git ref, so the suite runs
  against a released, attested set of vectors. Test-only; nothing consumers
  install changes.

## 0.1.0 - 2026-08-20

First release. The protocol layer of
[lnurl-wallet](https://github.com/dni/lnurl-wallet) (MIT, dni), extracted as
a standalone library.

### Changes made on extraction

**No globals.** The wallet's `offlineMode()` global became an `offline`
option, and `fetch`, `timeoutMs` and `randomSecret` joined it. Nothing reads
ambient state, so a caller can be certain what a call will and will not do.
`createClient(options)` binds one set for callers who would otherwise thread
the same object everywhere.

**No DOM or storage assumptions.** Only `fetch`, `URL` and `crypto` are
required, all substitutable.

### Behavioural fixes

Both were found by the conformance vectors, and both exist in the source
this was extracted from.

**A reasonless service error is no longer reported as an unknown note.**
`{"status":"ERROR"}` with no `reason` had a friendly default substituted
before classification, and that default — "Unknown service error" — matched
the rule for "unknown note". A service that said nothing was therefore
reported as denying the note exists, and through `probeBurnedNote` that
reads as "the burn landed": a conclusion about somebody's money drawn from a
blank. The reason is now carried through exactly as sent, empty included.

**`grossUpForMintFee` returns the true minimum, and cannot be stalled.** It
estimated linearly then walked one msat at a time, bounded by a guard. At a
99.9999% fee the walk is around a million steps, so the guard tripped and
the answer came back non-minimal — and the fee is chosen by the service, so
that input is reachable on purpose. It is now a binary search, which is
exact and bounded for every fee.

**The proportional fee term no longer overflows.** `gross * ppm / 1_000_000`
exceeds 64-bit unsigned at realistic amounts — 21M BTC is 2.1e15 msat, times
999_999 ppm is about 2.1e21 — and exceeds a double's exact range too. It is
computed split. This changes nothing in TypeScript at ordinary amounts, and
matters a great deal to the ports.

### Additions

**A mutation naming no note is refused** before it reaches the network,
rather than sent as a callback with no `k1` for a service to interpret
generously.

**`mint@localhost:8000` resolves.** A Lightning Address needs a dot to be a
domain, so a bare local host was rejected even though the resolution below
it already handled the port and the cleartext scheme such a host needs. The
strict `isLightningAddress` is unchanged; only the resolvers are more
generous, and only for hosts that are already treated as insecure.
