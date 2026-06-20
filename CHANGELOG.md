# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [1.15.2] - 2026-06-20

### Added
- `/{COIN}/api/status` now reports indexer sync position: `getStatus()` returns a `last_block_time` map alongside the existing `last_block` index map.
- `.env.example`: added a configuration template enumerating every environment variable the explorer reads, with safe defaults and inline comments.
- `src/db.js`: each per-coin MariaDB connection pool now sets `queryTimeout` (default 30s, override via `DB_QUERY_TIMEOUT`) to prevent hung connections on slow or lock-blocked queries.
- `src/XChainDecoderConnector.js` (new), `src/db.js`: `/{COIN}/api/status` now surfaces the chain-to-decoder pipeline gap via per-coin `chain_tip`, `chain_lag_blocks`, and `decoder_health` maps, polling each decoder's `health()` JSON-RPC in parallel.
- `src/db.js`, `src/XChainExplorer.js`: closed six REST exposure gaps: added `order_matches.settlement_type`, `attests.response_payload`, `tokens.escrow_action_index`, `delegations.activation_block`/`deactivation_block`, a new `getContractDelegations()` list endpoint, and `cross_chain_matches`/`cross_chain_settlements` endpoints.
- `src/config.js`, `src/db.js`: `/{COIN}/api/status` now reports `hub_config_fetched_at` and `hub_config_age_seconds` so operators can detect a stale hub-config cache.
- `src/XChainExplorer.js`: the stakes/validators list-page row projection now carries `activation_block` and `deactivation_block`, completing the path so list-page consumers see stake lifecycle without per-row detail fetches.
- `src/db.js`, `src/content/json/xchain-platform-api.json`: both MESSAGE read paths now expose `coin` (the destination network) so cross-chain messages are distinguishable in every API response.
- `src/db.js`: the validators list query (`getValidators()`) now selects `activation_block` and `deactivation_block`, matching the stakes list query so list callers see complete stake-lifecycle data.
- `src/db.js`: `/{COIN}/api/status` now reports `decoder_tip` and `decoder_lag_blocks` per coin so a stalled indexer is visible from the status surface.
- `src/db.js`: fee queries (`getFees` and `getActionFeeData`) now select the unified-gas columns (`gas_cost`, `gas_price`, `xchain_amount`, `payment_mode`, `native_coin_amount`, `native_coin`, `oracle_round`, `fee_preference`, `fee_version`) added for `fee_version=2`.
- `src/db.js`, `test/integration/fixtures/schema.sql`: the DISPENSER action-detail query now resolves and exposes `cancelled_by`, the address that triggered a cancellation.
- `src/db.js`, `src/XChainExplorer.js`: full explorer coverage for PRICE actions via `getPrices()`, `getPriceSnapshots()`, a `PRICE` branch in `getActionData()`, and REST endpoints `/{COIN}/api/prices` and `/{COIN}/api/price_snapshots`.
- `src/db.js`, `test/integration/fixtures/schema.sql`: `getBlock()` and `getBlocksSince()` now join and resolve `contract_hash` alongside the existing `ledger_hash`/`actions_hash`.
- `src/db.js`, `src/XChainExplorer.js`: the ATTEST list/stream surface now exposes `fee_payer` (resolved from `attests.fee_payer_id`) across all three list-path queries and the WebSocket feed.
- `src/db.js`, `src/XChainExplorer.js`: the ATTEST query surface now exposes `payload` and `callback_params_json` across all four `attests`-reading queries.
- `src/db.js`, `src/XChainExplorer.js`, `src/content/{js/xchain.js,html/action.html,json/xchain-platform-api.json}`, `test/integration/fixtures/schema.sql`: every ADDRESS read path now exposes `dispenser_preference` (owner-only vs. anyone) in the list query, action detail, history projection, and web UI.
- `src/db.js`: every dispenser query now resolves and exposes `oracle_address` (the PRICE v1 oracle backing a fiat-priced dispenser) across `getDispensers()`, `getDispenserCloses()`, and all five dispenser branches of `getActionData()`.
- README operator note documenting the `give_ownership`/`get_ownership` columns on `orders` and `swaps` that standalone databases must add before deploying this build.

