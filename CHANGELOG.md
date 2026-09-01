# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- A freshness-alert script (`bin/check-explorer-freshness.sh`) for cron that mails the operator when any non-regtest coin is stale-gated or its replica carries an active sync halt.
- The testnet4 tip-gate drop-in (`deploy/tbtc-tip-gates.conf`) is version-controlled: it widens TBTC's future-skew and age gates so a legally future-stamped tip cannot 503 a healthy chain.

## [0.12.0] - 2026-08-30

### Added
- Roll call actions render on the action pages.

### Fixed
- The MariaDB connector moves to 3.5.3, closing three high-severity advisories against the pinned 3.5.2.
- All Activity and the per-block action list show every action, including those that move no ledger entry.
- Price rounds decode on the action detail page instead of rendering as dashes.
- Evictions appear in the unstakes listing.
- The transaction page renders an empty action list rather than reading a hash as an index.

### Changed
- Service logging routes through the shared log shim, one line per console call.

## [0.11.0] - 2026-08-25

### Added
- The bundled consensus pin is verified at API boot, so a host carrying a drifted coin registry halts instead of serving from it.
- The hub-served coin consensus hashes are cross-checked against the local registry, logging a mismatch as a transport-integrity signal.
- Mempool data is read live from each coin's decoder API when an endpoint is configured, so explorers serving from synced replicas can show pending transactions.
- The network API and homepage report the node's total unconfirmed count beside the XChain unconfirmed count, linked to the mempool page.
- The status endpoint says why the indexer trails and when the wait clears, so a deliberate pause for a block stamped in the future is no longer indistinguishable from a stuck indexer.

### Changed
- The mempool page uses the same Block / Time / Action / Details columns as history, showing when each pending action was first seen.
- Updated the BTC mainnet validator reward pool address.
- Moved the BTC, LTC and DOGE testnet genesis start points forward to just under the live chain tip and regenerated the consensus pin, so the public testnet launches with no pre-announcement test history.

### Fixed
- The icon resolver now only treats a TIS data_ref as a reference when it matches the on-chain action grammar, so attacker-chosen token metadata can no longer swap in a different cached image or leave an icon permanently unresolved.
- A malformed or repeated pagination start parameter no longer breaks the request; it now falls back to the beginning of the list instead of erroring.
- Mempool counts and feeds now include only action-carrying rows, instead of every pending transaction the node's mempool holds.
- Cumulative log-shipper metrics are now registered as counters instead of gauges, so rate-based monitoring queries over them are no longer undefined.

## [0.10.0] - 2026-08-18

### Added
- New State Checkpoints, Price Rounds, Contract Delegations, Coinpay Settlements and Coinpay Obligations pages, each linked from the menu.
- A checkpoint detail page showing its roots and signers, with signature verification behind a button.
- The Fees page now shows the live gas schedule and can request a fee quote.
- SPV proof widgets on the address, action, validators and contract pages.
- A public API route for a single state checkpoint.
- New Actions, Mempool, Order Matches and Swap Matches pages, each linked from the menu.
- Public API routes for block lists, search, and project rosters, which previously only the site's own pages could reach.
- File lookups by name, and a matching database index.
- History rows now name the BATCH they belong to, so clients can group a batch's actions.
- The lists API returns the LIST memo.
- Detail pages for validators, XCALLs, attestations, polls and anchors, with the composition endpoints behind them, so records the explorer already listed can be read whole.
- Seven read surfaces for platform data that had none: contract emissions per contract, vote delegations, per-validator attestation counters, the historical capability electorate, reorg history, anchor reward attestations, and a per-block commitments section.
- A slash proposals page and API, presenting each row as a labelled unadjudicated accusation rather than a verdict, and failing loud instead of rendering an empty table when the hub cannot be reached.
- A staking panel on the address page with positions, cooldown countdowns, the reward and COLLECT trail, and both slash families; it hides itself on an address with no staking activity.
- The explorer's visual decisions live in a loadable theme token file, with theme directories served as static assets.
- The OpenAPI spec spells out the two-form search contract.

