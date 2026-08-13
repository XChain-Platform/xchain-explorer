# Security Policy

`xchain-explorer` is the public REST + JSON-RPC API and web UI for the XChain Platform. It is internet-exposed and renders on-chain-derived data directly to browsers and API consumers. Although it is read-only with respect to protocol state, a flaw in its request handling, rendering, or query layer can expose users to injection, cross-site scripting, or denial-of-service. We treat reports seriously and respond fast.

If you've found a security issue, please **do not open a public issue or pull request**. Use the private channels below.

---

## How to report

### Preferred: GitHub Private Vulnerability Reporting

Open a draft advisory at:

<https://github.com/XChain-Platform/xchain-explorer/security/advisories/new>

This is the fastest path. The advisory is private until we publish it.

### Alternative: Email

Email **security@dankest.llc** with:

- A description of the issue and the threat it poses.
- Reproduction steps or a proof-of-concept (a crafted request, payload, or on-chain value that triggers the bug).
- The affected version (see `CHANGELOG.md` and the version badge in `README.md`) and the network you tested against (mainnet / testnet / regtest, and which chain).
- Any patches or mitigations you'd like considered.

For sensitive reports, encrypt the email body to our PGP key. The fingerprint will be published alongside the first signed release artifact; until then, the email channel is acceptable for first contact and we will coordinate an encrypted exchange before you share proof-of-concept details.

We do not currently offer a paid bug bounty. We do offer public credit in release notes and the advisory itself, unless you prefer to remain anonymous.

---

## Response timeline

| Stage | Target |
|---|---|
| Initial acknowledgement | within 72 hours |
| Triage + severity assignment | within 7 days |
| Fix or mitigation in master | within 30 days for high/critical, 90 days for lower severities |
| Coordinated public disclosure | up to 90 days from initial report, or sooner if a fix has shipped and operators are protected |

If we cannot meet a timeline, we will tell you why and propose a new one. We will not silently let a report age.

---

## Scope

### In scope

- SQL injection via REST API or JSON-RPC parameters into the MariaDB query layer.
- XSS or template injection in the web UI when rendering on-chain-derived data (token names, descriptions, addresses, or any field sourced from the ledger).
- JSON-RPC method exposure: unauthenticated access to methods that should be restricted, or method enumeration that leaks internal state.
- Denial-of-service against the API or web server: crafted requests that exhaust connections, memory, or CPU (including against the rate-limiter, the WebSocket surface, or pagination endpoints).
- Auth and access-control issues on any privileged or operator-only endpoint.
- The WebSocket surface: unauthenticated subscription, message injection, or resource exhaustion via open connections.
- SSRF via the relay endpoint or any path that makes outbound requests based on caller-supplied URLs.
- Path traversal or directory listing in static-file serving.
- Information leakage: stack traces, internal paths, or database errors surfaced to unauthenticated callers.
- The icon downloader when enabled: SSRF, path traversal, or resource exhaustion via on-chain-embedded URLs.

### Out of scope

- Incorrect ledger data that originates upstream in the indexer; report those against `xchain-indexer` unless the root cause is in the explorer's query or rendering layer.
- The operator's own reverse-proxy, TLS, firewall, or MariaDB configuration.
- The underlying database server.
- Vulnerabilities in the underlying coin nodes (`bitcoind` / `litecoind` / `dogecoind`); report those to their respective projects.
- Compromise of upstream npm dependencies (we mitigate via audit + review, but a backdoor in a dep is the dep author's incident, though we still want to hear about it).
- Attacks that require the operator's database credentials or shell access to the explorer host.

If you are unsure, send the report anyway and we will tell you whether it falls in scope.

---

## What we ask

- Give us a reasonable window to fix before disclosing publicly. The 90-day ceiling is firm; earlier is fine once a fix has shipped and operators are protected.
- Test against `regtest` or `testnet` where possible (the `xchain-regtest-miner` plus a local stack make this easy). Mainnet proofs-of-concept are accepted but should be the minimum needed.
- Do not run automated scanners against shared XChain infrastructure in a way that would impact availability for other operators.
- Do not access data, or attempt to access data, beyond what is needed to demonstrate the issue.

---

## What we will do

- Confirm receipt within the SLA above.
- Keep you informed as triage and remediation proceed.
- Credit you in the advisory and `CHANGELOG.md` entry, on request.
- Coordinate a CVE assignment when the severity warrants it.
- Publish a post-fix advisory describing the issue, the fix, and the affected version range.

---

## Versions covered

We ship security fixes against the latest release on `master`. Older releases are unsupported. The current version is recorded in `CHANGELOG.md` and the badge in `README.md`.

---

Last reviewed: 2026-06-16.
