<!-- SPDX-License-Identifier: LicenseRef-Dankest-Community -->
<!-- Copyright © 2025 Dankest, LLC -->

# XChain Platform Explorer

<p align="center">
  <img src="https://img.shields.io/badge/version-1.13.1-blue" alt="Version">
  <img src="https://img.shields.io/badge/tests-1%2C285%20passing-brightgreen" alt="Tests">
  <img src="https://img.shields.io/badge/node-%3E%3D18-green" alt="Node">
  <img src="https://img.shields.io/badge/license-Dankest%20Community-orange" alt="License">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/coverage-unit%20%7C%20integration%20%7C%20e2e%20%7C%20boundary%20%7C%20security%20%7C%20chaos%20%7C%20mutation%20%7C%20smoke%20%7C%20perf%20%7C%20regression-brightgreen" alt="Coverage">
</p>

Query and presentation layer for the XChain Platform. Reads from the Indexer database and exposes 60+ REST API endpoints, a JSON-RPC 2.0 interface, and a Bootstrap-based web block explorer — all from a single Node.js/Express process. The explorer never writes to any database.

## Features

- **60+ REST endpoints** — tokens, balances, transactions, market data, DEX state, addresses, blocks, files, messages
- **Three interfaces** — REST API, JSON-RPC 2.0, and a web block explorer served from the same process
- **Multi-chain support** — Bitcoin, Litecoin, and Dogecoin on mainnet, testnet, and regtest (9 networks)
- **Read-only** — never writes to the Indexer database
- **Config discovery** — fetches configuration from xchain-hub and refreshes every 60 seconds
- **SSL/TLS support** — serves both HTTP and HTTPS with configurable certificates
- **Rate limiting** — configurable request rate limiting (default 500 req/min)
- **Security hardened** — Helmet CSP, CORS, SSRF-protected relay, parameterized SQL, directory traversal prevention
- **DataTables integration** — server-side pagination endpoints for the web UI
- **Highcharts integration** — candlestick, market depth, and line charts
- **Icon service** — token icons with automatic fallback
- **BigNumber precision** — arbitrary-precision arithmetic for all amounts and prices
- **1,285 tests** — unit, integration, e2e, boundary, security, chaos, mutation, smoke, performance, regression

## Documentation