### Changed
- `src/db.js`, `src/XChainExplorer.js`: extracted the inline `gated_files` raw query from the route layer into a named `getGatedFileRaw()` accessor in `db.js`.
- `package.json`: pinned `mariadb` to exact `3.5.2` (dropped `^`) for byte-identical installs across operator nodes.
- `package.json`: pinned `mathjs` to exact `15.2.0` (dropped `^`) to keep consensus-relevant bignumber math identical across services.
- `src/db.js`, `src/XChainExplorer.js`: renamed two internal handler methods to match SDK counterparts: `getPubkey` to `getPublicKey` and `getMarketOrderbook` to `getOrderbook`.
- `src/api.js`, `test/chaos/api-overload.test.js`, `test/chaos/helpers/chaos-setup.js`: migrated `rateLimit()` config from deprecated `max` option to canonical `limit` replacement.
- `src/XChainHubConnector.js`: `getAllConfig()` now polls incrementally using the hub's `watermark` as `since_updated_at`, transferring only the changed delta instead of a full config tree every 60s.
- `src/XChainHubConnector.js`: `getAllConfig()` now understands the hub's `{ configs, seq }` response shape and records `lastSeq` for change detection.
- `src/api.js`, `.env.example`: the API rate limit is now tunable via `EXPLORER_RATE_LIMIT_RPM` (default 500 req/min per IP).
- `package.json`: aligned `mariadb` driver to the `^3.5.2` range used across the platform (was `~3.4.5`).
- `package.json`: aligned `@stryker-mutator/*` dev dependencies back to `^8.7.1` to restore a single platform-wide mutation-testing baseline (was `^9.6.1`).
- When every hub endpoint is unreachable on a config-refresh tick, `src/config.js` now logs a `console.error` before serving the last-known-good cache.
- Dependency installs are now reproducible: `package-lock.json` is committed and the Docker image is built with `npm ci` instead of `npm install`.

### Fixed
- `src/content/js/xchain.js`: the client-side `isCryptoAddress()` now validates with full bech32/bech32m checksum verification and base58 structural validation instead of string length alone.
- `src/db.js`, `test/unit/db.more-queries.test.js`: `getActionData()` now has COINPAY and COINPAY_EXPIRE branches returning real settlement fields instead of an empty shell.
- `src/XChainHubConnector.js`: `_call()` now records per-endpoint failure detail on `connector.lastFailures` for operator-facing diagnostics without changing the null/degraded return contract.
- `src/XChainHubConnector.js`, `test/unit/hub-connector.test.js`: the hub JSON-RPC client no longer treats a reachable-but-degraded hub (HTTP 503 with valid JSON body) as unreachable.
- `src/ws/WebSocketServer.js`: the WebSocket `WELCOME` message now advertises the `attestation` global channel, matching what the server actually accepts.
- `src/api.js`: the periodic hub config refresh (`configInfo.startSync`) is now started after the `XChainExplorer` instance is fully initialized so its config-changed listener is registered before the first tick fires.
- `src/XChainHubConnector.js`: the hub JSON-RPC client now starts each endpoint pass at the last responder (sticky-last-good) instead of always starting from the first endpoint.
- `src/XChainExplorer.js`: `/icon`, `/{COIN}/api/file/{ACTION_INDEX}/raw`, and `/relay` error responses now return `{ error: '<message>' }` JSON envelopes matching every other explorer endpoint.
- `src/XChainExplorer.js`: `/{COIN}/api/feequote` and `/{COIN}/api/feeschedule` 503 errors now return the standard `{ error }` envelope only, dropping the extra boolean flags that appeared on no other error response.
- DISPENSER list-edit activation status in `src/db.js` is now derived from the latest indexed block's `block_time` via a new `getMaxBlockTime()` helper instead of the host's wall-clock, matching the indexer's consensus check exactly.
- Integration-test schema fixture (`test/integration/fixtures/schema.sql`) `dispensers` table updated to match the current indexer schema: added `give_ownership`, `oracle_address_id`, and corrected `fiat_amount` to `VARCHAR(250)`.
- SWEEP transaction-detail query in `src/db.js` now selects the three per-primitive flags (`orders`/`swaps`/`dispensers`) instead of the removed `sweeps.escrows` column; integration-test fixture updated to match.