### Changed
- The escrow locked-balance leaf is armed on testnet from genesis, keeping the client's activation constant level with the fleet; mainnet is unchanged.
- The contract state sub-root is armed from genesis on every testnet, matching the indexer twin; mainnet is unchanged.
- Project banners on token pages now span the full content width below the Token and Market Information cards, and a project's official-token count moved from a table row into an ownership banner there.
- The Data menu's categories are reordered so each row's columns are similar heights, with green section headers and more space between rows.
- Font Awesome is now self-hosted from the bundled Free package at `/fontawesome`, so icons work on every deployment with no CDN, account, or configuration.
- Six Pro-only icon names were replaced with Free equivalents, enforced by a new unit test.
- The Content Security Policy allows Cloudflare's RUM beacon so proxied deployments load without console errors.

### Removed
- The Font Awesome kit route, the vendored kit loader, and the `EXPLORER_FONTAWESOME_*` environment variables.

### Fixed
- The Actions, Order Matches and Swap Matches feeds returned rows their pages could not render; a new test requires every registered feed to have a row mapping and forbids orphaned mappings.
- Checkpoint lists could not page past a fixed window on long chains, and the public checkpoint endpoint grouped the whole table with no bound; both now share one query that needs neither.
- A project lookup returned its ticker in upper case, so the value it handed back did not work when used again in a URL.
- The checkpoint detail page showed "not found" for checkpoints that exist, because it never received the block height from the URL; a new test pins every detail route against the list of types the client reads.
- The checkpoint detail page also misread the response shape of single-record API routes.
- Coinpay obligations showed their expiry as a block link, when the value is a timestamp.
- The checkpoint, checkpoint-range, checkpoint-verify and balance-proof routes ran at the platform-wide request cap instead of a proof-tier one.
- The fee schedule and the two fee-quote routes ran uncapped, now that a page can call them.
- The Coinpay feeds returned rows the page could not render, because neither had a row mapping.
- The Swap Matches route served the Swaps page, and the Markets route was declared twice.
- The Cross-Chain Matches page requested a misspelled endpoint and always rendered empty; a new test pins every page's endpoint to a registered route.
- The mempool endpoint returned nothing unless filtered by address or token.
- The API reference omitted the contract-call endpoint, because its generator and coverage test only understood GET routes.
- A token whose icon is named by an on-chain scheme is resolved instead of being marked permanently icon-less, and the re-stale predicate that reaches those rows no longer selects descriptions the resolver rejects, which had let attacker-chosen text re-stale forever.
- One shared summary projection feeds transaction rows, history rows and BATCH members, so a field lands on every surface at once, and a settled swap shows its terminal state.
- `/api/status` no longer clamps an unknown decoder lag to zero and reports a synced signal it cannot support.
- DESTROY detail reads one row per leg, LIST detail reads the memo column the feed already reads, and the mempool window is ordered and window-aware so a saturated read cannot emit false removals.
- The hub-config delta consumer refuses a regressed watermark.
- The validator detail route was missing from the client's query allowlist, so an existing validator rendered as "not found"; the route guard now covers every detail page instead of only the checkpoint one.
- The XCALL lifecycle and the slash row shape render from valid rows on both pages, and a vote poll's finalization detail renders.
- A missing hub method is reported as its own error rather than as an outage.
- The market counter-tick resolves instead of printing undefined.
- Mirror push generation is fenced against being lowered.
- Code-review round fixes across the API and UI (two rounds, 21 files).
- SIGTERM drains rather than dropping in-flight requests.

### Security
- Raised the brace-expansion and js-yaml dependency floors and the advisory guards that pin them.

## [0.9.0] - 2026-08-14

First release of the XChain Platform release train. Every component in the train
now shares one platform version, so "XChain 0.9.0" names an exact, reproducible
set of software rather than a rough era.

