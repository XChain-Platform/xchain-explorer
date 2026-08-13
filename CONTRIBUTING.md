# Contributing to XChain Explorer

Thanks for considering a contribution. `xchain-explorer` is a public-facing, internet-exposed REST + JSON-RPC API and web block explorer, so we weight correctness and security on every commit.

If you're reporting a security issue, **stop here** and read [`SECURITY.md`](./SECURITY.md) instead. Security reports go through a private channel.

---

## Quick links

- Project overview: [`README.md`](./README.md)
- Full component docs: the [`xchain-documentation`](https://github.com/XChain-Platform/xchain-documentation/tree/master/components/explorer) repository (architecture, configuration, API reference, operations)
- Disclosure policy: [`SECURITY.md`](./SECURITY.md)
- License: [`LICENSE.md`](./LICENSE.md) + [`NOTICE.md`](./NOTICE.md) (GNU Affero General Public License v3.0, dual-licensed)

---

## Repo layout in 30 seconds

```
xchain-explorer/
├── src/                  explorer core: API server, DB layer, routing, config, relay, icons
├── test/                 layered suites (unit, integration, e2e, boundary, security, chaos, mutation, smoke, performance, regression)
├── CHANGELOG.md          authoritative version history
├── SECURITY.md           private vulnerability disclosure
└── package.json          scripts + dependencies
```

---

## Setting up

### Prerequisites

- **Node.js 22** exactly. The platform pins Node 22 fleet-wide: the `mariadb` driver is ESM-only (Node 18 fails with `ERR_REQUIRE_ESM`), and newer majors are not validated against the stack. `engines.node` declares `>=22.0.0`; use 22.
- **MariaDB** reachable from the explorer host for anything beyond unit tests.
- A running XChain stack (indexer + hub) for integration and e2e runs. For local work, a regtest stack with `xchain-regtest-miner` is the easiest path.

### First-time install

```bash
git clone https://github.com/XChain-Platform/xchain-explorer.git
cd xchain-explorer
npm install
```

Create a `.env` (see [`README.md`](./README.md) for the full key list). **Never commit a `.env` or any real credential.** Secrets live only in the local `.env`, loaded at runtime; never hard-code them into source, tests, or scripts.

---

## Running it

```bash
npm run api        # start the explorer (HTTP + HTTPS servers)
```

For integration fixtures:

```bash
npm run test:integration:up    # start docker compose test fixtures
npm run test:integration:down  # tear them down
```

---

## Tests

The explorer runs a layered suite. Pick the tier that matches your change:

| Tier | Command | Needs external services |
|---|---|---|
| Smoke (unit) | `npm run test:smoke:unit` | No |
| Unit | `npm test` | No |
| Security | `npm run test:security` | No |
| CI (unit, fast gate) | `npm run ci` | No |
| Boundary (unit) | `npm run test:boundary:unit` | No |
| Integration | `npm run test:integration` | MariaDB (docker compose fixtures) |
| End-to-end | `npm run test:e2e` | Full stack |
| Fuzz | `npm run test:fuzz` (`:deep` for 10,000 iterations) | No |
| Performance | `npm run test:performance` | No |
| Chaos | `npm run test:chaos` | No |
| Regression | `npm run test:regression` (`:p0` for P0 critical path only) | No |

Run the no-external-services tiers before every commit; `npm run ci` and `npm run test:security` are the minimum gate. Because this service is a public web surface, new API parameters, rendering paths, or query construction should come with security and boundary coverage.

---

## Coding style

- **Plain JavaScript**, no TypeScript. Raw parameterized SQL via the `mariadb` driver, no ORM.
- **No linter is configured.** Match the style of the surrounding file: naming, structure, and comment density.
- **Comments are rare on purpose.** Don't restate what well-named code already says. Do comment a *why* that isn't obvious: a hidden invariant, a security-relevant constraint, a workaround with a reference.
- **Never use the em-dash character** in code, comments, or docs. Rewrite the sentence (a comma, colon, or parentheses) instead.
- **Two trailing spaces** on consecutive bold-label markdown lines so CommonMark renders the line break instead of collapsing them.
- **Read-only contract.** The explorer never writes to the indexer database except via the optional icon downloader. Keep it that way.

---

## Commit messages

Match the existing log style: a concise subject line, then a short body explaining what changed and why.

- Branch off `master` and keep history linear (rebase, don't merge).
- One logical change per commit; don't batch unrelated work.
- **No `Co-Authored-By` trailers.** This is a project policy.
- **Never `--no-verify`.** If a hook fails, fix the cause; don't bypass it.

---

## Pull requests

CI is the smoke + unit gate. Before opening a PR:

1. Run the no-external-services tiers (`npm run ci`, `npm run test:security`) and confirm they pass.
2. Update `CHANGELOG.md` with a terse entry for your change.
3. Make sure `git status` is clean apart from intended changes (no `node_modules/`, no editor leftovers, no `.env`).
4. Open the PR with a clear title and a description of what changed and why.

For non-security bugs, open an issue at <https://github.com/XChain-Platform/xchain-explorer/issues/new>. For security bugs, see [`SECURITY.md`](./SECURITY.md).

---

Last reviewed: 2026-06-16.
