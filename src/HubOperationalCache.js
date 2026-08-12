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
 * XChain Explorer - Hub operational-state cache
 *
 * Serves the hub-LOCAL operational tables (validator_capabilities,
 * governance_proposals, governance_votes) over the hub's JSON-RPC surface
 * with a short TTL cache, instead of reading a co-located hub-owned MariaDB
 * schema. These tables are off-chain federation state that mutates in place
 * (vote upserts, proposal tallies), so they cannot ride the append-only
 * hub-DB mirror the consensus tables use; a periodic RPC read of a small,
 * bounded dataset is the honest transport.
 *
 * Endpoint resolution: HUB_API_URL (comma-separated, same env the embedded
 * hub-DB mirror client uses) takes precedence so a standalone NO_HUB=1
 * deployment can still point operational reads at a hub without enabling
 * hub config discovery; otherwise the regular discovery endpoints from
 * XChainHubConnector.parseEndpoints(). When neither is configured the cache
 * is disabled and db.js falls back to the legacy co-located hub schema read.
 *
 * Failure model: a fresh cache entry is served without a hub round-trip;
 * on hub unreachability a stale entry is served up to a bounded ceiling
 * (EXPLORER_HUB_CACHE_STALE_MAX_MS) so a hub restart doesn't blank the
 * pages, and beyond that the caller falls back or fails loud. Rows are
 * fetched with server-side filters (the datasets are bounded to 500 rows
 * per query hub-side), so cache keys include the filter params.
 *
 ********************************************************************/

const XChainHubConnector = require('./XChainHubConnector');

class HubOperationalCache {

    constructor(explorer){
        this.util = explorer.util;
        this.ttlMs      = parseInt(process.env.EXPLORER_HUB_CACHE_MS, 10) || 15000;
        this.staleMaxMs = parseInt(process.env.EXPLORER_HUB_CACHE_STALE_MAX_MS, 10) || 600000;
        this._cache = new Map();

        let endpoints = null;
        if(process.env.HUB_API_URL){
            endpoints = String(process.env.HUB_API_URL).split(',')
                .map(e => e.trim())
                .filter(e => e)
                .map(e => e.startsWith('http') ? e : 'http://' + e);
        } else {
            endpoints = XChainHubConnector.parseEndpoints();
        }
        this.connector = (endpoints && endpoints.length) ? new XChainHubConnector(endpoints) : null;
    }

    enabled(){
        return this.connector !== null;
    }

    // Fetch rows for one hub RPC read method, TTL-cached per (method, params).
    // Returns an array of rows, or null when the hub is unreachable and no
    // acceptably-fresh stale entry exists (callers fall back or fail loud).
    async getRows(method, params = {}){
        if(!this.connector) return null;
        // Drop undefined params so the cache key is stable and the hub sees
        // only the filters actually set.
        let cleaned = {};
        for(const [k, v] of Object.entries(params))
            if(v !== undefined && v !== null) cleaned[k] = v;
        let key = method + '|' + JSON.stringify(cleaned, Object.keys(cleaned).sort());
        let now = Date.now();
        let hit = this._cache.get(key);
        if(hit && (now - hit.at) < this.ttlMs)
            return hit.rows;

        let result = await this.connector._call(
            { jsonrpc: '2.0', method, params: cleaned, id: 1 },
            { attempts: 2 }
        );
        if(Array.isArray(result)){
            // Cap the map so a flood of distinct filter values cannot grow it
            // without bound (same pattern as db.js's holders cache).
            const MAX = 500;
            if(this._cache.size >= MAX && !this._cache.has(key))
                this._cache.delete(this._cache.keys().next().value);
            this._cache.set(key, { at: now, rows: result });
            return result;
        }
        if(result && result.error)
            console.warn('Hub operational read ' + method + ' returned error: ' + result.error);
        // Hub unreachable or degraded: serve the last-known rows while they
        // are not unreasonably old, so a hub restart doesn't blank the pages.
        if(hit && (now - hit.at) < this.staleMaxMs){
            console.warn('Hub unreachable for ' + method + '; serving cached rows ('
                + Math.round((now - hit.at) / 1000) + 's old)');
            return hit.rows;
        }
        return null;
    }

    getValidatorCapabilities({ capability, signing_pubkey } = {}){
        return this.getRows('getvalidatorcapabilities', { capability, signing_pubkey, limit: 500 });
    }

    // The hub's own federation registry (`validators`: addr, chains,
    // registration status). It is NOT a page of its own; the rows are folded onto
    // the on-chain /validators active set so the staked pubkey and the hub's
    // knowledge of it read as one table. getvalidators takes no filters and
    // returns only status='active' rows.
    getFederationValidators(){
        return this.getRows('getvalidators', {});
    }

    getGovernanceProposals({ status, parameter, proposal_id } = {}){
        // proposal_id has no server-side filter on getproposals; fetch the
        // bounded list and let the caller's row filter narrow it. status and
        // parameter filter hub-side.
        return this.getRows('getproposals', { status, parameter, limit: 500 })
            .then(rows => {
                if(!rows || proposal_id === undefined || proposal_id === null) return rows;
                return rows.filter(r => String(r.proposal_id) === String(proposal_id));
            });
    }

    getGovernanceVotes({ proposal_id, voter_pubkey } = {}){
        return this.getRows('getvotes', { proposal_id, voter_pubkey, limit: 500 });
    }
}

module.exports = HubOperationalCache;
