# Explorer production deploy files

The explorer runs on its production host as a **systemd unit**, not a container: it reads
locally synced MariaDB replicas, so it has no per-coin container to join. That
made it the one service whose runtime definition lived only on the box. These
two files put it under version control.

| File | Installs as |
|---|---|
| `xchain-explorer.service` | `/etc/systemd/system/xchain-explorer.service` |
| `logrotate-xchain-explorer-app` | `/etc/logrotate.d/xchain-explorer-app` |
| `tbtc-tip-gates.conf` | `/etc/systemd/system/xchain-explorer.service.d/tbtc-tip-gates.conf` |
| `rate-limits.conf` | `/etc/systemd/system/xchain-explorer.service.d/rate-limits.conf` |

Both are reproduced from the running production unit, read 2026-08-30. The unit is
faithful to the live file apart from four added `Environment=` lines
(`LOG_LEVEL`, `LOG_FORMAT`, `METRICS_ENABLED`, `XCHAIN_LOG_PATCH`, all at their
shim defaults). The logrotate stanza is new: nothing on the box rotates the
explorer's app logs today.

## Two names, and why

A deployment that fronts the explorer with a web server usually already has a
`xchain-explorer` logrotate stanza for that server's access log, whose short
retention is a privacy commitment (those request lines carry wallet addresses).
The app-log stanza therefore installs under its own name,
`xchain-explorer-app`. Do not merge them.

## What this fixes

Nothing rotates the explorer's own `stdout.log` and `stderr.log` unless a
stanza names them, and the obvious filename is usually already taken by the
fronting web server's access log (above). Left unrotated, those two files grow
without bound until they threaten the filesystem they sit on.

## Substitute before installing

Both files carry `<deploy-user>` where a deployment has its own service
account, so the paths read `/home/<deploy-user>/xchain-explorer` and the
logrotate stanza reads `su <deploy-user> <deploy-user>`. Replace it with the
account the explorer runs as; the unit will not start against the literal
placeholder. Everything else installs as-is.

## Install

Run on the explorer host, as an operator with sudo:

```sh
sudo install -m 0644 xchain-explorer.service /etc/systemd/system/xchain-explorer.service
sudo systemctl daemon-reload
sudo systemctl restart xchain-explorer      # only inside a maintenance window
sudo install -m 0644 logrotate-xchain-explorer-app /etc/logrotate.d/xchain-explorer-app
sudo logrotate -d /etc/logrotate.d/xchain-explorer-app   # dry run, prints the plan
sudo logrotate -f /etc/logrotate.d/xchain-explorer-app   # first rotation, reclaims the backlog
```

The logrotate half needs no restart and no window: `copytruncate` truncates the
files in place while the explorer keeps writing. Install it first if you only
have time for one.

A deployment will also have drop-ins of its own under the unit's
`.service.d/` directory holding per-coin upstream endpoints. That wiring is
specific to wherever those services run, so it is not reproduced here, and
installing the unit above leaves it untouched. Two drop-ins are the exception,
because they are policy choices rather than wiring (testnet4 freshness-gate
widths, and the eight origin rate limits), so they live here and install the
same way as the unit:

```sh
sudo install -m 0644 tbtc-tip-gates.conf /etc/systemd/system/xchain-explorer.service.d/tbtc-tip-gates.conf
sudo systemctl daemon-reload
sudo systemctl restart xchain-explorer      # only inside a maintenance window
```

```sh
sudo install -m 0644 rate-limits.conf /etc/systemd/system/xchain-explorer.service.d/rate-limits.conf
sudo systemctl daemon-reload
sudo systemctl restart xchain-explorer      # only inside a maintenance window
```

`rate-limits.conf` writes out all eight limits explicitly, the five it does not
change included, so the running unit's numbers do not depend on which explorer
build is deployed. Its header carries where each number came from.

## Freshness alerting

`bin/check-explorer-freshness.sh` (in this repo's `bin/`) turns the explorer's
own `/BTC/api/status` verdicts into an operator signal: it exits 1 with the
problem on stderr whenever any non-regtest coin is stale-gated or its replica
carries an active sync halt, and stays silent otherwise. Run it from cron on
the explorer host, in a crontab whose `MAILTO` is set, and do **not** append
`2>&1` (stderr is the mail):

```
*/15 * * * * <checkout>/bin/check-explorer-freshness.sh >/dev/null
```

It needs `jq`, and honours `EXPLORER_STATUS_URL` when the API is not on the
default `127.0.0.1:18080`. It exists because a replica halt once sat behind a
correctly-503ing explorer for half a day with nobody told: the sync client's
divergence halt and the explorer's freshness gate both protect *consumers*;
this is the piece that tells the *operator*.
