export type MintFee = {
  baseFeeMsat: number
  feePpm: number
}

// LUD-25 mint fees (optional). A SERVICE signals what it withholds on
// minting via an extra ["text/plain", "Mint fees: <base_fee_msat>,
// <fee_percent_ppm>"] entry in a payRequest's metadata, so a WALLET can
// warn the payer up front that the note they end up holding is worth less
// than the invoice they paid. A SERVICE that omits the entry is fee-free,
// not unknown.
export const parseMintFee = (metadata: string): MintFee | null => {
  let entries: unknown
  try {
    entries = JSON.parse(metadata)
  } catch {
    return null
  }
  if (!Array.isArray(entries)) return null
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry[0] !== 'text/plain') continue
    const match =
      typeof entry[1] === 'string' &&
      entry[1].match(/^Mint fees:\s*(\d+)\s*,\s*(\d+)\s*$/)
    if (!match) continue
    const baseFeeMsat = Number(match[1])
    const feePpm = Number(match[2])
    // Safe integers, not merely finite: the digits come from a SERVICE and
    // are unbounded in length, and anything past 2^53 makes the fee maths
    // below silently imprecise rather than merely large.
    if (!Number.isSafeInteger(baseFeeMsat) || !Number.isSafeInteger(feePpm)) continue
    // A fee of 100% or more can never net anything. Refusing it here is
    // also what keeps grossUpForMintFee's search bounded, so a SERVICE
    // cannot stall a caller simply by advertising one.
    if (feePpm >= 1_000_000) continue
    // An explicit "Mint fees: 0,0" has exactly the effect of omitting the
    // entry - treat it identically, so callers never have to special-case
    // a fee that is present but withholds nothing.
    if (baseFeeMsat === 0 && feePpm === 0) return null
    return {baseFeeMsat, feePpm}
  }
  return null
}

// The proportional part of a fee, floor(gross * ppm / 1_000_000), computed
// so it cannot overflow.
//
// The obvious gross * ppm is wrong at realistic amounts: 21M BTC is 2.1e15
// msat, and at 999_999 ppm the product is about 2.1e21 - past a 64-bit
// unsigned integer, and past the exactly-representable range of a double.
// Splitting the multiplication keeps both halves small: the quotient half
// reaches at most 2.1e15, the remainder half at most 1e12. Every port of
// this library must do the same, which is why the conformance vectors
// include an amount large enough to catch a naive implementation.
const proportionalFee = (grossMsat: number, feePpm: number): number =>
  Math.floor(grossMsat / 1_000_000) * feePpm +
  Math.floor(((grossMsat % 1_000_000) * feePpm) / 1_000_000)

// What a SERVICE is expected to credit after withholding its advertised
// fee. Floored, since msat are integers. Only ever an estimate to show
// before paying: the authoritative value is whatever the informational GET
// reports once the note has been claimed.
export const applyMintFee = (grossMsat: number, fee: MintFee): number =>
  Math.max(0, grossMsat - fee.baseFeeMsat - proportionalFee(grossMsat, fee.feePpm))

// LUD-25 states the mint fee as `base_fee_msat` plus a ppm cut and says
// nothing at all about rounding. Two live implementations read that
// differently, and both are defensible:
//
//   - dni's lnurl-mint, the reference, and what every public mint on the
//     awesome list except moneyer runs, ceilings the fee to a whole sat on
//     purpose, so the mint is "never short a sat". 1_040 msat becomes
//     2_000.
//   - moneyer withholds the msat-exact amount.
//
// So a wallet predicting one number warns spuriously against the other:
// against lnurl-mint the note lands up to 999 msat lighter than the
// formula says, and telling a holder their mint short-changed them when
// it did exactly what it documents is worse than saying nothing.
//
// The honest prediction is a range. The formula is the most a holder can
// be credited; the sat-ceilinged fee is the least. Until the draft settles
// which is correct (lnurl/luds#301), treat anything inside as compliant.
export type MintFeeBand = {minNetMsat: number; maxNetMsat: number}

export const mintFeeBand = (grossMsat: number, fee: MintFee): MintFeeBand => {
  const exactFee = fee.baseFeeMsat + proportionalFee(grossMsat, fee.feePpm)
  const satCeilinged = Math.ceil(exactFee / 1000) * 1000
  return {
    minNetMsat: Math.max(0, grossMsat - satCeilinged),
    maxNetMsat: Math.max(0, grossMsat - exactFee)
  }
}

// Whether a credited note is consistent with the advertised fee under
// either reading. Use this rather than comparing against applyMintFee: an
// exact match is the best case, not the only compliant one.
export const withinMintFeeBand = (grossMsat: number, netMsat: number, fee: MintFee): boolean => {
  const {minNetMsat, maxNetMsat} = mintFeeBand(grossMsat, fee)
  return netMsat >= minNetMsat && netMsat <= maxNetMsat
}

// The inverse: the SMALLEST invoice amount whose note nets `netMsat` after
// the SERVICE's fee.
//
// applyMintFee is non-decreasing in gross, with per-msat steps of 0 or 1
// (the proportional term grows by at most 1 per msat, since ppm is below
// 1_000_000), so the minimal such gross exists and binary search finds it
// exactly. The tempting alternative - estimate linearly, then walk one
// msat at a time - is both unbounded and wrong at the edge: at 999_999 ppm
// the walk is roughly a million steps, so any guard on it returns a
// non-minimal answer, and a SERVICE picks the fee. Binary search has
// neither problem.
export const grossUpForMintFee = (netMsat: number, fee: MintFee): number => {
  if (netMsat <= 0) return 0
  let hi = netMsat + fee.baseFeeMsat
  while (applyMintFee(hi, fee) < netMsat) hi *= 2
  let lo = 0
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (applyMintFee(mid, fee) >= netMsat) hi = mid
    else lo = mid + 1
  }
  return lo
}

// fee_percent_ppm is parts per million: /10_000 for a percent, then trim
// the trailing zeros toFixed leaves behind (2000 ppm -> "0.2000" -> "0.2")
export const formatFeePercent = (ppm: number): string =>
  (ppm / 10_000).toFixed(4).replace(/\.?0+$/, '')

// parseMintFee collapses a fully-zero fee to null, so by the time one
// reaches here at least one component is set - mention only those that are.
export const describeMintFee = (fee: MintFee): string =>
  [
    fee.baseFeeMsat > 0
      ? `${Math.round(fee.baseFeeMsat / 1000)} sat flat`
      : null,
    fee.feePpm > 0 ? `${formatFeePercent(fee.feePpm)}% of the amount paid` : null
  ]
    .filter(Boolean)
    .join(' + ')
