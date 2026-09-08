# Image-proxy origin policy

**Decision owner:** T08 / S02.  This is the contract for the later T09–T12 implementation. It is intentionally deny-by-default: an image-looking URL, a cached value, a provider search result, an import, or an uploaded-file record is not itself authority for server-side egress.

## Scope and non-goals

This policy governs every outbound image connection made by:

- `GET /api/cards/images/proxy?url=...` (the generic remote-image proxy); and
- `GET /api/cards/images/mpc?...` (the server-owned MPC/Drive candidate fetcher).

It applies before the initial connection and before **every** redirect connection. It does not authorize Scryfall API, deck-import, or MPC-search API calls; those have separate transport contracts. It also does not make a remote URL an acceptable user-upload mechanism: uploads remain bytes admitted by their dedicated upload boundary, never URLs fed into `/images/proxy`.

The server must disable the HTTP client's automatic redirects and own redirect handling. All failure cases below are a `400` (bad client URL) or `502` (provider/redirect/DNS/download failure) with no cache publication.

## Chosen egress origins

An origin means scheme, hostname, and effective port. Matching is exact after standard URL hostname canonicalization/lowercasing; it is **not** a suffix match and does not accept a wildcard, a registrable-domain match, a CNAME name, or an IP literal.

| Route | Allowed initial/final HTTPS origin | Allowed request shape | Evidence and purpose |
| --- | --- | --- | --- |
| `/images/proxy` | `https://cards.scryfall.io` | Closed Scryfall rendition path and numeric cache-buster query grammar defined below. | Scryfall `image_uris` are preserved by the client and server (`client/src/helpers/scryfallApi.ts:85-101`; `server/src/routes/streamRouter.ts:22-75`; `server/src/routes/scryfallRouter.ts:537-560`). Checked-in fixtures use `https://cards.scryfall.io/png/front/...png`. |
| `/images/proxy` (legacy MPC thumbnails only) | `https://drive.google.com` | Only `/thumbnail` with a non-empty Drive `id` and a `sz` value matching the checked-in `w400-h400` or `w800-h800` forms. No `/uc`, `/open`, `/file`, or arbitrary Drive path through the generic proxy. | The checked-in MPC preference defaults contain these thumbnail URLs (`client/tests/fixtures/mpc-preference-defaults.v1.json`). `mpcVisualPreference.ts:30-75` currently sends candidate thumbnail URLs to `toProxied`; that exact admitted request form remains supported without a caller migration. |
| `/images/mpc` only | `https://drive.google.com` | Server-constructed `/uc` requests only: `export=download` or `export=view`, a validated MPC/Drive identifier, and optional literal `confirm=t`. | The only production constructors are `server/src/routes/imageRouter.ts:586-592`. |
| `/images/mpc` only | `https://img.mpcautofill.com` | Server-constructed `/{validated-id}-(small|large)-google_drive` paths only. | The only production constructors are `server/src/routes/imageRouter.ts:593-596`. |

No other origin is allowed. In particular, do **not** add `*.scryfall.io`, `*.google.com`, `*.googleusercontent.com`, `*.mpcautofill.com`, generic Google CDN hosts, `localhost`, a LAN host, an RFC1918 address, a metadata endpoint, or a user-configured arbitrary origin.

### Closed Scryfall request grammar

T09 accepts only a pathname of the form `/{rendition}/{face}/{hex}/{hex}/{uuid}.{extension}`. Rendition is exactly `png`, `large`, `normal`, `small`, `border_crop`, or `art_crop`; face is `front` or `back`; each directory hex is one lowercase hexadecimal digit. UUID is the lowercase hexadecimal `8-4-4-4-12` form. The two hex directories must equal the UUID's first and second characters. Extension is `png` for the `png` rendition and `jpg` for the other renditions. No extra segments, escaped characters, traversal, backslashes, or trailing slash are admitted. Query is either absent or a single raw decimal cache-buster token of 1–20 digits, as in `?1562820261`; named parameters, separators, percent escapes and an empty `?` are rejected. Fragment is always rejected. These rules apply identically after redirect resolution. Fixtures must use valid full provider paths rather than ellipsis placeholders.