### Changed
- Adopted the platform version stream. This component moves from `1.15.5` to
  `0.9.0`. **The number is lower but the release is newer**: the platform stream
  starts at 0.9.0 for the testnet series, and 1.0.0 is reserved for mainnet.

<!-- ------------------------------------------------------------------------
     Versions BELOW this line are this component's own legacy stream, from
     before the release train. They are kept for history and are NOT comparable
     to the platform versions above: a higher legacy number is an older release.
     ------------------------------------------------------------------------ -->

## [1.15.5] - 2026-08-13

### Fixed
- Oracle-price and price-snapshot reads now resolve through the mandatory checkpoint schema, since both tables are hub-mirror only and never replicate to a serving node.
- A BATCH feed member no longer hands raw attacker-supplied base64 to the action-detail renderer.
- The cross-chain call barrier now carries its own grace margin instead of borrowing the match margin under a comment that misdescribed the producer pattern.
- Status now drops a coin whose newest indexed block breaches the staleness wall clock, returning 503 COIN_DATA_STALE distinct from COIN_NOT_AVAILABLE.
- The checkpoint verifier now mirrors the SDK's fail-closed guard, so a post-flag-day rootless checkpoint no longer verifies.
- ATTESTATION_REQUEST and ATTESTATION_RESPONSE joined VALID_TYPES, so narrowing the attestation channel by phase no longer rejects the whole subscribe.
- Raw gated-file, checkpoint-response and checkpoint-range OpenAPI operations now describe their real request params and response envelopes instead of inheriting generic defaults.
- Stake-weighted quorum now rejects a validator entry with a missing or non-numeric weight instead of lowering the quorum denominator.
- BET oracle fees now render as oracle fees rather than a protocol-fee object.
- The WebSocket ticks subscription filter no longer silently no-ops on the actions channel.
- Corrected a protocol-constants header that claimed a cross-repo tripwire which does not exist.
- Added a lint over the generated golden statements for the unstable-hotspot renderer.
- Lockfile engines.node now matches the manifest ceiling, so a reinstall cannot silently resolve on an unsupported Node version.
- DISPENSER action detail now honours the list-edit delay, so allow/block-list changes stay withheld until the delay elapses instead of reading as instantly active.
- ANCHOR action detail now renders the elected publisher and the publisher-attestation quorum for reward-derivation anchors, which were persisted but never selected or displayed.
- WS subscribe params.fields is now validated, finality defaults read the vendored coin registry, and the checkpoint parity guard escalates under required siblings.

### Added
- Armed the three BTC-anchored activation copies (checkpoint commitment, EQUIV header, stake-weighted quorum) in lockstep with the indexer/hub twins.
- Contract page renders the full on-chain source with syntax highlighting, a server-verified hash badge, copy button, extracted method list, and constructor params.
- Added a read-only contract simulation endpoint (sandboxed, default off) with a Read Contract UI on the contract page.
- getContract now serves the contract's declared ABI block plus a wallet handoff target.
- Write Contract card: per-method forms whose Open in Wallet button deep-links into the wallet.
- Hub connector now sends an API key when configured.
- Added a self-synced hub-mirror mode: the explorer can maintain its own local copy of the hub-mirror tables, removing the hard requirement for a co-located hub DB.
- Validator-capability and governance pages now read over hub JSON-RPC with a short TTL cache, falling back to the legacy co-located schema when no hub endpoint is configured.
- Added a mirror staleness surface with a status endpoint, lag annotations, and opt-in fail-closed lag gating.

### Fixed
- Vendored hub-mirror client re-synced: self-synced mirrors now converge correctly when the hub re-broadcasts its ANCHOR back-fill.
- The WebSocket server now uses a shared BigInt-safe stringifier so catch-up/replay messages carrying BigInt DB columns no longer throw and get silently swallowed at the socket boundary.
- Dispenser, order, and swap queries now keep the paging cursor column last; the client's fixed-index reads were realigned to match.
- getConfig on an unknown network again returns the chain identity with an empty address map instead of throwing.

## [1.15.4] - 2026-07-16

