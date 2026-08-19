import {isAllowedServiceUrl} from './urls.js'
import {AmbiguousMintError, RequestRefusedError, ServiceRejectedError} from './errors.js'
import {defaultRandomSecret, type RandomSecret} from './secrets.js'

export type LnurlcashOptions = {
  // Replaces the global fetch. Useful for tests, for a proxy, or for a
  // runtime whose fetch needs configuring (a Tor agent, say).
  fetch?: typeof globalThis.fetch
  // Bounded wait. Without one a hung SERVICE freezes whatever flow called
  // in, forever. Defaults to 30 seconds.
  timeoutMs?: number
  // Refuse to make any request at all. A caller holding notes offline
  // deliberately can set this to be certain nothing reaches the network,
  // rather than trusting that it happens not to.
  offline?: boolean
  // Where replacement note secrets come from. Substitute for a hardware
  // RNG, or for deterministic tests. See secrets.ts.
  randomSecret?: RandomSecret
}

export type ResolvedOptions = Required<Omit<LnurlcashOptions, 'fetch'>> & {
  fetch: typeof globalThis.fetch
}

export const resolveOptions = (options: LnurlcashOptions = {}): ResolvedOptions => ({
  fetch: options.fetch ?? globalThis.fetch,
  timeoutMs: options.timeoutMs ?? 30_000,
  offline: options.offline ?? false,
  randomSecret: options.randomSecret ?? defaultRandomSecret
})

// The single request primitive. Every failure it raises is already
// classified by whether the request could have been processed, which is
// the distinction the rest of the library depends on.
export const lnurlFetch = async (
  url: string | URL,
  options: ResolvedOptions
): Promise<any> => {
  if (options.offline) {
    throw new RequestRefusedError(
      'Offline mode is on - no request was made.'
    )
  }
  if (!isAllowedServiceUrl(url.toString())) {
    throw new RequestRefusedError(
      'Refusing to fetch that URL - only https, or http to a loopback or .onion host, is allowed.'
    )
  }
  let res: Response
  try {
    res = await options.fetch(url.toString(), {
      signal: AbortSignal.timeout(options.timeoutMs)
    })
  } catch (err) {
    // Transport failures are ambiguous for a mutating request: the request
    // may well have arrived, and only the answer was lost.
    if ((err as Error).name === 'TimeoutError') {
      throw new AmbiguousMintError(
        'The service took too long to respond - its answer, if any, was lost.'
      )
    }
    throw new AmbiguousMintError(
      'Failed to reach the service - it may be offline, or may not allow cross-origin requests.'
    )
  }
  const body = await res.json().catch(() => {
    throw new AmbiguousMintError('The service returned an unreadable response.')
  })
  if (body?.status === 'ERROR') {
    // The reason is carried through EXACTLY as the SERVICE sent it, empty
    // string included. Substituting a friendly default here would be read
    // back by classifyNoteError as though the SERVICE had said it: a
    // reasonless error becomes "Unknown service error", which matches the
    // rule for "unknown note" and reports a note as unrecognised on no
    // evidence at all. Via probeBurnedNote that reads as "the burn landed",
    // which is a conclusion about somebody's money drawn from a blank.
    throw new ServiceRejectedError(
      typeof body.reason === 'string' ? body.reason : ''
    )
  }
  return body
}