Google/MPC identifiers use the closed ASCII alphabet `[A-Za-z0-9_-]`, length 1–200; reject extra or duplicate query keys. Thumbnail queries have exactly `id` and `sz`; constructed Drive download queries have exactly `id`, `export` and optionally `confirm=t`. There are no authorized cross-origin redirect pairs in this initial policy: even two individually admitted origins cannot redirect to each other. Same-origin redirects must still satisfy the route's complete template.

### Unsupported or unverified providers

The code currently has a generic `toProxied` helper and stores `sourceUrl` strings without origin admission (`client/src/helpers/imageProcessing.ts:12-27`, `client/src/helpers/dbUtils.ts:87-120`). That is evidence of an unsafe transport shape, **not** evidence that every possible stored or user-supplied URL is a supported provider.

The following are not allowlist candidates on current repository evidence:

- URLs in mocks/tests such as `example.com`, `mpc.test`, or `source.test`;
- arbitrary `smallThumbnailUrl`/`mediumThumbnailUrl` values returned by a future MPC provider;
- custom cardbacks, browser blob/data URLs, restored backup records, shares, and arbitrary URLs entered through tampered client state;
- Archidekt/Moxfield deck URLs and their API hosts; importing a deck does not authorize image proxying from that host;
- a Google Drive redirect target whose exact origin is not listed above. No network probe was performed for this decision, so a broad Google redirect allowance would be unverified and unsafe.

If a provider needs an image origin, it must use the extension process below and receive its own exact origin and request template. A failed legacy URL must surface as an unsupported source; it must not fall back to unrestricted proxying.

## URL admission rules (T09)

Apply these rules to the decoded query value before cache lookup, filename/key generation, logging of a target, DNS resolution, or a transport call:

1. Accept exactly one non-empty string. Decode once only as supplied by the framework; malformed percent encoding, arrays, and double-decoding ambiguities are rejected.
2. The initial `/images/proxy` target must be an absolute `https:` URL. `http:`, `file:`, `data:`, `blob:`, `javascript:`, `ftp:`, protocol-relative (`//...`), and all relative paths are rejected.
3. `username` and `password` must both be empty. Reject `user@host`, encoded userinfo, and host-confusion forms such as `https://cards.scryfall.io@evil.example/`.
4. The hostname must be one exact hostname in the route-specific table. It must not be an IPv4 or IPv6 literal. The only network port is canonical HTTPS port 443: accept omitted port or explicit `:443` after URL canonicalization; reject any other explicit port.
5. Enforce the route-specific path/query templates in the table. Fragments are rejected, rather than silently ignored, so cache keys and audited targets are unambiguous. Duplicate security-significant query keys (`id`, `export`, `confirm`, `sz`) are rejected.
6. `/images/mpc` does not take an upstream URL. It accepts a separately validated identifier and a closed `size` enum; the server constructs the allowed URL itself. Do not convert a Drive URL, thumbnail URL, or arbitrary candidate URL into a generic proxy request.

### Relative/internal routes

`/images/proxy` accepts **no** relative route. The current localhost rewrite of an arbitrary leading-slash path in `server/src/routes/imageRouter.ts:517-520` must be removed in T09.

There is no need for a proxy exception for built-in cardbacks: the production client already uses the fixed local route `/api/cards/images/cardback/{mtg|proxxied|classic-dots}` (`client/src/helpers/cardbackLibrary.ts:29-49`), and the server maps that closed ID set to files (`server/src/routes/imageRouter.ts:661-733`). `toProxied` already leaves `/api/cards/images/...` unchanged. T09 rejects generic relative targets at the server boundary. No supported production caller requiring arbitrary `"/relative.png"` transport was established; these are rejected input, not an unowned caller migration. Existing admitted Scryfall and exact Drive-thumbnail callers remain unchanged. Converting thumbnail callers to MPC identifier routes is optional future work, explicitly outside T09–T12; this policy does not require it for closure.

## Address, DNS, TLS, and redirect rules (T10–T11)