### Removed
- `package.json`: removed the no-op `fs` dependency (`^0.0.1-security`), a registry-squat placeholder that Node's built-in `fs` always overrides.

### Security
- `src/XChainExplorer.js`: the checkpoint verify endpoint (`GET /{COIN}/api/checkpoint/{blockIndex}/verify`) now reflects stake-weighted quorum when active, returning `validators` as `{ pubkey, weight, source }` objects and computing `verified` with the source-deduped `3*sum > 2*S` predicate; previously it applied only count-based `2f+1` quorum and returned bare pubkey strings.
- Pinned `qs` to `^6.15.2` in `package.json` `overrides` to exclude versions affected by GHSA-q8mj-m7cp-5q26 and GHSA-6rw7-vpxm-498p (DoS via `stringify` and `arrayLimit` bypass).
- Pinned `ip-address` to `>=10.1.1` in `package.json` `overrides` to exclude versions affected by GHSA-v2v4-37r5-5v8g (XSS in `Address6` HTML-emitting methods).

## [1.15.1] - 2026-05-28

### Removed
- Stray `console.log` debug call (`XC.coin`) from the explorer web UI client script.

## [1.15.0] - 2026-05-28

### Added
- `XChainHubConnector` now retries the hub endpoint pass with exponential backoff (configurable via `HUB_RETRY_ATTEMPTS`/`HUB_RETRY_DELAY_MS`, default 4 attempts/2s base) so the explorer survives startup races when the hub is still booting.
- Successful hub configs are now persisted to `tmp/config-cache.json` (override via `CONFIG_CACHE_FILE`); when the hub is unreachable at startup, the explorer loads this cache and starts in degraded mode instead of coming up with zero coins.
- `restart: unless-stopped` policy for the explorer service in `docker-compose.yml`.
- Unit tests covering hub-unreachable startup, disk-cache fallback, sync-tick error handling, and connector retry behavior.

### Fixed
- A hub outage during the 60s config sync tick no longer raises an unhandled promise rejection; the `setInterval` callback now catches errors, logs a warning, and keeps serving the in-memory config cache.
- A transient hub blip during a sync tick no longer tears down a working in-memory config.

## [1.14.0] - 2026-04-07

### Added
- `GET /{COIN}/api/pubkey/{ADDRESS}`: new endpoint to look up the public key for an address from the decoder database.
- `getPubkey()` method in `Database` for querying the decoder `pubkeys` table.

## [1.13.1] - 2026-04-06

### Changed
- Move coverage badge to its own line in README.md for cleaner formatting.

## [1.13.0] - 2026-04-06

### Added
- VM contract endpoints: `getContracts`, `getContract`, `getContractState`, `getContractBalance`, `getExecutions`, `getExecution` REST API + explorer routes.
- Deposit/withdrawal endpoints: `getDeposits`, `getWithdrawals` REST API + explorer routes.
- Staking/validator endpoints: `getStakes`, `getValidators`, `getDelegations`, `getValidatorRewards` REST API + explorer routes.
- HTML pages for contracts, contract detail, executions, execution detail, deposits, withdrawals, and validators.
- 12 new DB query methods for all new table types.
- All endpoints follow the existing SDK-compatible paths and DataTables explorer route pattern.

## [1.12.1] - 2026-04-05