### Fixed
- proofServer now routes checkpoint authoring through the shared stake-weighted quorum predicate, fixing an authoring-side quorum collapse.
- WS TOKEN_UPDATE now spreads the full token info so its shape matches SNAPSHOT.
- getActionDetails now renders compact summaries for every action type, with a humanized-name fallback so no action type renders blank.

## [1.15.2] - 2026-06-20

### Added
- Status now reports indexer sync position alongside the existing block index map.
- Added a configuration template enumerating every environment variable the explorer reads, with safe defaults and inline comments.
- Each per-coin database connection pool now sets a query timeout to prevent hung connections on slow or lock-blocked queries.
- Status now surfaces the chain-to-decoder pipeline gap per coin, polling each decoder's health check in parallel.
- Closed six REST exposure gaps, including new cross-chain match/settlement endpoints and a contract delegations list endpoint.
- Status now reports hub-config fetch time and age so operators can detect a stale hub-config cache.
- The stakes/validators list-page projection now carries stake lifecycle fields without per-row detail fetches.
- Message read paths now expose the destination coin so cross-chain messages are distinguishable in every API response.
- The validators list query now selects stake lifecycle fields, matching the stakes list query.
- Status now reports decoder tip and lag per coin so a stalled indexer is visible from the status surface.
- Fee queries now select the unified-gas columns added for the newer fee version.
- The DISPENSER action-detail query now resolves and exposes the address that triggered a cancellation.
- Added full explorer coverage for PRICE actions, including list/detail queries and REST endpoints.
- Block queries now join and resolve the contract hash alongside the existing hashes.
- The ATTEST list/stream surface now exposes the resolved fee payer across every read path.
- The ATTEST query surface now exposes payload and callback params across every reading query.
- Every ADDRESS read path now exposes the dispenser ownership preference in the list query, action detail, history projection, and web UI.
- Every dispenser query now resolves and exposes the oracle address backing a fiat-priced dispenser.
- Added a README operator note documenting columns that standalone databases must add before deploying this build.

### Changed
- Extracted the inline gated-files raw query from the route layer into a named accessor.
- Pinned the MariaDB driver to an exact version for byte-identical installs across operator nodes.
- Pinned mathjs to an exact version to keep consensus-relevant bignumber math identical across services.
- Renamed two internal handler methods to match SDK counterparts.
- Migrated the rate-limit config from a deprecated option to its canonical replacement.
- The hub connector now polls incrementally using a watermark, transferring only the changed delta instead of a full config tree every cycle.
- The hub connector now understands the hub's updated response shape and records a sequence number for change detection.
- The API rate limit is now tunable via an environment variable.
- Aligned the MariaDB driver range used across the platform.
- Aligned mutation-testing dev dependencies to restore a single platform-wide baseline.
- When every hub endpoint is unreachable on a config-refresh tick, the config loader now logs an error before serving the last-known-good cache.
- Dependency installs are now reproducible: the lockfile is committed and the Docker image installs from it.

### Fixed
- The client-side address validator now performs full checksum verification instead of checking string length alone.
- Two action-detail branches now return real settlement fields instead of an empty shell.
- The hub connector now records per-endpoint failure detail for operator-facing diagnostics without changing its return contract.
- The hub connector no longer treats a reachable-but-degraded hub as unreachable.
- The WebSocket WELCOME message now advertises the attestation global channel, matching what the server actually accepts.
- The periodic hub config refresh now starts after the explorer instance is fully initialized so its config-changed listener is registered before the first tick fires.
- The hub JSON-RPC client now starts each endpoint pass at the last responder instead of always starting from the first endpoint.
- Icon, raw-file, and relay error responses now return a consistent JSON error envelope matching every other explorer endpoint.
- Fee-quote and fee-schedule error responses now return the standard error envelope only, dropping extra flags that appeared on no other error response.
- DISPENSER list-edit activation status is now derived from the latest indexed block time instead of the host's wall clock, matching the indexer's consensus check exactly.
- Updated the integration-test schema fixture to match the current indexer schema.
- The SWEEP transaction-detail query now selects the correct per-primitive flags instead of a removed column.

