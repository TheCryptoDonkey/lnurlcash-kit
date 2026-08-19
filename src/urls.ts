import {bech32} from '@scure/base'

// ---- LUD-01 bech32 encoding ----

export const isBech32Lnurl = (data: string): boolean =>
  data.trim().toUpperCase().startsWith('LNURL1')

export const toBech32Lnurl = (url: string): string => {
  const bytes = new TextEncoder().encode(url)
  return bech32.encode('lnurl', bech32.toWords(bytes), 2048).toUpperCase()
}

export const fromBech32Lnurl = (data: string): string | null => {
  const safe = data.trim().toUpperCase()
  if (!safe.startsWith('LNURL1')) return null
  try {
    const decoded = bech32.decode(
      `LNURL1${safe.slice(6)}` as `${string}1${string}`,
      2048
    )
    return new TextDecoder().decode(bech32.fromWords(decoded.words))
  } catch {
    return null
  }
}

// ---- LUD-17 scheme URLs ----

// these hosts (plus .onion) resolve to http:// instead of https://
const INSECURE_HOSTS = ['127.0.0.1', '0.0.0.0', 'localhost']

const isInsecureHost = (host: string): boolean =>
  INSECURE_HOSTS.includes(host) || host.endsWith('.onion')

// The one admission rule every URL a caller fetches must pass, whether it
// came from a scanned or pasted note string or from a SERVICE's own
// response (callback, verify, payLink): https anywhere, http only for the
// deliberate insecure hosts above. Anything else - data:, file:, a bare
// http:// clearnet host - is rejected, so a crafted note cannot answer its
// own informational GET (a data: URL carrying withdrawRequest JSON would
// otherwise mint a self-contained fake "verified" note), and a SERVICE
// response cannot redirect a k1-bearing callback onto cleartext or onto a
// scheme fetch() would interpret some other way.
export const isAllowedServiceUrl = (value: string): boolean => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol === 'https:') return true
  if (url.protocol === 'http:') return isInsecureHost(url.hostname)
  return false
}