### Changed
- Moved `stryker.config.mjs` from project root into `test/mutation/`.
- Updated `test:mutation*` npm scripts to reference the new config path.

## [1.12.0] - 2026-04-03

### Added
- WebSocket API for real-time event streaming on `/{COIN}/api/websocket`.
- WebSocket server modules: `WebSocketServer`, `ChannelManager`, `ChangeDetector`, `Broadcaster` (`src/ws/`).
- Channel-based subscriptions with per-client filters (types, statuses, ticks, fields, once, snapshot).
- Batch entity subscriptions (addresses, pairs, action_indexes).
- Order lifecycle events: `ORDER_MATCH`, `COINPAY_REQUIRED`, `COINPAY_FULFILLED`, `COINPAY_EXPIRED`, `ORDER_EXPIRED`.
- Swap lifecycle events: `SWAP_MATCH`, `SWAP_EXPIRED`.
- Dispenser lifecycle events: `DISPENSE`, `DISPENSER_CLOSED`, `DISPENSER_EXPIRED`.
- Entity update events: `ADDRESS_UPDATE`, `TOKEN_UPDATE`, `MARKET_UPDATE`, `DISPENSER_UPDATE`, `NETWORK_STATS`.
- `WELCOME` message with server info, latest indexes, limits, and supported channels/types/features.
- `SUBSCRIBED` confirmation with echoed request ID and resolved filters.
- Reconnect catch-up via `since_action_index` with `CATCH_UP_COMPLETE` event.
- Snapshot-on-subscribe for address balances, token info, market data, and dispenser state.
- Client rate limiting (10 msg/sec), per-IP connection limits, and backpressure detection.
- Two-tier idle timeout: 5 min for zero-subscription clients, no timeout for subscribed clients.
- Structured WebSocket logging (`[WS]` prefix with timestamps).
- Frontend WebSocket client (`src/content/js/xchain-ws.js`) with auto-reconnection, catch-up, and connection status indicator.
- Database queries: `getMaxBlockIndex`, `getMaxActionIndex`, `getBlocksSince`, `getActionsSince`, `getAddressBalances`, `getTokenInfo`, `getMarketInfo`, `getDispenserInfo`, `getCoinpayObligation`, `getOrderMatchSettlement`.
- 64 unit tests for WebSocket modules (`ChannelManager`, `ChangeDetector`, `Broadcaster`).
- `npm run test:ws` script for running WebSocket tests.
- `WS_*` environment variables for WebSocket configuration.
- Helmet CSP updated to allow `wss:` and `ws:` in `connectSrc`.

## [1.11.0] - 2026-04-02

### Added
- API and explorer endpoints for COINPay data: `coinpays`, `coinpay_expires`, `coinpay_obligations`.
- Database query methods: `getCoinpays`, `getCoinpayExpires`, `getCoinpayObligations` with address/block search support.
- Custom WHERE and offset handling for `coinpay_obligations` address searches (payer/payee).

## [1.10.0] - 2026-04-02

### Added
- Comprehensive regression test suite with 144 tests across 3 priority tiers (`p0-core-unit`, `p0-security-baseline`, `p0-core-api`, `p1-markets-dispensers`, `p1-api-contract`, `p2-cross-endpoint`).
- Regression test infrastructure: `test/regression/helpers/db-setup.js` and `app-setup.js` reusing integration DB setup.
- npm scripts: `test:regression`, `test:regression:p0`, `test:regression:p0:unit`, `test:regression:p1`, `test:regression:full`.

## [1.9.0] - 2026-04-02

### Added
- Chaos engineering test suite with 54 experiments across 5 failure categories (`db-resilience`, `api-overload`, `network-partition`, `resource-saturation`, `external-deps`).
- Chaos test infrastructure: `docker-compose.chaos.yml` with MariaDB and Shopify Toxiproxy, `toxiproxy-client.js`, `chaos-setup.js`, and `seed-chaos.sql`.
- npm scripts: `test:chaos`, `test:chaos:db`, `test:chaos:api`, `test:chaos:network`, `test:chaos:resource`, `test:chaos:external`, `test:chaos:up`, `test:chaos:down`.