### Removed
- Removed a no-op dependency that Node's built-in module always overrides.

### Security
- The checkpoint verify endpoint now reflects stake-weighted quorum when active instead of a simple count-based quorum.
- Pinned a dependency to exclude versions affected by two denial-of-service advisories.
- Pinned another dependency to exclude a version affected by an XSS advisory.

## [1.15.1] - 2026-05-28

### Removed
- Removed a stray debug log call from the explorer web UI client script.

## [1.15.0] - 2026-05-28

### Added
- The hub connector now retries the hub endpoint pass with configurable exponential backoff so the explorer survives startup races when the hub is still booting.
- Successful hub configs are now persisted to a local cache; when the hub is unreachable at startup, the explorer loads this cache and starts in degraded mode instead of coming up with zero coins.
- Added a restart policy for the explorer service in the Docker Compose file.
- Added unit tests covering hub-unreachable startup, disk-cache fallback, sync-tick error handling, and connector retry behavior.

### Fixed
- A hub outage during the periodic config sync tick no longer raises an unhandled promise rejection; it now logs a warning and keeps serving the in-memory config cache.
- A transient hub blip during a sync tick no longer tears down a working in-memory config.

## [1.14.0] - 2026-04-07

### Added
- Added an endpoint to look up the public key for an address from the decoder database.
- Added a database method for querying the decoder's public-key table.

## [1.13.1] - 2026-04-06

### Changed
- Moved the coverage badge to its own line in the README for cleaner formatting.

## [1.13.0] - 2026-04-06

### Added
- Added VM contract endpoints and explorer routes.
- Added deposit/withdrawal endpoints and explorer routes.
- Added staking/validator endpoints and explorer routes.
- Added HTML pages for contracts, contract detail, executions, execution detail, deposits, withdrawals, and validators.
- Added twelve new database query methods for the new table types.
- All new endpoints follow the existing SDK-compatible paths and explorer route pattern.

## [1.12.1] - 2026-04-05

### Changed
- Moved the mutation-test config into the test directory.
- Updated the mutation-test npm scripts to reference the new config path.

## [1.12.0] - 2026-04-03

### Added
- Added a WebSocket API for real-time event streaming.
- Added the WebSocket server modules powering it.
- Added channel-based subscriptions with per-client filters.
- Added batch entity subscriptions.
- Added order lifecycle events.
- Added swap lifecycle events.
- Added dispenser lifecycle events.
- Added entity update events.
- Added a welcome message with server info, latest indexes, limits, and supported channels.
- Added a subscription confirmation with echoed request ID and resolved filters.
- Added reconnect catch-up with a completion event.
- Added snapshot-on-subscribe for balances, token info, market data, and dispenser state.
- Added client rate limiting, per-IP connection limits, and backpressure detection.
- Added a two-tier idle timeout: short for zero-subscription clients, none for subscribed clients.
- Added structured WebSocket logging.
- Added a frontend WebSocket client with auto-reconnection, catch-up, and a connection status indicator.
- Added the database queries the WebSocket layer needs.
- Added unit tests for the WebSocket modules.
- Added an npm script for running WebSocket tests.
- Added WebSocket configuration environment variables.
- Updated the content security policy to allow WebSocket connections.

## [1.11.0] - 2026-04-02

### Added
- Added API and explorer endpoints for COINPay data.
- Added database query methods with address/block search support.
- Added custom WHERE and offset handling for obligation address searches.

## [1.10.0] - 2026-04-02

### Added
- Added a comprehensive regression test suite across three priority tiers.
- Added regression test infrastructure reusing integration DB setup.
- Added the regression npm scripts.

## [1.9.0] - 2026-04-02

### Added
- Added a chaos engineering test suite across five failure categories.
- Added chaos test infrastructure with a fault-injecting proxy.
- Added the chaos npm scripts.

## [1.8.0] - 2026-04-02

