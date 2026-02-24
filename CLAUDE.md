# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run api          # Start the server
docker compose build && docker compose up  # Run via Docker
```

No test or lint tooling is configured.

## Architecture

XChain-Explorer is a multi-chain blockchain explorer and REST API for the XChain platform (BTC, LTC, DOGE across mainnet/testnet/regtest). It serves both HTML pages and JSON API responses.

**Entry point**: `src/api.js` — initializes Express with Helmet + CORS, loads SSL certs from `src/ssl/`, starts HTTP and HTTPS servers on ports from env vars `EXPLORER_API_PORT_HTTP` / `EXPLORER_API_PORT_HTTPS`. Also registers a JSON-RPC router (`express-json-rpc-router`) with a `ping` endpoint. The HTTP→HTTPS redirect is currently commented out.

**Hub connector**: `src/XChainHubConnector.js` — connects to XChain Hub via JSON-RPC (HTTP POST). Methods: `ping()` and `getAllConfig()`. Uses `axios` for requests. Hub URL/port come from env vars `HUB_API_HOST` / `HUB_PORT`.

**Request routing**: `src/XChainExplorer.js` (843 lines) — three routing layers, all defined in `setupUrls()`:
- **Static files**: `/css`, `/fonts`, `/charts`, `/images`, `/json`, `/js` served from `src/content/`
- **HTML routes**: `/{COIN}/action-name` and `/{COIN}/{type}/{QUERY}` → template files in `src/content/html/`
- **API routes**: 50+ endpoints at `/{COIN}/api/{action}/{QUERY}/{TYPE}` returning JSON; special market routes `/api/market/{TICK1}/{TICK2}/...`
- **Explorer routes**: Parallel set of 40+ endpoints returning DataTables-compatible JSON (`recordsTotal` / `recordsFiltered`)
- **Special handlers**: `/icon` serves icon files with fallback to `default.png`; `/relay` is a CORS proxy for JSON and PNG files (`?url=` param)

**Database layer**: `src/db.js` (~5578 lines). Uses raw parameterized SQL with the `mariadb` package (no ORM). Connection pooling with retry logic. Each data type (sends, tokens, orders, etc.) has a `get*` method that returns `[query, args, count]`. The main entry point is `getData(config)` which calls `getQuery()` → `getQueryWhereSql()` / `getQueryOffsetSql()` to compose SQL dynamically.

**Configuration**: `src/config.js` — prefers fetching from XChain Hub via `XChainHubConnector.getAllConfig()` when `HUB_API_HOST`/`HUB_PORT` are set; falls back to `src/config.json` or the `NODE_CONFIG` env var. Includes an event system (`onConfigChanged` / `triggerConfigChanged`) and a `startSync` interval (60s) for live config updates. Coin-specific constants (address prefixes, chain info) live in `src/configs/BTC.js`, `LTC.js`, `DOGE.js`. Coin config files are loaded from the Docker-internal path `/XChainExplorer/src/configs/`.

**Frontend**: Static HTML in `src/content/html/`, Bootstrap + jQuery + Highcharts. No build step — files are served directly.

## Docker

Requires an external Docker network to exist before starting:
```bash
docker network create xchain_network
docker compose build && docker compose up
```

## Key Patterns

- SQL queries use `?` placeholders; never interpolate user input into query strings.
- MariaDB-specific: no `LATERAL` joins, uses `offset_index` instead of native `OFFSET` keyword for pagination.
- `src/utility.js` has a `logError(error, info)` helper used for structured error logging.
- Math on token quantities uses `mathjs` for BigInt/high-precision support.