## [1.8.0] - 2026-04-02

### Added
- Mutation testing infrastructure using StrykerJS v8.7.1 with Mocha runner, targeting `utility.js`, `db.js`, `XChainExplorer.js`, `config.js`; reports to `reports/mutation/`.
- Mutation-killing unit tests for `utility.js` (147 tests, up from 120) covering `escapeLike`, `sanitizeInt`, `millisecondsToTimeString`, `priceSort`, `throwError`/`logError`, `bcadd`/`bcsub`/`bcmul`, `getTimer`, `isInteger`, and `jsonStringify`.
- Mutation-killing unit tests for `db.js` covering LRU cache `_cacheGet`/`_cacheSet` and `getQueryOffsetSql()`.

### Changed
- `utility.js` mutation score improved from 79.28% to 95.50% (211/222 killed).
- Total unit test count increased from 567 to 578.

## [1.7.0] - 2026-04-01

### Added
- Performance test suite with 5 test files using autocannon: `baseline.test.js`, `throughput.test.js`, `concurrent-load.test.js`, `pool-exhaustion.test.js`, `memory-stability.test.js`.
- Performance seed data (`seed-performance.sql`) with 100 blocks, 200 transactions, 200 actions, and assorted orders/broadcasts/balances.
- npm script: `test:performance`.
- `getOrderInfoBatch()` method for batch order info lookups to eliminate N+1 in orderbook.
- LRU cache helpers (`_cacheGet`, `_cacheSet`) for immutable data caching.

### Fixed
- Refactored `doQuery()` to manage its own connection lifecycle locally, eliminating a race condition where concurrent requests could clobber each other's database connections.
- Increased `connectionLimit` from 5 to 25 to support concurrent traffic.
- Replaced per-block UNION ALL loop in `getBlocks()` (N queries) with a single batched UNION ALL query.
- Replaced per-order `getOrderInfo()` loop in `getMarketOrderbook()` with batched `getOrderInfoBatch()` (4 queries instead of 3N).
- Parallelized 4 independent COUNT queries in `getSearch()` using `Promise.all`.
- Replaced `limit * page` pagination pattern with proper SQL `OFFSET` so high-page requests no longer fetch all preceding pages.
- Added LRU caches for `getAddressId()`, `getTickId()`, and `getActionData()` so repeat immutable lookups are served from memory.

## [1.6.0] - 2026-04-01

### Added
- Security test suite with 115 tests across 6 files: `sql-injection.test.js`, `ssrf-protection.test.js`, `input-validation.test.js`, `info-leakage.test.js`, `path-traversal.test.js`, `rate-limiting.test.js`.
- `sanitizeInt()` utility function for defense-in-depth integer validation.
- npm script: `test:security`.

### Fixed
- Parameterized all offset SQL values in `getQueryOffsetSql()`, `getQueryOffsets()`, `getHistoryData()`, and `getBlocks()` to prevent SQL injection via string concatenation.
- Set `maxRedirects: 0` on the relay handler to prevent redirect-based SSRF bypass of the IP blocklist.
- Removed `XChain-Explorer-Version` and redundant `Access-Control-Allow-Origin` custom headers; gated `XChain-Runtime-Ms` and request config debug logging behind `DEBUG` env var.
- Gated database/SQL error messages behind `DEBUG` env var; production logs show generic messages only.
- Added explicit `10kb` limit to `express.json()` middleware.
- Changed trust proxy from `true` to `1` (first hop only) to prevent `X-Forwarded-For` spoofing.
- Added whitelist check for dynamically constructed table names in `getQueryOffsets()`.

## [1.5.0] - 2026-04-01