### Added
- Added mutation testing infrastructure targeting the core modules.
- Added mutation-killing unit tests for the utility module.
- Added mutation-killing unit tests for the database module's cache helpers.

### Changed
- Improved the utility module's mutation score substantially.
- Increased the total unit test count.

## [1.7.0] - 2026-04-01

### Added
- Added a performance test suite using a load-generation tool.
- Added performance seed data with blocks, transactions, actions, and assorted records.
- Added an npm script for the performance suite.
- Added a batch order-info lookup method to eliminate a query-count blowup in the orderbook.
- Added LRU cache helpers for immutable data caching.

### Fixed
- Refactored the query runner to manage its own connection lifecycle locally, eliminating a race condition where concurrent requests could clobber each other's database connections.
- Increased the connection pool limit to support concurrent traffic.
- Replaced a per-block query loop with a single batched query.
- Replaced a per-order lookup loop with a single batched lookup.
- Parallelized independent count queries in search.
- Replaced an offset-multiplication pagination pattern with proper SQL OFFSET so high-page requests no longer fetch all preceding pages.
- Added LRU caches for repeat immutable lookups.

## [1.6.0] - 2026-04-01

### Added
- Added a security test suite across six files.
- Added a utility function for defense-in-depth integer validation.
- Added an npm script for the security suite.

### Fixed
- Parameterized offset SQL values to prevent SQL injection via string concatenation.
- Disabled redirect-following on the relay handler to prevent redirect-based SSRF bypass of the IP blocklist.
- Removed a custom version header and a redundant CORS header, and gated runtime/debug logging behind a debug flag.
- Gated database/SQL error messages behind a debug flag; production logs show generic messages only.
- Added an explicit request-body size limit.
- Changed trust-proxy handling to trust only the first hop, preventing header spoofing.
- Added a whitelist check for dynamically constructed table names.

## [1.5.0] - 2026-04-01

### Added
- Added a boundary test suite across seven files.
- Added a boundary seed fixture with edge-case token supplies.
- Added the boundary npm scripts.

### Fixed
- Clamped API pagination parameters to safe ranges to prevent negative SQL LIMIT errors and unbounded queries.
- Escaped LIKE wildcard characters in search input to prevent wildcard injection.
- Extended the SSRF blocklist to cover IPv6-mapped IPv4, IPv6 link-local, and decimal IP patterns.
- Fixed a falsy-zero bug in offset SQL generation so a zero action index correctly generates offset clauses.
- Added a finite-number guard on parsed offset values for defense-in-depth.

## [1.4.0] - 2026-04-01

### Added
- Added an end-to-end test suite across four files.
- Added an E2E seed fixture with large-integer tokens, sum-verification tokens, and multi-action blocks.
- Added an E2E database setup helper reusing integration test infrastructure.
- Added an npm script for the E2E suite.

## [1.3.0] - 2026-04-01

### Added
- Added a smoke test suite across six files, split between dependency-free unit checks and checks that need a live database.
- Added the smoke npm scripts.

## [1.2.0] - 2026-04-01

### Added
- Added an integration test suite covering actions, single-item endpoints, status/network, markets, paging, error handling, response format, pagination boundaries, and special endpoints.
- Added test infrastructure: a Docker Compose test database, schema from the indexer DDL, and baseline seed data.
- Added shared app/database lifecycle test helpers.
- Added an HTTP assertions dev dependency.
- Added the integration npm scripts.

## [1.1.0] - 2026-04-01

### Fixed
- Fixed a duplicate method definition in the database module where one definition silently overrode the other.
- Fixed a 503 response for unsupported coins that was being overwritten to 400 by a subsequent null-data guard.
- Fixed an IPv6 SSRF bypass in the relay handler where bracket-wrapped loopback addresses were missed.
- Fixed a no-op pagination cap that was immediately overwritten by a later calculation.

### Added
- Added a comprehensive unit test suite across twelve files.
- Added test fixtures for mock configs, database results, and query argument factories.
- Added test framework dev dependencies.
- Added the core npm test scripts.
