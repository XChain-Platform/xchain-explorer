<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright © 2025-2026 Dankest, LLC -->

# XChain Platform Explorer

<p align="center">
  <img src="https://img.shields.io/badge/version-1.15.4-blue" alt="Version">
  <img src="https://img.shields.io/badge/tests-2%2C762%2B%20passing-brightgreen" alt="Tests">
  <img src="https://img.shields.io/badge/node-%3E%3D22-green" alt="Node">
  <img src="https://img.shields.io/badge/license-AGPL--3.0--or--later-blue" alt="License">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/coverage-unit%20%7C%20integration%20%7C%20e2e%20%7C%20boundary%20%7C%20security%20%7C%20fuzz%20%7C%20chaos%20%7C%20mutation%20%7C%20smoke%20%7C%20performance%20%7C%20regression%20%7C%20conformance-brightgreen" alt="Coverage">
</p>

Query and presentation layer for the XChain Platform. Reads from the Indexer database and exposes 60+ REST API endpoints, a JSON-RPC 2.0 interface, and a Bootstrap-based web block explorer, all from a single Node.js/Express process. The explorer never writes to any database.

## Features

- **60+ REST endpoints**: tokens, balances, transactions, market data, DEX state, addresses, blocks, files, staking, attestations, contracts, messages
- **Four interfaces**: REST API, JSON-RPC 2.0, WebSocket real-time push, and a web block explorer served from the same process
- **Multi-chain support**: Bitcoin, Litecoin, and Dogecoin on mainnet, testnet, and regtest (9 networks)
- **Read-only by default**: only writes to the Indexer database when the optional icon downloader is enabled
- **WebSocket API**: real-time push of blocks, actions, and lifecycle events with per-channel subscriptions and catch-up replay
- **Config discovery**: fetches configuration from xchain-hub and refreshes every 60 seconds
- **SSL/TLS support**: serves both HTTP and HTTPS with configurable certificates
- **Rate limiting**: configurable request rate limiting (default 500 req/min)
- **Security hardened**: Helmet CSP, CORS, SSRF-protected relay, parameterized SQL, directory traversal prevention
- **DataTables integration**: server-side pagination endpoints for the web UI
- **Chart.js integration**: candlestick, market depth, and line charts
- **Icon service**: token icons with automatic fallback and optional background downloader
- **BigNumber precision**: arbitrary-precision arithmetic for all amounts and prices
- **Contract pages**: on-chain source with syntax highlighting, a server-verified hash badge, extracted method list, and constructor params; a Read Contract card calls the sandboxed `POST /{COIN}/api/contract/{idx}/call` endpoint (off by default via `EXPLORER_VM_QUERY_ENABLED`), and a Write Contract card deep-links per-method calls into the wallet
- **Self-synced hub mirror**: optional local copy of the hub-mirror tables (`database.checkpoint.self_sync` + `HUB_API_URL`) removes the hard requirement for a co-located hub DB; `GET /{COIN}/api/hub-mirror/status` reports staleness
- **2,762+ tests**: unit, integration, e2e, boundary, security, fuzz, chaos, mutation, smoke, performance, regression, conformance

## Documentation