### Added
- Boundary test suite with 210 tests across 7 test files: `validation-boundaries.test.js`, `bignum-boundaries.test.js`, `paging-boundaries.test.js`, `relay-icon-boundaries.test.js`, `api-pagination-boundaries.test.js`, `search-data-boundaries.test.js`.
- Boundary seed fixture (`seed-boundary.sql`) with edge-case tokens (zero supply, max-value supply, 1-satoshi supply).
- npm scripts: `test:boundary`, `test:boundary:unit`, `test:boundary:integration`.

### Fixed
- Clamp API pagination parameters to safe ranges: `limit`, `page`, `start`, and `length` to prevent negative SQL LIMIT errors and unbounded queries.
- Escape LIKE wildcard characters (`%`, `_`, `\`) in search input via new `escapeLike()` utility to prevent wildcard injection.
- Extend SSRF blocklist with IPv6-mapped IPv4 (`::ffff:`), IPv6 link-local (`fe80:`), and decimal IP patterns.
- Fix falsy-zero bug in offset SQL generation so `action_index=0` correctly generates offset WHERE clauses.
- Add `Number.isFinite()` guard on parsed offset values for defense-in-depth.

## [1.4.0] - 2026-04-01

### Added
- End-to-end test suite with 49 tests across 4 test files: `pipeline-integrity.test.js`, `data-formatting.test.js`, `cross-endpoint.test.js`, `markets-and-errors.test.js`.
- E2E seed fixture (`seed-e2e.sql`) with BigInt tokens, sum-verification tokens, multi-action blocks, and market history data.
- E2E db-setup helper reusing integration test infrastructure.
- npm script: `test:e2e`.

## [1.3.0] - 2026-04-01

### Added
- Smoke test suite with 38 tests across 6 test files: `config.test.js`, `server-binding.test.js` (unit, no deps); `db-connectivity.test.js`, `api-status.test.js`, `api-data.test.js`, `static-and-html.test.js` (connected, requires MariaDB).
- npm scripts: `test:smoke`, `test:smoke:unit`, `test:smoke:connected`.

## [1.2.0] - 2026-04-01

### Added
- Integration test suite with 82 tests across 9 test files covering actions, single-item endpoints, status/network, markets, DataTables paging, error handling, response format, pagination boundaries, and special endpoints.
- Test infrastructure: Docker Compose for test MariaDB, schema from indexer DDL (60 tables), and baseline seed data.
- Test helpers: `db-setup.js` and `app-setup.js` for shared app/DB lifecycle.
- `supertest` dev dependency for HTTP assertions.
- npm scripts: `test:integration`, `test:integration:up`, `test:integration:down`.

## [1.1.0] - 2026-04-01

### Fixed
- `getOrderEdits` duplicate method definition in `db.js` (line 1915 silently overridden by line 5487); renamed the per-order helper to `getOrderEditInfo`.
- 503 response for unsupported coins was overwritten to 400 by the subsequent null-data guard; added `else` to prevent the 400 block from running when 503 was already set.
- IPv6 SSRF bypass in relay handler where the `::1` regex missed bracket-wrapped addresses from Node's URL parser; now strips brackets before matching.
- Explorer 100-record pagination cap was a no-op because `limit=100` was immediately overwritten by `limit = start + length`; now correctly clamps `length` before the calculation.

### Added
- Comprehensive unit testing suite with 534 tests across 12 test files: `utility.test.js`, `db.query-builder.test.js`, `db.action-queries.test.js`, `db.data-methods.test.js`, `db.connection.test.js`, `explorer.routing.test.js`, `explorer.paging.test.js`, `explorer.response.test.js`, `explorer.icon.test.js`, `explorer.relay.test.js`, `config.test.js`, `hub-connector.test.js`.
- Test fixtures for mock configs, database results, and query argument factories.
- Mocha, Chai, Sinon, and Proxyquire as dev dependencies.
- npm test scripts: `test`, `test:utility`, `test:db`, `test:explorer`, `test:config`.
