# Explorer production deploy files

The explorer runs on its production host as a **systemd unit**, not a container: it reads
locally synced MariaDB replicas, so it has no per-coin container to join. That
made it the one service whose runtime definition lived only on the box. These
two files put it under version control.

| File | Installs as |
|---|---|
| `xchain-explorer.service` | `/etc/systemd/system/xchain-explorer.service` |
| `logrotate-xchain-explorer-app` | `/etc/logrotate.d/xchain-explorer-app` |

Both are reproduced from the running production unit, read 2026-08-30. The unit is
faithful to the live file apart from four added `Environment=` lines
(`LOG_LEVEL`, `LOG_FORMAT`, `METRICS_ENABLED`, `XCHAIN_LOG_PATCH`, all at their
shim defaults). The logrotate stanza is new: nothing on the box rotates the
explorer's app logs today.

## Two names, and why

`/etc/logrotate.d/xchain-explorer` is **taken**. It holds the Apache
access-log stanza for `/var/log/apache2/explorer/*.log`, whose 1-day retention
is a privacy commitment (those request lines carry wallet addresses). The app-log
stanza therefore installs as `xchain-explorer-app`. Do not merge them.

## What this fixes

`/var/lib/logrotate/status` shows `logs/stdout.log` and `logs/stderr.log` last
rotated **2026-08-02** and never since; no file in `/etc/logrotate.d` names
either path. The `xchain-explorer` filename now holds the Apache access-log
stanza, dated by its own header comment to that same 2026-08-02, which is the
most likely explanation for the app-log stanza's disappearance. `stderr.log`
reached **302 MB** in the 28 days that followed, on a root filesystem with
5.9 GB free.

## Substitute before installing

Both files carry `<deploy-user>` where the live host has its own service
account, so the paths read `/home/<deploy-user>/xchain-explorer`. Replace it
with the account the explorer actually runs as; the unit will not start against
the literal placeholder. Everything else installs as-is.

## Install

Run on the explorer host, as an operator with sudo:

```sh
sudo install -m 0644 xchain-explorer.service /etc/systemd/system/xchain-explorer.service
sudo systemctl daemon-reload
sudo systemctl restart xchain-explorer      # only inside a maintenance window
sudo install -m 0644 logrotate-xchain-explorer-app /etc/logrotate.d/xchain-explorer-app
sudo logrotate -d /etc/logrotate.d/xchain-explorer-app   # dry run, prints the plan
sudo logrotate -f /etc/logrotate.d/xchain-explorer-app   # first rotation, reclaims the 302 MB
```

The logrotate half needs no restart and no window: `copytruncate` truncates the
files in place while the explorer keeps writing. Install it first if you only
have time for one.

The box also carries drop-ins under
`/etc/systemd/system/xchain-explorer.service.d/` (`decoder-api.conf`,
`encoder.conf`, `hub.conf`, `indexer-api.conf`, `trackers.conf`) holding per-coin
upstream endpoints. Those are box-specific wiring and are not reproduced here;
installing the unit above leaves them untouched.
