# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [1.12.1] - 2026-04-05

### Changed
- Moved `stryker.config.mjs` from project root into `test/mutation/`
- Updated `test:mutation*` npm scripts to reference new config path

## [1.12.0] - 2026-04-03

### Added
- WebSocket API for real-time event streaming on `/{COIN}/api/websocket`
- WebSocket server modules: WebSocketServer, ChannelManager, ChangeDetector, Broadcaster (`src/ws/`)
- Channel-based subscriptions with per-client filters (types, statuses, ticks, fields, once, snapshot)
- Batch entity subscriptions (addresses, pairs, action_indexes)
- Order lifecycle events: ORDER_MATCH, COINPAY_REQUIRED, COINPAY_FULFILLED, COINPAY_EXPIRED, ORDER_EXPIRED
- Swap lifecycle events: SWAP_MATCH, SWAP_EXPIRED
- Dispenser lifecycle events: DISPENSE, DISPENSER_CLOSED, DISPENSER_EXPIRED
- Entity update events: ADDRESS_UPDATE, TOKEN_UPDATE, MARKET_UPDATE, DISPENSER_UPDATE, NETWORK_STATS
- WELCOME message with server info, latest indexes, limits, supported channels/types/features
- SUBSCRIBED confirmation with echoed request ID and resolved filters
- Reconnect catch-up via `since_action_index` with CATCH_UP_COMPLETE event
- Snapshot-on-subscribe for address balances, token info, market data, dispenser state
- Client rate limiting (10 msg/sec), per-IP connection limits, backpressure detection
- Two-tier idle timeout: 5 min for zero-subscription clients, no timeout for subscribed clients
- Structured WebSocket logging (`[WS]` prefix with timestamps)
- Frontend WebSocket client (`src/content/js/xchain-ws.js`) with auto-reconnection, catch-up, and connection status indicator
- Database queries: getMaxBlockIndex, getMaxActionIndex, getBlocksSince, getActionsSince, getAddressBalances, getTokenInfo, getMarketInfo, getDispenserInfo, getCoinpayObligation, getOrderMatchSettlement
- 64 unit tests for WebSocket modules (ChannelManager, ChangeDetector, Broadcaster)
- `npm run test:ws` script for running WebSocket tests
- `WS_*` environment variables for WebSocket configuration
- Helmet CSP updated to allow `wss:` and `ws:` in connectSrc

## [1.11.0] - 2026-04-02

### Added
- API and explorer endpoints for COINPay data: coinpays, coinpay_expires, coinpay_obligations
- Database query methods: getCoinpays, getCoinpayExpires, getCoinpayObligations with address/block search support
- Custom WHERE and offset handling for coinpay_obligations address searches (payer/payee)

## [1.10.0] - 2026-04-02

### Added
- Comprehensive regression test suite with 144 tests across 3 priority tiers
  - `p0-core-unit.test.js` — 58 curated unit tests: sanitizeInt, escapeLike, isNull, isNumeric, millisecondsToTimeString, error logging, query builder sortorder/limit validation (P0)
  - `p0-security-baseline.test.js` — SQL injection prevention: offset parameterization, WHERE clause parameterization, order/limit validation, LIKE wildcard escaping (P0)
  - `p0-core-api.test.js` — 29 integration tests: sends (block/address/token/source/destination queries, pagination, sorting), balances, holders, token detail, block, transaction (by hash and index), credits, debits, status, network, address summary (P0)
  - `p1-markets-dispensers.test.js` — 19 tests: market pairs, market filtering, orderbook, orders, dispensers, dispenses, issues, mints, destroys, broadcasts, pagination correctness, BigNumber precision, error responses (P1)
  - `p1-api-contract.test.js` — 16 tests: Content-Type headers, CORS, alphabetical key ordering, runtime field, null handling, DataTables format, empty results, SSRF protection, path traversal, HTML serving (P1)
  - `p2-cross-endpoint.test.js` — 14 tests: transaction-send cross-reference, block-scoped action counts, API vs Explorer data agreement, explorer token/block endpoints, less-used action types, icon endpoint (P2)
