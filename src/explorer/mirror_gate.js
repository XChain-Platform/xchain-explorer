/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Explorer - hub-mirror staleness gate
 *
 * The freshness verdict every consensus route asks for before serving from a
 * self-synced checkpoint mirror, the refusal body that verdict turns into, and the
 * status route operators read it from.
 *
 * Authored as a class body and installed onto XChainExplorer.prototype by
 * explorer/install.js, so `this` is the explorer instance at call time.
 *
 ********************************************************************/

'use strict';

// Module-scope logger, not a method on the class these parts install onto: every
// log line below reaches the shipper api.js installs, exactly as it did inline.
const { getLogger } = require('../observability');
const log = getLogger();

// The entry's live read-through view of process.env, handed over at install time:
// config.js stays the one module that reads env, and requiring it here would run
// its SSL probe in every tool and suite that loads this part.
let configEnv = null;

function useHostBindings(host){
    configEnv = host.configEnv;
}

class MirrorGate {

    // Staleness gate for consensus data served from a SELF-SYNCED checkpoint mirror,
    // applying only to coins whose mirror this process runs (HubMirrorSyncManager).

    // Two tiers: a mirror that has NEVER completed its REST bootstrap fails loud, an
    // empty mirror having to read as an outage rather than an empty ledger, while a
    // bootstrapped-but-lagging one serves with a mirror_lag_seconds annotation and
    // hard-fails past MIRROR_MAX_LAG_S only when MIRROR_LAG_FAIL_CLOSED=1 opts in.
    mirrorGate(coin){
        let mgr = this.hubMirrorSync;
        if(!mgr || !mgr.managesCoin(coin)) return { blocked: null, annotate: null };
        let status = mgr.statusForCoin(coin) || {};
        // Third tier, checked first: the mirror is claimed by self_sync but has no
        // hub endpoint, so no writer exists at all. That is not "not bootstrapped
        // yet" (which resolves on its own once the hub is reachable) and it must not
        // read as a live-but-empty ledger, so it gets its own code and its own
        // message pointing at the configuration that is missing.
        if(status.configured === false)
            return { blocked: 'MIRROR_NOT_CONFIGURED', annotate: null };
        if(!status.bootstrapDrained)
            return { blocked: 'MIRROR_NOT_BOOTSTRAPPED', annotate: null };
        let annotate = { mirror_bootstrapped: true, mirror_lag_seconds: status.mirrorLagSeconds };
        let maxLag = parseInt(configEnv().MIRROR_MAX_LAG_S, 10) || 0;
        if(maxLag > 0 && status.mirrorLagSeconds !== null && status.mirrorLagSeconds > maxLag){
            log.warn('HUB_MIRROR_LAG_EXCEEDED', {
                coin, lag_s: status.mirrorLagSeconds, max_lag_s: maxLag,
                detail: 'mirror lag exceeds MIRROR_MAX_LAG_S' +
                    (configEnv().MIRROR_LAG_FAIL_CLOSED === '1' ? ' (failing closed)' : ' (serving with annotation)')
            });
            if(configEnv().MIRROR_LAG_FAIL_CLOSED === '1')
                return { blocked: 'MIRROR_STALE', annotate };
        }
        return { blocked: null, annotate };
    }

    mirrorBlockedBody(blocked){
        let error;
        if(blocked === 'MIRROR_NOT_CONFIGURED')
            error = 'Hub-mirror self-sync is configured for this coin but no hub endpoint is set ' +
                '(database.checkpoint.hub_url or HUB_API_URL), so nothing updates the mirror; ' +
                'consensus data is refused rather than served stale.';
        else if(blocked === 'MIRROR_NOT_BOOTSTRAPPED')
            error = 'Hub-mirror has not completed its initial bootstrap; consensus data is unavailable rather than served empty.';
        else
            error = 'Hub-mirror is stale beyond MIRROR_MAX_LAG_S and MIRROR_LAG_FAIL_CLOSED is set.';
        return { error, code: blocked };
    }

    // GET /{COIN}/api/hub-mirror/status: self-synced mirror observability for
    // this coin ({enabled:false} when the coin is served from an externally-
    // maintained schema). Operators use bootstrapDrained/mirrorLagSeconds to
    // tell "empty because nothing exists" from "empty because never synced".
    async processHubMirrorStatusRequest(req, res){
        let coin = String(req.params.coin || '').toUpperCase();
        if(!this.db.pools || !this.db.pools[coin])
            return res.status(404).json({ error: 'Unknown coin', code: 'UNKNOWN_COIN' });
        let status = this.hubMirrorSync ? this.hubMirrorSync.statusForCoin(coin) : null;
        return res.json(status || { enabled: false });
    }

    // GET /{COIN}/api/checkpoints[?limit=N]: latest quorum-signed state checkpoints
}

module.exports = { methods: MirrorGate.prototype, useHostBindings };