export const fromLud17 = (url: string): string => {
  const match = url.match(/^(?:lnurlw|lnurlp|lnurlc|keyauth):\/\/([^/]+)/i)
  if (!match) return url
  const host = match[1]!.split(':')[0]!
  const scheme = isInsecureHost(host) ? 'http' : 'https'
  return url.replace(/^[a-z]+:\/\//i, `${scheme}://`)
}

export const toLud17w = (url: string): string =>
  url.replace(/^https?:\/\//, 'lnurlw://')

// LUD-16: a Lightning Address resolves to its .well-known payRequest URL
export const isLightningAddress = (value: string): boolean =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())

const lnAddressToUrl = (address: string): string => {
  const [name, domain] = address.trim().split('@') as [string, string]
  // the domain may carry a port (mint@127.0.0.1:8000) - the insecure-host
  // check is about the host part only, the same split fromLud17 does
  const scheme = isInsecureHost(domain.split(':')[0]!) ? 'http' : 'https'
  return `${scheme}://${domain}/.well-known/lnurlp/${name}`
}

// A bare mint domain with no local part - either literally bare
// ("mint.example") or with a leading "@" the way some mints display their
// own address, NIP-05 style. Not a general "guess a URL from a hostname":
// it assumes the "mint" username that lnurl-mint itself defaults to, so a
// mint using a different one simply fails to resolve and has to be typed
// out in full. A bare insecure dev host ("localhost:8000", no dot at all)
// is also accepted, so a local mint resolves during development.
const isBareMintDomain = (value: string): boolean => {
  const trimmed = value.trim()
  if (isLightningAddress(trimmed)) return false
  if (/^@?[^\s@/]+\.[^\s@/]+$/.test(trimmed)) return true
  return isInsecureHost(trimmed.replace(/^@/, '').split(':')[0]!)
}

const bareMintDomainToUrl = (value: string): string =>
  lnAddressToUrl(`mint@${value.trim().replace(/^@/, '')}`)

// A local dev address, "mint@localhost:8000". LUD-16 has no notion of it -
// isLightningAddress stays strict, since a host with no dot is not a domain
// name - but pointing a wallet at a mint running on this machine is an
// ordinary thing to want, and the resolution below already handles the port
// and the cleartext scheme such a host needs.
const isLoopbackLightningAddress = (value: string): boolean => {
  const parts = value.trim().split('@')
  if (parts.length !== 2) return false
  const [name, domain] = parts as [string, string]
  if (!name || !domain) return false
  return isInsecureHost(domain.split(':')[0]!)
}

// Narrower than resolveLnurlInput: a mint lookup accepts a bech32 LNURL, a
// Lightning Address, or a bare mint domain, all of which point
// unambiguously at one payRequest with no guessing at scheme or path
// beyond the "mint" username default the bare form assumes.
export const resolveMintInput = (value: string): string | null => {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (isBech32Lnurl(trimmed)) {
    const url = fromBech32Lnurl(trimmed)
    return url && isAllowedServiceUrl(url) ? url : null
  }
  if (isLightningAddress(trimmed)) return lnAddressToUrl(trimmed)
  if (isLoopbackLightningAddress(trimmed)) return lnAddressToUrl(trimmed)
  if (isBareMintDomain(trimmed)) return bareMintDomainToUrl(trimmed)
  return null
}

// The LUD-16 .well-known/lnurlp/{name} path any resolved payRequest URL
// follows, however it got there - an actual Lightning Address, a bech32
// LNURL that decodes to the same convention, or a raw URL. Shared by the
// two helpers below so neither re-derives it from raw input text, which a
// scanned or bech32 URL never carried in the first place.
const LNURLP_PATH_RE = /^(.*\/\.well-known\/)lnurlp\/([^/]+)$/

// LUD-25 mint address (experimental): the withdraw-side mirror of a
// payRequest URL, at .well-known/lnurlw/{name}. Derived from the resolved
// payRequest URL itself rather than guessed from raw input - null for
// anything not at that conventional path, since there is nothing to mirror.
export const mintAddressUrl = (payUrl: string): string | null => {
  let parsed: URL
  try {
    parsed = new URL(payUrl)
  } catch {
    return null
  }
  const match = parsed.pathname.match(LNURLP_PATH_RE)
  if (!match) return null
  return `${parsed.origin}${match[1]}lnurlw/${match[2]}`
}

// The username segment of a resolved payRequest URL ("mint" out of
// .../.well-known/lnurlp/mint) - null for a URL not at that path. Worth
// caching alongside a remembered mint, so a later lookup reconstructs the
// address it was actually reached at instead of guessing mint@<host>.
export const lightningAddressUsername = (payUrl: string): string | null => {
  try {
    return new URL(payUrl).pathname.match(LNURLP_PATH_RE)?.[2] ?? null
  } catch {
    return null
  }
}

// Resolves arbitrary LNURL-ish input (bech32, LUD-17 scheme, Lightning
// Address, plain http(s)) down to a fetchable URL. Every URL-producing
// branch passes isAllowedServiceUrl, so a decoded or pasted URL can never
// smuggle in a non-https scheme or cleartext http to a clearnet host - and
// the LUD-17 branch is re-validated with the URL parser rather than
// trusted from fromLud17's regex host split.
export const resolveLnurlInput = (value: string): string | null => {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (isBech32Lnurl(trimmed)) {
    const url = fromBech32Lnurl(trimmed)
    return url && isAllowedServiceUrl(url) ? url : null
  }
  if (/^(lnurlw|lnurlp|lnurlc|keyauth):\/\//i.test(trimmed)) {
    const url = fromLud17(trimmed)
    return isAllowedServiceUrl(url) ? url : null
  }
  if (isLightningAddress(trimmed)) return lnAddressToUrl(trimmed)
  if (isLoopbackLightningAddress(trimmed)) return lnAddressToUrl(trimmed)
  if (/^https?:\/\//i.test(trimmed)) {
    return isAllowedServiceUrl(trimmed) ? trimmed : null
  }
  return null
}

export const serverOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
