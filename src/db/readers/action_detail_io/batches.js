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
 * XChain Explorer - emission provenance and the action summary batch
 *
 * Emission provenance for a set of actions, the batched getActionData fetch,
 * and the compact summary projection every action list renders.
 *
 * One part of src/db/readers/action_detail_io.js (the entry composes it through
 * composeReaderParts). Authored as a class body whose prototype is exported,
 * like every other family under src/db/: `this` is the Database instance at
 * call time, and the methods reach Database.prototype non-enumerable, by
 * descriptor.
 *
 ********************************************************************/

'use strict';

const { ACTION_SUMMARY_FIELDS } = require('../../shared.js');

// Structured logging. Cached at require time: getLogger() resolves lazily on
// every call, so this reaches the real shipper once api.js has run
// installObservability and falls through to bare console.* before that.
const { getLogger } = require('../../../observability');
const log = getLogger();

class ActionSummaryReaders {
    // Emission provenance for a SET of action indexes, in two queries rather than two per
    // action. Almost no action is an emission, so the second query runs only for the few
    // that are - and on a page with none it does not run at all. Returns a Map of
    // action_index -> { execution_index, position, contract_index, caller }, containing only
    // the indexes that ARE emissions; absence means "broadcast normally".
    async getEmissionProvenanceBatch(config, action_indexes){
        let out  = new Map();
        let idxs = (action_indexes || []).map((i) => Number(i)).filter((i) => !isNaN(i));
        if(!idxs.length) return out;
        let holes = idxs.map(() => '?').join(',');
        let rows  = await this.doQuery(config,
            `SELECT
                e.action_index,
                e.execution_index,
                e.position
            FROM
                contract_emissions e
            WHERE
                e.action_index IN (${holes})`, idxs);
        if(!rows || !rows.length) return out;
        for(let r of rows)
            out.set(Number(r.action_index), {
                execution_index: r.execution_index,
                position:        r.position,
                contract_index:  null,
                caller:          null
            });
        let parents = [...new Set([...out.values()].map((v) => Number(v.execution_index)))];
        let pHoles  = parents.map(() => '?').join(',');
        let pRows   = await this.doQuery(config,
            `SELECT
                m.action_index,
                m.contract_index,
                a1.address as caller
            FROM
                contract_executions m
                LEFT  JOIN index_addresses a1 ON (a1.id=m.caller_id)
            WHERE
                m.action_index IN (${pHoles})`, parents);
        let byExec = new Map((pRows || []).map((r) => [Number(r.action_index), r]));
        for(let v of out.values()){
            let p = byExec.get(Number(v.execution_index));
            if(p){ v.contract_index = p.contract_index; v.caller = p.caller; }
        }
        return out;
    }

    // Batch-load getActionData for a set of action indexes (Fix B / #3841). Resolves the
    // DISTINCT action_index set concurrently through the existing getActionData path (bounded
    // by BATCH_CONCURRENCY so the connection pool is not exhausted), returning a Map keyed by
    // the numeric action_index. Because each entry is produced by the unmodified getActionData,
    // every payload is byte-for-byte identical to the per-row path it replaces; the only change
    // is that the page's lookups now overlap instead of running strictly serially, and the LRU
    // _actionDataCache is warmed exactly as before. Callers must read results by action_index
    // (never rely on ordering). Failures propagate unchanged (same as the old per-row await).
    async getActionDataBatch(config, actionIndexes){
        const BATCH_CONCURRENCY = Number(this.config && this.config.BATCH_CONCURRENCY) || 8;
        // Distinct, insertion-order-preserving set of indexes to fetch.
        let distinct = [];
        let seen = new Set();
        for(let idx of actionIndexes){
            let key = Number(idx);
            if(!seen.has(key)){ seen.add(key); distinct.push(idx); }
        }
        // Shared-leg prefetch. Overlapping the fan-out hid the latency but
        // left the page's DB work at O(actions x queries): every index still ran its
        // own type, three ledger-effect, fee and transaction queries. Those legs are
        // identical in shape for every action, so the page runs each of them ONCE over
        // the whole index set and threads the result in as a preload; only the
        // per-handler detail queries still fan out. Indexes already in the LRU are
        // excluded, so a warm page prefetches nothing, and at a single cold index the
        // query count is unchanged (the type and tx legs merge into one meta query).
        let cold = distinct.filter((idx) => this.cacheGet(this._actionDataCache, this.cacheKey(config.coin, idx)) === undefined);
        let preload = (cold.length) ? await this.buildActionPreload(config, cold) : null;
        let out = new Map();
        let cursor = 0;
        const worker = async () => {
            while(cursor < distinct.length){
                let i = cursor++;
                let idx = distinct[i];
                out.set(Number(idx), await this.getActionData(config, idx, preload));
            }
        };
        let workers = [];
        let poolSize = Math.min(BATCH_CONCURRENCY, distinct.length);
        for(let w = 0; w < poolSize; w++) workers.push(worker());
        await Promise.all(workers);
        return out;
    }