- Regression test infrastructure
  - `test/regression/helpers/db-setup.js` — reuses integration DB setup for stable seed data
  - `test/regression/helpers/app-setup.js` — reuses integration app setup for consistent test environment
- npm scripts: `test:regression`, `test:regression:p0`, `test:regression:p0:unit`, `test:regression:p1`, `test:regression:full`

## [1.9.0] - 2026-04-02

### Added
- Chaos engineering test suite with 54 experiments across 5 failure categories
  - `db-resilience.test.js` — CE-DB-01 through CE-DB-04: database unavailability, slow queries, pool exhaustion, intermittent connection drops (14 tests)
  - `api-overload.test.js` — CE-API-01 through CE-API-04: single-IP burst, sustained concurrency, slowloris, large payload rejection (6 tests)
  - `network-partition.test.js` — CE-NET-01 through CE-NET-04: full partition, high latency, packet slicing, bandwidth throttling (13 tests)
  - `resource-saturation.test.js` — CE-RES-01 through CE-RES-03: memory pressure, cache behavior, event loop saturation (7 tests)
  - `external-deps.test.js` — CE-EXT-01 through CE-EXT-02: relay endpoint resilience, config sync resilience (14 tests)
- Chaos test infrastructure
  - `docker-compose.chaos.yml` with MariaDB and Shopify Toxiproxy for TCP fault injection
  - `toxiproxy-client.js` — programmatic proxy management and pre-built fault scenarios (latency, bandwidth, reset_peer, timeout, limit_data, slicer)
  - `chaos-setup.js` — server lifecycle, DB seeding, HTTP helpers, health polling, recovery measurement
  - `seed-chaos.sql` — minimal test data for chaos experiments
- npm scripts: `test:chaos`, `test:chaos:db`, `test:chaos:api`, `test:chaos:network`, `test:chaos:resource`, `test:chaos:external`, `test:chaos:up`, `test:chaos:down`

## [1.8.0] - 2026-04-02

### Added
- Mutation testing infrastructure using StrykerJS v8.7.1 with Mocha runner
  - `stryker.config.mjs` targeting `utility.js`, `db.js`, `XChainExplorer.js`, `config.js`
  - HTML and JSON mutation reports generated to `reports/mutation/`
  - npm scripts: `test:mutation`, `test:mutation:utility`, `test:mutation:db`, `test:mutation:explorer`, `test:mutation:config`
- Mutation-killing unit tests for `utility.js` (147 tests, up from 120)
  - `escapeLike()` — 7 tests for backslash, percent, underscore escaping
  - `sanitizeInt()` — 7 tests for parsing, defaults, edge cases
  - `millisecondsToTimeString()` — exact string assertions replacing loose `.include()` checks
  - `priceSort()` — stability tests for equal-price elements in ASC and DESC
  - `throwError()`/`logError()` — prefix string verification
  - `bcadd()`/`bcsub()`/`bcmul()` — decimal precision truncation tests
  - `getTimer()` — arithmetic operator verification (subtraction not addition)
  - `isInteger()` — null and boolean type rejection
  - `jsonStringify()` — nested BigNumber conversion
- Mutation-killing unit tests for `db.js`
  - LRU cache `_cacheGet`/`_cacheSet` — 6 tests for round-trip, eviction, promotion, overwrite
  - `getQueryOffsetSql()` — 5 tests for empty string, undefined, and edge case inputs

### Changed
- `utility.js` mutation score: 79.28% → 95.50% (211 killed / 222 total)
- Total unit test count: 567 → 578

## [1.7.0] - 2026-04-01

### Added
- Performance test suite with 5 test files using autocannon for load generation
  - `baseline.test.js` — Single-request latency baselines for 11 endpoint categories
  - `throughput.test.js` — Sustained RPS measurement under 10 concurrent connections
  - `concurrent-load.test.js` — Ramping connection tests (10/25/50/100 connections) with p99 thresholds
  - `pool-exhaustion.test.js` — Connection pool saturation and recovery behavior tests
  - `memory-stability.test.js` — Heap growth detection during sustained load