Origin validation is necessary but insufficient. The actual socket address is the authority for SSRF prevention.

### Connection-time address policy

For each hop, resolve the validated hostname immediately before connecting using the resolver that supplies the connection. Validate every A and AAAA answer and fail closed if the answer set is empty or contains any prohibited address. Connect only to a validated, pinned returned address; do not validate with one lookup and then let the HTTP library perform another lookup. Use the original validated hostname as TLS SNI and certificate hostname verification name.

Reject:

- unspecified, loopback, link-local, private, shared-address-space, carrier-grade NAT, benchmark, documentation, multicast, reserved, and otherwise non-global IPv4 ranges; this includes `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.0.0.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `224.0.0.0/4`, and the documentation blocks;
- IPv6 unspecified/loopback, link-local, unique-local, multicast, documentation, and other non-global/special-purpose ranges; this includes `::/128`, `::1/128`, `fe80::/10`, `fc00::/7`, `ff00::/8`, and `2001:db8::/32`;
- IPv4-mapped, IPv4-compatible, 6to4, NAT64, or other IPv6 transition addresses when their embedded IPv4 address fails the IPv4 rule; and
- scoped IPv6 literals, DNS answers that cannot be parsed as an address, and any address family the connector cannot pin and validate.

Maintain the concrete special-purpose range classifier from current IANA registries in code rather than treating the examples above as the entire deny list. The positive condition is global, publicly routable unicast, not merely “not one of these examples.” Do not use a preflight-only `dns.lookup`, an address allow cache, proxy environment variables, or an HTTP `Host` header as a substitute for this connection-time check. Re-resolve and revalidate for each new connection/hop; do not retain a hostname-only approval across a DNS rebind.

TLS certificate validation stays enabled. A certificate failure, DNS failure, connection race, timeout, or address-policy failure is terminal for that candidate and creates no cache file.

### Redirect policy

- Redirects are disabled in the HTTP client and followed manually at most **three** times total. A fourth redirect fails.
- A `Location` is resolved against the previous validated URL, then undergoes the complete URL admission, exact-origin, path-template, DNS, pinned-connection, TLS, and response-limit policy before any connection to it.
- A relative redirect is permitted only as a redirect representation: after resolution it must still be an allowed absolute HTTPS URL. This does not permit relative input to `/images/proxy`.
- A redirect to any different origin (including another origin in the initial-request table), a prohibited port/userinfo/scheme/path, or a prohibited/resolved-private address is rejected before a socket is opened to that destination. Redirect loops and missing/invalid `Location` values fail. A future reviewed extension must name an exact directional origin/template pair before cross-origin redirects can be enabled.

The current `/images/mpc` implementation uses automatic redirects and `maxRedirects: 5` (`server/src/routes/imageRouter.ts:606-609`); T11 must replace that behavior with this shared, bounded per-hop policy. An unlisted Google redirect destination is intentionally a compatibility failure until separately evidenced and approved.

## Download and cache boundary (T12)

T12 must replace `responseType: "arraybuffer"` and post-receipt Content-Type checks in `/images/proxy` (`server/src/routes/imageRouter.ts:523-538`) with streaming. This policy sets a per-response compressed-byte ceiling of **25 MiB**. It is a hard server-side maximum, not a client preference and not an expandable request parameter.

- Reserve/check the cap before writing each chunk; abort upstream immediately when the next byte would exceed it.
- Stream to an owned, mode-0600 temporary file in the proxy cache filesystem. Validate a permitted image Content-Type before publication (and keep any later magic/decoder validation independent of the header).
- Publish only after a complete successful stream and validation, via an atomic rename. On abort, limit exceedance, disconnect, error, or validation failure, close/delete only that request's temporary file and make no final cache entry.
- T12 owns the single-response cap. Aggregate concurrent disk/memory reservation is deferred to R19 and must compose with, never weaken, this cap.

## Extension and configuration safety

The allowlist is a versioned security policy, not an application feature flag. Configuration may select a reviewed provider spec from a closed built-in set; it may not accept an arbitrary URL, hostname, suffix, CIDR, redirect host, port, or `allowPrivate` switch.

A new provider requires all of the following in one reviewed change:

1. Repository evidence of the production caller and exact provider URL/template, with test fixtures that do not rely on live network access.
2. An explicit exact HTTPS hostname, port 443, route ownership, allowed path/query grammar, identifier grammar (where applicable), and whether it is allowed in generic `/proxy` or only by a server-constructed specialized route.
3. Explicit redirect destinations (also exact origins/templates) or a decision to reject redirects. A provider whose operational redirect host is unknown is not enabled.
4. The same connection-time resolver/pinning, TLS, byte-cap, streaming, cache-publication, observability/redaction, and cancellation behavior as existing providers.
5. Parser, DNS-rebind, redirect, oversize/cleanup, and valid-provider tests added to the corresponding matrix below; security review approval is required before the provider is enabled in a release.

Deployment configuration must be strict, schema-validated, least-privilege, and additive only from those compiled specs: reject unknown keys, duplicate keys, empty entries, wildcards, CIDRs, IP literals, non-443 ports, credentials, and values that expand the built-in policy. It must default to the reviewed built-ins (or a smaller subset), never to `*`. Environment variables and user preference/fixture/backup data cannot add an origin. Logging may record a provider key and canonical origin but must redact query values such as Drive IDs.

## T09–T12 validation matrix

No live network is needed. Use parser, resolver, connector, redirect, stream, filesystem, and cache seams; each deny case asserts that the prohibited transport was never invoked.

| Ticket | Required verification | Pass condition |
| --- | --- | --- |
| **T09** | Table-driven URL-parser tests for allowed Scryfall image URLs; legacy exact Drive thumbnails; `http`, `file`, `data`, `blob`, `javascript`, malformed encoding, arrays, empty input, relative and protocol-relative values, userinfo, lookalike/suffix hosts, IP literals, `:444`, unsupported paths/query shapes, fragment, and duplicate significant query keys. Test `/images/mpc` uses only constructed URLs from valid IDs/sizes. | Valid route/provider forms reach the transport seam; every invalid form is rejected before DNS, cache-key creation, or transport. A pre-policy `"/relative.png"` generic caller is rejected and fixed cardback routes remain direct. |
| **T10** | Stub the resolver/connector with IPv4 loopback, RFC1918, link-local/metadata, CGNAT, documentation, multicast/reserved, IPv6 loopback/link-local/ULA, IPv4-mapped private IPv6, and public control answers. Include multi-answer sets containing one prohibited address and a rebind case where a prior public resolution changes to loopback/private at connection time. | Only an all-public validated answer set can create a connection. Every prohibited/mixed/rebound result creates zero forbidden connections; the actual socket receives the pinned validated address and original hostname remains the TLS verification name. |
| **T11** | Script 301/302/303/307/308 responses: allowed same-origin hops and relative `Location`; redirect to another initially allowed origin, an unlisted host, private-resolving allowed hostname, non-HTTPS URL, userinfo/port violation, malformed/missing location, loop, and more than three redirects. | Each proposed hop is revalidated before connection. Every cross-origin hop is rejected in this initial policy; a rejected destination has zero connection attempts. Valid same-origin chains finish within three redirects and preserve the per-hop address policy. |
| **T12** | Feed a chunked valid image under 25 MiB, an exact-cap boundary, a cap-plus-one response, early upstream failure, non-image type, client abort, and temp-file/rename failure through a stream/filesystem seam. Inspect the cache directory after each failure. | No full response buffer is allocated; over-cap input is aborted before writing excess bytes; only a complete valid response is atomically published; every failure removes its own partial temp file and leaves no corrupt final cache entry. |

## Acceptance record

This decision satisfies T08: it names exact required HTTPS origins, forbids arbitrary local paths, selects no generic relative route, records current client/source evidence and unsupported providers, and defines implementation/test boundaries for T09–T12. Source references and a static structural acceptance result are stored under `.todos/cr-execution/wave2/proxy-policy/`. No application implementation, network probe, or external request is part of T08.