    // Project one full getActionData payload onto the compact summary shape the
    // client's getActionDetails renders: ACTION_SUMMARY_FIELDS copied onto a
    // `details` object (false when none is present) plus the row status. SEND
    // keeps its fields per destination under sends[], so the summary reads
    // sends[0] for every field and takes its status when the payload has none.
    // The transaction/history rows and the BATCH member table both go through
    // here, so a field lands on every summary surface at once.
    projectActionSummary(info){
        let details = false;
        let status  = info.status;
        let send    = (info.action=='SEND' && Array.isArray(info.sends) && info.sends.length>0) ? info.sends[0] : null;
        if(send && this.util.isNull(status))
            status = send.status;
        for(let name of ACTION_SUMMARY_FIELDS){
            let found  = false;
            let detail = false;
            if(typeof info[name] !== 'undefined'){
                found  = true;
                detail = info[name];
            }
            if(send){
                found  = true;
                detail = send[name];
            }
            if(found){
                if(!details)
                    details = {};
                details[name] = detail;
            }
        }
        // Structure markers. A multi-send is ONE action with one sends[] row per
        // leg, and the flattening above shows leg 0 alone, so a reader scanning a
        // list could not tell a 4-recipient send from a single one; a BATCH parent
        // projected no field at all and rendered as a bare name. leg_count and
        // member_count let a list row mark itself without carrying the legs (the
        // disclosure fetches the action). Both are absent, not 0 or 1, when there
        // is nothing to mark, so single sends keep their exact prior shape.
        let legs = (info.action=='SEND') ? info.sends : (info.action=='DESTROY') ? info.destroys : null;
        if(Array.isArray(legs) && legs.length > 1){
            if(!details) details = {};
            details.leg_count = legs.length;
        }
        if(info.action=='BATCH' && Array.isArray(info.actions) && info.actions.length > 0){
            if(!details) details = {};
            details.member_count = info.actions.length;
        }
        return { details, status };
    }

    async getActionSummaryData(config, actions){
        // --- Performance note (Fix B / #3841) ---
        // The page's action rows are enriched via getActionDataBatch(), which resolves the
        // distinct action_index set through getActionData with bounded concurrency instead of
        // one strictly-serial await per row. Payloads are byte-identical to the old per-row
        // path (same getActionData); only the round-trips now overlap, so first-load latency
        // no longer scales linearly with the serial round-trip count. Tracked as #3841.
        const t0 = Date.now();
        // --- End Fix B ---
        // Pre-resolve every row's action data once, keyed by action_index.
        let actionData = await this.getActionDataBatch(config, actions.map((a) => a.action_index));
        for(let data of actions){
            let info = actionData.get(Number(data.action_index));
            let { details, status } = this.projectActionSummary(info);
            // The history feed derives BATCH membership per row (getHistoryData's
            // correlated subquery) but the positional row shape has no slot for it,
            // so it rides inside details, where the client marks the member row.
            if(!this.util.isNull(data.parent_batch_action_index)){
                if(!details) details = {};
                details.parent_batch_action_index = Number(data.parent_batch_action_index);
            }
            data.status  = status;
            data.details = details;
        }
        // Slow-page observability (Fix B): warn when first-load latency is still high after
        // the batched concurrent fetch (#3841), so any residual slow path stays visible.
        const elapsed = Date.now() - t0;
        if(elapsed > 500)
            log.warn('ACTION_SUMMARY_SLOW_PAGE', { method: 'getActionSummaryData', elapsedMs: elapsed,
                actions: actions.length, note: 'batched getActionData fetch still slow; see #3841' });
        return actions;
    }
}

module.exports = ActionSummaryReaders.prototype;