- Performance test seed data (`seed-performance.sql`) with 100 blocks, 200 transactions, 200 actions, 100 sends, 20 orders, 50 broadcasts, 100 balances
- npm script: `test:performance`
- `getOrderInfoBatch()` method for batch order info lookups (eliminates N+1 in orderbook)
- LRU cache helpers (`_cacheGet`, `_cacheSet`) for immutable data caching

### Fixed
- **Connection pool concurrency bug**: Refactored `doQuery()` to manage its own connection lifecycle locally instead of sharing `this.transactionConnection` across concurrent requests — eliminates race condition where two simultaneous requests could clobber each other's database connections
- **Connection pool limit**: Increased `connectionLimit` from 5 to 25 to support concurrent traffic
- **N+1 query in `getBlocks()`**: Replaced per-block UNION ALL loop (N blocks x 26 tables = N queries) with single batched UNION ALL query using `IN (?)` and `GROUP BY block_index`
- **N+1 query in `getMarketOrderbook()`**: Replaced per-order `getOrderInfo()` loop with batched `getOrderInfoBatch()` — fetches all order data, edits, and remaining amounts in 4 queries instead of 3N
- **Sequential search COUNT queries**: Parallelized 4 independent COUNT queries in `getSearch()` using `Promise.all`
- **Wasteful API pagination**: Replaced `limit * page` pattern (fetching all preceding pages) with proper SQL `OFFSET` — page 10 now fetches only 1 page worth of rows instead of 10x
- **Missing lookup caches**: Added LRU caches for `getAddressId()`, `getTickId()`, and `getActionData()` — these immutable lookups are now served from memory on repeat access

## [1.6.0] - 2026-04-01

### Added
- Security test suite with 115 tests across 6 files covering all audit domains
  - `sql-injection.test.js` — 33 tests for offset parameterization, ORDER BY whitelist, LIMIT clamping, WHERE placeholders, LIKE escaping, sanitizeInt
  - `ssrf-protection.test.js` — 28 tests for redirect bypass, protocol validation, IP blocklist (14 hosts), file extension filtering, URL edge cases, error safety
  - `input-validation.test.js` — 19 tests for type confusion, special characters, null bytes, extreme values, method name safety
  - `info-leakage.test.js` — 10 tests for header removal, runtime header gating, debug logging gating, error response safety
  - `path-traversal.test.js` — 10 tests for directory traversal, boundary check logic, icon request behavior
  - `rate-limiting.test.js` — 15 tests for body size limit, trust proxy config, rate limiter settings, Helmet CSP
- `sanitizeInt()` utility function for defense-in-depth integer validation
- npm script: `test:security`

### Fixed
- **SQL injection hardening**: Parameterized all offset SQL values in `getQueryOffsetSql()`, `getQueryOffsets()`, `getHistoryData()`, and `getBlocks()` — offset values now use `?` placeholders instead of string concatenation
- **SSRF relay hardening**: Set `maxRedirects: 0` to prevent redirect-based bypass of IP blocklist
- **Info leakage prevention**: Removed `XChain-Explorer-Version` and redundant `Access-Control-Allow-Origin` custom headers; gated `XChain-Runtime-Ms` header and request config debug logging behind `DEBUG` env var
- **Error message sanitization**: Database and SQL error messages gated behind `DEBUG` env var; production logs show generic messages only
- **Request body size limit**: Added explicit `10kb` limit to `express.json()` middleware
- **Trust proxy hardening**: Changed from `true` (trust all proxies) to `1` (trust first hop only) to prevent `X-Forwarded-For` spoofing
- **Table name validation**: Added whitelist check for dynamically constructed table names in `getQueryOffsets()`

## [1.5.0] - 2026-04-01