Full explorer documentation is available in the [xchain-documentation](https://github.com/XChain-platform/xchain-documentation/tree/master/explorer) repository:

| Document | Description |
|---|---|
| [README](https://github.com/XChain-platform/xchain-documentation/blob/master/components/explorer/README.md) | Overview, installation, quick start, scripts, dependencies |
| [Architecture](https://github.com/XChain-platform/xchain-documentation/blob/master/components/explorer/ARCHITECTURE.md) | Data pipeline, internal components, request processing pipeline, source files |
| [Configuration](https://github.com/XChain-platform/xchain-documentation/blob/master/components/explorer/CONFIGURATION.md) | Environment variables, config.json, hub discovery, SSL/TLS, CORS, rate limiting |
| [API Reference](https://github.com/XChain-platform/xchain-documentation/blob/master/components/explorer/API.md) | Complete REST API — all 60+ endpoints with paths, parameters, response formats, examples |
| [Operations](https://github.com/XChain-platform/xchain-documentation/blob/master/components/explorer/OPERATIONS.md) | Running, Docker, SSL setup, security features, relay endpoint, troubleshooting |

## Quick Start

```bash
git clone https://github.com/XChain-platform/xchain-explorer.git
cd xchain-explorer
npm install
```

Create a `.env` file:

```env
HUB_API_HOST=localhost
HUB_PORT=1984
EXPLORER_API_PORT_HTTP=8080
EXPLORER_API_PORT_HTTPS=8443
```

Start the explorer:

```bash
npm run api
```

Query the API:

```bash
# Get token information
curl http://localhost:8080/BTC/api/token/MYTOKEN

# Get balances for an address
curl http://localhost:8080/BTC/api/balances/bc1qexampleaddress

# Get recent sends for an address
curl "http://localhost:8080/BTC/api/sends/bc1qexampleaddress/address?page=1&limit=25"

# Get DEX order book
curl http://localhost:8080/BTC/api/market/TOKENA/TOKENB/orderbook

# Get platform status
curl http://localhost:8080/BTC/api/status
```

## Scripts

| Command | Description |
|---|---|
| `npm run api` | Start the explorer (HTTP + HTTPS servers) |
| `npm test` | Run unit tests (~583 tests) |
| `npm run test:integration` | Integration tests (~83 tests, requires MariaDB) |
| `npm run test:e2e` | End-to-end tests (49 tests, requires full stack) |
| `npm run test:boundary` | Boundary condition tests |
| `npm run test:boundary:unit` | Boundary tests (unit only, no DB) |
| `npm run test:boundary:integration` | Boundary tests (integration, requires MariaDB) |
| `npm run test:smoke` | Smoke tests (unit + connected) |
| `npm run test:smoke:unit` | Smoke tests (unit only) |
| `npm run test:smoke:connected` | Smoke tests (connected, requires services) |
| `npm run test:security` | Security tests (SQL injection, SSRF, XSS, path traversal) |
| `npm run test:performance` | Performance tests (baseline, throughput, concurrency, pool, memory) |
| `npm run test:chaos` | Chaos engineering tests |
| `npm run test:chaos:db` | Chaos — database resilience |
| `npm run test:chaos:api` | Chaos — API overload |
| `npm run test:chaos:network` | Chaos — network partition |
| `npm run test:chaos:resource` | Chaos — resource saturation |
| `npm run test:chaos:external` | Chaos — external dependency failure |
| `npm run test:mutation` | Mutation tests (StrykerJS) |
| `npm run test:mutation:utility` | Mutation tests — utility.js |
| `npm run test:mutation:db` | Mutation tests — db.js |
| `npm run test:mutation:explorer` | Mutation tests — XChainExplorer.js |
| `npm run test:mutation:config` | Mutation tests — config.js |
| `npm run test:regression` | Regression tests (P0 + P1 + P2 tiers) |
| `npm run test:regression:p0` | P0 critical-path regression only (<1s) |
| `npm run test:regression:p0:unit` | P0 unit regression only |
| `npm run test:regression:p1` | P1 high-priority regression |
| `npm run test:regression:full` | Full regression suite (P0 + P1 + P2) |

## Test Suite

| Type | Tests | Description |
|---|---|---|
| Unit — DB | ~290 | `db.action-queries.test.js`, `db.data-methods.test.js`, `db.query-builder.test.js`, `db.connection.test.js` |
| Unit — Utility | ~149 | `utility.test.js` — BigNumber math, timers, sanitization, type checking |
| Unit — Explorer | ~113 | `explorer.routing.test.js`, `explorer.paging.test.js`, `explorer.response.test.js`, `explorer.relay.test.js`, `explorer.icon.test.js` |
| Unit — Config | ~31 | `config.test.js`, `hub-connector.test.js` |
| Integration | ~83 | API actions, paging, markets, status, response format, error handling, pagination boundaries |
| E2E | 49 | Pipeline integrity, data formatting, markets, cross-endpoint consistency |
| Boundary | ~211 | Validation limits, BigNumber edge cases, relay/icon boundaries, pagination, search |
| Security | ~104 | SQL injection, SSRF protection, rate limiting, input validation, info leakage, path traversal |
| Performance | 15 | Baseline throughput, concurrent load, pool exhaustion, memory stability |
| Chaos | ~56 | DB resilience, API overload, network partition, resource saturation, external deps |
| Mutation | — | StrykerJS mutation testing across utility, db, explorer, and config modules |
| Smoke | ~40 | Config loading, server binding, DB connectivity, API liveness, static content |
| Regression | 144 | P0 core unit + security + API, P1 markets + API contract, P2 cross-endpoint |
| **Total** | **~1,285+** | |

---

**Copyright &copy; 2025 Dankest, LLC**

**Based on XChain Platform by Dankest, LLC &ndash; https://dankest.llc**

Licensed under the **Dankest Community License**
(based on the Apache License 2.0 with additional non-commercial and network-disclosure terms).

You may not use, modify, or distribute this material except in compliance with the License.
See [LICENSE](./LICENSE.md) and [NOTICE](./NOTICE.md) for full terms.
A full copy of the License is also available at: [https://dankest.llc/license](https://dankest.llc/license)
