# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