### Added
- Boundary test suite with 210 tests across 7 test files validating API behavior at input extremes
  - `validation-boundaries.test.js` — 55 tests for isInteger, isNumeric, isNull at edge values (NaN, Infinity, 32-bit overflow, BigInt, empty strings)
  - `bignum-boundaries.test.js` — 42 tests for bcformat, bcadd/sub/mul/div with zero, negative, overflow values, and jsonStringify BigInt serialization
  - `paging-boundaries.test.js` — 23 tests for getPagingDataResults with negative/zero/overflow limit, page, length, start values
  - `relay-icon-boundaries.test.js` — 35 tests for SSRF bypass vectors (decimal IP, octal IP, IPv6-mapped IPv4, protocol edge cases) and icon path traversal
  - `api-pagination-boundaries.test.js` — 32 integration tests for limit/page/sortorder/URL path boundaries against real MariaDB
  - `search-data-boundaries.test.js` — 24 integration tests for LIKE wildcard injection, zero/max/tiny data values, market endpoints
- Boundary seed fixture (`seed-boundary.sql`) with edge-case tokens (zero supply, max-value supply, 1-satoshi supply)
- npm scripts: `test:boundary`, `test:boundary:unit`, `test:boundary:integration`

### Fixed
- Clamp API pagination parameters to safe ranges: `limit` to [1, max], `page` to [1, ...], `start` to [0, ...], `length` to [1, max] — prevents negative SQL LIMIT errors and unbounded queries
- Escape LIKE wildcard characters (`%`, `_`, `\`) in search input via new `escapeLike()` utility — prevents wildcard injection in token search and global search
- Extend SSRF blocklist with IPv6-mapped IPv4 (`::ffff:`), IPv6 link-local (`fe80:`), and decimal IP (`^\d+$`) patterns — closes relay endpoint bypass vectors
- Fix falsy-zero bug in offset SQL generation: `action_index=0` now correctly generates offset WHERE clauses
- Add `Number.isFinite()` guard on parsed offset values for defense-in-depth

## [1.4.0] - 2026-04-01

### Added
- End-to-end test suite with 49 tests across 4 test files validating the full MariaDB-to-API data pipeline
  - `pipeline-integrity.test.js` — 9 tests verifying exact seeded values round-trip through token, balance, supply, multi-action block, and address endpoints (E2E-01 to E2E-04, E2E-07)
  - `data-formatting.test.js` — 17 tests for BigInt serialization (values > MAX_SAFE_INTEGER), timestamp format consistency, boolean type preservation, null handling, and decimal precision across 4-dec and 8-dec tokens (E2E-14 to E2E-18)
  - `cross-endpoint.test.js` — 12 tests for mathematical consistency: balance == credits - debits, token supply == sum(holder balances), transaction/send data alignment, block-scoped action counts (E2E-37 to E2E-40)
  - `markets-and-errors.test.js` — 11 tests for exact seeded market prices, market history ordering, filtered market listing, SQL injection prevention, and empty database graceful handling (E2E-09, E2E-11, E2E-13, E2E-31, E2E-34)
- E2E seed fixture (`seed-e2e.sql`) extending baseline with BigInt tokens, sum-verification tokens, consistency-check addresses, multi-action blocks, and market history data
- E2E db-setup helper reusing integration test infrastructure
- npm script: `test:e2e`

## [1.3.0] - 2026-04-01

### Added
- Smoke test suite with 38 tests across 6 test files providing fast operational health checks
  - **Mode A — Unit smoke (no dependencies, < 1s):**
    - `config.test.js` — 10 tests for config loading, rejection on missing config/invalid coin, SSL cert accessibility (SM-01 through SM-04)
    - `server-binding.test.js` — 3 tests for Express server binding and JSON-RPC ping endpoint (SM-05)
  - **Mode B — Connected smoke (requires MariaDB, ~9s):**
    - `db-connectivity.test.js` — 7 tests for pool initialization, connection success, and bounded failure handling (SM-06 through SM-08)
    - `api-status.test.js` — 6 tests for status, network, and invalid coin error handling (SM-09, SM-10, SM-13)
    - `api-data.test.js` — 5 tests for sends and markets data endpoints returning correct response envelopes (SM-11, SM-16)
    - `static-and-html.test.js` — 7 tests for static file serving, HTML page delivery, and 404 handling (SM-12, SM-14, SM-15)
- npm scripts: `test:smoke`, `test:smoke:unit`, `test:smoke:connected`

## [1.2.0] - 2026-04-01

### Added
- Integration test suite with 82 tests across 9 test files verifying database-to-API correctness
  - `api-actions.test.js` — 12 tests for sends by block/address/token/source/destination, pagination, sorting
  - `api-single-item.test.js` — 12 tests for block, balances, holders, token detail, transaction, credits, debits
  - `api-status-network.test.js` — 5 tests for status and network endpoints
  - `api-markets.test.js` — 7 tests for market list, pair detail, open orders, orderbook
  - `explorer-paging.test.js` — 12 tests for DataTables-format endpoints with pagination
  - `error-handling.test.js` — 7 tests for error codes on invalid/unavailable coins, bad params
  - `response-format.test.js` — 8 tests for headers, alphabetical key sort, null handling, numeric precision
  - `pagination-boundary.test.js` — 6 tests for limit/page boundaries, sort defaults, no-overlap
  - `special-endpoints.test.js` — 13 tests for icon serving, relay SSRF protection, JSON-RPC ping, HTML pages
- Test infrastructure: Docker Compose for test MariaDB, schema from indexer DDL (60 tables), baseline seed data
- Test helpers: idempotent `db-setup.js` and cached `app-setup.js` for shared app/DB lifecycle
- `supertest` dev dependency for HTTP assertions
- npm scripts: `test:integration`, `test:integration:up`, `test:integration:down`

## [1.1.0] - 2026-04-01

### Fixed
- `getOrderEdits` duplicate method definition in db.js — the SQL generator at line 1915 was silently overridden by a per-order detail helper at line 5487; renamed the helper to `getOrderEditInfo`
- 503 response for unsupported coins was overwritten to 400 by the subsequent null-data guard — added `else` to prevent the 400 block from running when 503 was already set
- IPv6 SSRF bypass in relay handler — Node's URL parser wraps IPv6 addresses in brackets (`[::1]`), causing the `::1` regex to miss; now strips brackets before matching
- Explorer 100-record pagination cap was a no-op — the cap set `limit=100` but was immediately overwritten by `limit = start + length`; now correctly clamps `length` before the calculation

### Added
- Comprehensive unit testing suite with 534 tests across 12 test files
  - `utility.test.js` — 115 tests covering BigNumber math, type checks, JSON serialization, file operations, timers
  - `db.query-builder.test.js` — 65 tests for SQL WHERE clause generation, offset SQL, query orchestration
  - `db.action-queries.test.js` — 126 tests verifying SQL structure for all 30+ ACTION query methods
  - `db.data-methods.test.js` — 65 tests for data transformation methods (getToken, getTransaction, getBlock, etc.)
  - `db.connection.test.js` — 20 tests for connection pool management and retry logic
  - `explorer.routing.test.js` — 20 tests for URL matching and request config construction
  - `explorer.paging.test.js` — 45 tests for pagination logic and method-specific response formatting
  - `explorer.response.test.js` — 20 tests for response formatting, headers, and status codes
  - `explorer.icon.test.js` — 5 tests for icon handler including path traversal protection
  - `explorer.relay.test.js` — 12 tests for relay handler SSRF protection
  - `config.test.js` — 17 tests for config loading, caching, and hub integration
  - `hub-connector.test.js` — 11 tests for JSON-RPC hub connector
- Test fixtures for mock configs, database results, and query argument factories
- Mocha, Chai, Sinon, and Proxyquire as dev dependencies
- npm test scripts: `test`, `test:utility`, `test:db`, `test:explorer`, `test:config`
