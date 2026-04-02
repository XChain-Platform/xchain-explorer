# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
