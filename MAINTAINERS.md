# Maintainers

This file lists the people responsible for `xchain-explorer`, what each of them owns, and how to escalate issues that need a human's attention beyond what `CONTRIBUTING.md` and `SECURITY.md` cover.

The XChain Platform is in pre-launch development and ships under a single primary maintainer today. As contributors take on durable responsibility for areas of the codebase, they will be added here. This is a conventional MAINTAINERS file (an open-source norm used by distros and downstream packagers), not an aspirational org chart.

---

## Primary maintainer

| Role | Name | GitHub | Areas |
|---|---|---|---|
| Lead | J-Dog | [@J-Dog](https://github.com/J-Dog) | Everything: REST + JSON-RPC API, web UI, websocket, query layer, releases |

Contact:

- General and non-sensitive: open an issue at <https://github.com/XChain-platform/xchain-explorer/issues>.
- Code of Conduct: `conduct@dankest.llc` (per `CODE_OF_CONDUCT.md`).
- Security disclosures: GitHub Private Vulnerability Reporting, or `security@dankest.llc` (per `SECURITY.md`).

---

## Areas of responsibility

Until additional maintainers join, the lead owns every area below. The table is here so a future contributor (or downstream packager) can see what each area entails when scoping a contribution.

| Area | What it covers |
|---|---|
| REST API | The 60+ REST endpoints in `src/api.js`: tokens, balances, transactions, market data, DEX state, addresses, blocks, files, messages |
| JSON-RPC | The JSON-RPC 2.0 interface (served from the same Express process as the REST API) |
| Web block explorer | The Bootstrap-based web UI: templates and static assets under `src/content/`, chart integrations (Highcharts), DataTables server-side pagination |
| WebSocket stream | The WebSocket server and supporting modules under `src/ws/` (Broadcaster, ChangeDetector, ChannelManager, WebSocketServer) |
| Query layer | The parameterized-SQL query layer in `src/db.js`; read-only against the indexer DB |
| Config and hub discovery | `src/config.js`, hub connector (`src/XChainHubConnector.js`), and the per-chain configs under `src/configs/` |
| Icon service | `src/IconDownloader.js` and `src/IconResolver.js` for token icon fetching, resizing, and caching |
| Tests | The layered suites under `test/` (unit, integration, e2e, boundary, security, chaos, mutation, smoke, performance, regression) |
| Documentation | `README`, `SECURITY`, `CODE_OF_CONDUCT`, `CONTRIBUTING`, `MAINTAINERS`, `CHANGELOG` |

---

## Adding a maintainer

A contributor becomes a maintainer when they have:

1. Sustained contribution in a specific area for at least one release cycle (typically 2 to 3 weeks of active work).
2. Reviewed and merged at least three PRs from outside contributors.
3. Demonstrated awareness of the project's conventions: read-only parameterized SQL (no ORM, no writes outside the optional icon downloader), raw Express routing, the `Keep a Changelog` format, and Node 22 as the pinned runtime.

Open a PR adding the new maintainer to the table above with their GitHub handle and area(s) of responsibility. The lead approves and merges.

## Removing a maintainer

A maintainer steps down by opening a PR removing their row. The lead also removes a maintainer who has been inactive for six months or who violates the Code of Conduct, after a written notice period.

---

## Escalation paths

If you cannot reach the relevant area maintainer within a reasonable window:

| Situation | Escalate to |
|---|---|
| Active security incident | `security@dankest.llc` (per `SECURITY.md`) |
| Injection, XSS, JSON-RPC exposure, or DoS on the public API | Open a public issue tagged `security` AND email `security@dankest.llc` |
| Code-of-conduct concern | `conduct@dankest.llc` (per `CODE_OF_CONDUCT.md`) |
| PR has been open without review for 14+ days | Comment `@J-Dog` on the PR; if no response within 7 more days, open an issue tagged `governance` with the PR link |

---

## Decision-making

The lead makes final calls on:

- Public API surface and stability (REST + JSON-RPC): adding, changing, or removing endpoints.
- Query layer: SQL patterns, connection pooling, and schema assumptions.
- Web UI structure and the published static content.
- Release timing and version policy.
- Adopting a new heavy dependency.
- Code-of-conduct enforcement, and maintainer additions or removals.

Smaller calls (bug fixes, additions within an existing area, documentation, dependency bumps inside an existing minor) go through PR review by the area maintainer.

---

## Cross-project relationships

| Project | Relationship |
|---|---|
| [`xchain-indexer`](https://github.com/XChain-platform/xchain-indexer) | The explorer reads from the indexer database (read-only); the indexer's state is the explorer's source of truth |
| [`xchain-hub`](https://github.com/XChain-platform/xchain-hub) | The explorer polls the hub for config and refreshes every 60 seconds; hub changes can affect which networks the explorer serves |
| [`xchain-sdk`](https://github.com/XChain-platform/xchain-sdk) | The SDK wraps the explorer API; API surface changes need to be coordinated with the SDK maintainer |
| [`xchain-documentation`](https://github.com/XChain-platform/xchain-documentation) | Protocol spec: ACTION definitions, encoding formats, database naming, API reference |

The explorer maintainer is not automatically a maintainer of those sibling projects. Cross-project changes go through each project's own review process.
