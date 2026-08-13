# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