Full explorer documentation is available in the [xchain-documentation](https://github.com/XChain-Platform/xchain-documentation/tree/master/components/explorer) repository:

| Document | Description |
|---|---|
| [README](https://github.com/XChain-Platform/xchain-documentation/blob/master/components/explorer/README.md) | Overview, installation, quick start, scripts, dependencies |
| [Architecture](https://github.com/XChain-Platform/xchain-documentation/blob/master/components/explorer/architecture.md) | Data pipeline, internal components, request processing pipeline, source files |
| [Configuration](https://github.com/XChain-Platform/xchain-documentation/blob/master/components/explorer/configuration.md) | Environment variables, config.json, hub discovery, SSL/TLS, CORS, rate limiting |
| [API Reference](https://github.com/XChain-Platform/xchain-documentation/blob/master/components/explorer/api.md) | Complete REST API: all 60+ endpoints with paths, parameters, response formats, examples |
| [WebSocket API](https://github.com/XChain-Platform/xchain-documentation/blob/master/components/explorer/websocket.md) | Real-time streaming: connection, channel subscriptions, filters, event payloads |
| [Operations](https://github.com/XChain-Platform/xchain-documentation/blob/master/components/explorer/operations.md) | Running, Docker, SSL setup, security features, relay endpoint, troubleshooting |

## Quick Start

```bash
git clone https://github.com/XChain-Platform/xchain-explorer.git
cd xchain-explorer
npm install
```

Create a `.env` file:

```env
HUB_API_HOST=localhost
HUB_PORT=10000
EXPLORER_API_PORT_HTTP=8080
EXPLORER_API_PORT_HTTPS=8081
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

## Database schema note: ownership-trading columns

The order-book, swaps, market, and detail endpoints read the `give_ownership`
and `get_ownership` columns on the `orders` and `swaps` tables (added for
token-ownership trading). Against a normally-operated backing database these
columns are already present:

- A database written by **xchain-indexer** gains them automatically. The
  indexer adds any missing column with a safe default on startup.
- A read replica kept current by **xchain-sync** gains them on its next
  startup. The replication service now self-heals these columns before
  accepting synced rows.

Only if you point the explorer at a **standalone database that is managed by
neither service** must you add the columns manually, **once, before deploying
this build**, or the affected endpoints will error with `Unknown column`:

```sql
ALTER TABLE orders ADD COLUMN give_ownership TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN get_ownership  TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE swaps  ADD COLUMN give_ownership TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE swaps  ADD COLUMN get_ownership  TINYINT(1) NOT NULL DEFAULT 0;
```

## Icon Downloader (optional)

The explorer can optionally download, resize, and cache token icons sourced from each token's `description` field (JSON URLs, IPFS, Arweave, Ordinals, imgur, stamps, bare image URLs). Disabled by default.

The `icons` table backing this feature is created automatically by xchain-indexer at startup (no migration needed). To enable on the explorer side:

1. Grant the explorer's MySQL user `SELECT, INSERT, UPDATE, DELETE` on the `icons` table in each indexer database the explorer is configured against.
2. Make sure ImageMagick `convert` is on the host PATH.
3. Set `iconDownload.enabled` to `true` in `config.json` and restart the explorer.

```json
"iconDownload": {
    "enabled":         true,
    "intervalMinutes": 15,
    "batchSize":       50,
    "fetchTimeoutMs":  5000,
    "maxBytes":        5242880,
    "iconSize":        64
}
```

Generated icons are written to `src/content/icons/{COIN}/{NETWORK}/{TICK}.png` and served by the existing `/icon/...` endpoint. Failed fetches back off (1h -> 1d -> 7d -> permanent) so unreachable URLs aren't repeatedly retried.

Accepted source formats are PNG, JPEG, GIF and WebP, decided by sniffing the downloaded bytes rather than by trusting the URL. **SVG is refused:** the renderer behind it dereferences external references, and those fetches would leave ImageMagick without passing the downloader's private-address and web-port checks, so a token whose only icon is an SVG is recorded failed (`unsupported mime 'image/svg+xml'`) instead. Egress is restricted to ports 80 and 443, on the first request and on every redirect hop, the same restriction `/relay` enforces.

## Metrics and log shipping (optional, off by default)

A Prometheus `/metrics` endpoint and a structured log shim ship with this
service and stay inert unless switched on: with no env set, no route is
registered, no timer starts and no socket opens. Turn the endpoint on with
`METRICS_ENABLED=1` (add `METRICS_TOKEN` to gate the scrape on a reachable
box), and ship logs with `LOG_SHIP_ENABLED=1` plus `LOG_SHIP_URL`. Full
variable list and the exported metric names are in
[`src/observability/README.md`](src/observability/README.md).

The module is vendored byte-identically from xchain-hub. Edit it there
and re-run `xchain-hub/bin/sync-observability.sh`; a local edit fails the
parity check CI runs across the vendored copies.

## Scripts

| Command | Description |
|---|---|
| `npm run api` | Start the explorer (HTTP + HTTPS servers) |
| `npm test` | Run unit tests (~1,925 tests) |
| `npm run test:integration` | Integration tests (~154 tests, requires MariaDB) |
| `npm run test:conformance` | Real-schema conformance canary against the indexer's live DDL |
| `npm run test:e2e` | End-to-end tests (49 tests, requires full stack) |
| `npm run test:boundary` | Boundary condition tests |
| `npm run test:boundary:unit` | Boundary tests (unit only, no DB) |
| `npm run test:boundary:integration` | Boundary tests (integration, requires MariaDB) |
| `npm run test:smoke` | Smoke tests (unit + connected) |
| `npm run test:smoke:unit` | Smoke tests (unit only) |
| `npm run test:smoke:connected` | Smoke tests (connected, requires services) |
| `npm run test:security` | Security tests (SQL injection, SSRF, XSS, path traversal) |
| `npm run test:fuzz` | Fuzz tests (property-based) |
| `npm run test:fuzz:deep` | Fuzz tests with `FUZZ_ITERATIONS=10000` |
| `npm run test:performance` | Performance tests (baseline, throughput, concurrency, pool, memory) |
| `npm run test:chaos` | Chaos engineering tests |
| `npm run test:chaos:db` | Chaos: database resilience |
| `npm run test:chaos:api` | Chaos: API overload |
| `npm run test:chaos:network` | Chaos: network partition |
| `npm run test:chaos:resource` | Chaos: resource saturation |
| `npm run test:chaos:external` | Chaos: external dependency failure |
| `npm run test:mutation` | Mutation tests (StrykerJS) |
| `npm run test:mutation:utility` | Mutation tests: utility.js |
| `npm run test:mutation:db` | Mutation tests: db.js |
| `npm run test:mutation:explorer` | Mutation tests: XChainExplorer.js |
| `npm run test:mutation:config` | Mutation tests: config.js |
| `npm run test:regression` | Regression tests (P0 + P1 + P2 tiers) |
| `npm run test:regression:p0` | P0 critical-path regression only (<1s) |
| `npm run test:regression:p0:unit` | P0 unit regression only |
| `npm run test:regression:p1` | P1 high-priority regression |
| `npm run test:regression:full` | Full regression suite (P0 + P1 + P2) |

## Test Suite

| Type | Tests | Description |
|---|---|---|
| Unit | ~1,925 | `db.action-queries.test.js`, `db.data-methods.test.js`, `db.query-builder.test.js`, `db.connection.test.js`, `utility.test.js`, `explorer.routing.test.js`, `explorer.paging.test.js`, `explorer.response.test.js`, `explorer.relay.test.js`, `explorer.icon.test.js`, `config.test.js`, `hub-connector.test.js`, `ws/*.test.js`, and more |
| Integration | ~154 | API actions, paging, markets, status, response format, error handling, pagination boundaries |
| Conformance | 5 | Real-schema canary: executes explorer read paths against the indexer's live DDL in a real MariaDB |
| E2E | 49 | Pipeline integrity, data formatting, markets, cross-endpoint consistency |
| Boundary | ~226 | Validation limits, BigNumber edge cases, relay/icon boundaries, pagination, search |
| Security | ~137 | SQL injection, SSRF protection, rate limiting, input validation, info leakage, path traversal |
| Fuzz | ~10 | Property-based testing |
| Performance | 15 | Baseline throughput, concurrent load, pool exhaustion, memory stability |
| Chaos | ~54 | DB resilience, API overload, network partition, resource saturation, external deps |
| Mutation | (Stryker) | StrykerJS mutation testing across utility, db, explorer, and config modules |
| Smoke | ~39 | Config loading, server binding, DB connectivity, API liveness, static content |
| Regression | ~148 | P0 core unit + security + API, P1 markets + API contract, P2 cross-endpoint |
| **Total** | **~2,762+** | |

---

**Copyright &copy; 2025-2026 Dankest, LLC**

**Based on XChain Platform by Dankest, LLC &ndash; https://dankest.llc**

Licensed under the **GNU Affero General Public License v3.0** (AGPL-3.0-or-later)
with a commercial license available for proprietary use.

You may use, modify, and distribute this material under the terms of the License.
See [LICENSE](./LICENSE.md) and [NOTICE](./NOTICE.md) for full terms.
See the [licensing overview](https://docs.xchain.io/legal/LICENSING.html).
