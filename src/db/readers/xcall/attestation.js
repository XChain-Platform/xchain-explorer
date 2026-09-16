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
 * XChain Explorer - the ATTEST lifecycle and its expiry correlation
 *
 * One part of src/db/readers/xcall.js (the entry composes it through
 * composeReaderParts). The in-block correlation that links an ATTEST v2 expire
 * action to the v0 request it retired, the derived callback EXECUTE, the
 * composed ATTESTATION detail, and the two positional reads the WS
 * ChangeDetector owns.
 *
 * Authored as a class body whose prototype is exported, like every other
 * family under src/db/: `this` is the Database instance at call time, and the
 * methods reach Database.prototype non-enumerable, by descriptor.
 *
 ********************************************************************/

'use strict';

// QUERY names the round either by the 64-hex request_id every leg carries or by
// the action_index of any ATTEST action in it; both forms reduce to the request_id
// here, and null means a numeric QUERY named no round on this chain. `db` is the
// Database instance the method runs on: these are plain functions, not methods, so
// cutting the reader up adds no name to Database.prototype.
async function resolveAttestationRequestId(db, config){
    let search = config.data.search;
    if(!db.util.isNumeric(search)) return String(search || '').toLowerCase();
    let seed = await db.getAttestationByActionIndex(config, Number(search));
    // A v2 expire has no attests row, so the point read answers nothing for it and
    // the lifecycle page for the expire's own action_index rendered NOT FOUND. The
    // in-block correlation resolves it to the request it retired.
    if(!seed) seed = await db.seedAttestationFromExpireAction(config, Number(search));
    if(!seed) return null;
    return seed.request_id;
}

// Every leg of one round in one bounded read, oldest first so the caller renders the
// lifecycle in the order it happened. request_id+version is indexed.
//
// `blocks` resolves off the action's own block_index, not the transaction's: a
// mirror-applied response has an action_index but no transaction row, and routing
// through t1 left the timestamp NULL for it (attest-response-mirror spec section 4.4).
async function readAttestationLegs(db, config, requestId, limit){
    return await db.doQuery(config,
            `SELECT
                a4.action,
                m.action_index,
                a1.action_format,
                m.version,
                m.request_id,
                m.provider_id,
                m.contract_index,
                a2.address as source,
                fp.address as fee_payer,
                m.payload,
                m.callback_method,
                m.callback_params_json,
                m.redundancy,
                m.deadline_block,
                m.gas_escrow,
                ft.tick as fee_tick,
                m.fee_amount,
                m.request_status,
                m.resolved_block,
                m.responsible_set_json,
                m.origin_chain,
                m.origin_action_index,
                m.response_hash,
                m.response_payload,
                m.response_status,
                m.meta,
                m.validator_signatures,
                m.callback_execute_action_index,
                m.batch_action_index,
                m.block_index,
                b1.block_time as timestamp,
                t2.hash as tx_hash,
                t1.tx_index,
                s1.status
            FROM
                attests m
                LEFT JOIN actions             a1 ON (a1.action_index=m.action_index)
                LEFT JOIN transactions        t1 ON (t1.tx_index=a1.tx_index)
                LEFT JOIN blocks              b1 ON (b1.block_index=a1.block_index)
                LEFT JOIN index_addresses     a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                LEFT JOIN index_addresses     fp ON (fp.id=m.fee_payer_id)
                LEFT JOIN index_tickers       ft ON (ft.id=m.fee_tick_id)
                LEFT JOIN index_statuses      s1 ON (s1.id=m.status_id)
                LEFT JOIN index_transactions  t2 ON (t2.id=t1.tx_hash_id)
                LEFT JOIN index_actions       a4 ON (a4.id=a1.action_id)
            WHERE m.request_id=?
            ORDER BY m.version ASC, m.action_index ASC
            LIMIT ` + limit, [requestId]);
}

// The v0 REQUEST leg, with the two JSON columns a reader cannot use raw parsed.
function parseRequestLeg(db, rows){
    let request  = rows.find(r => Number(r.version) === 0) || null;
    if(request){
        try { request.callback_params = db.util.isNull(request.callback_params_json) ? null : JSON.parse(request.callback_params_json); }
        catch(e){ request.callback_params = request.callback_params_json; }
        // The responsible set was PINNED as-of the request block; it is the electorate a
        // reader checks the response signatures against, so it is parsed, not echoed raw.
        request.responsible_set = db.parseSignaturesArray(request.responsible_set_json);
    }
    return request;
}

// The v1 RESPONSE leg, carrying the quorum set that signed it.
function parseResponseLeg(db, rows){
    let response = rows.find(r => Number(r.version) === 1) || null;
    if(response)
        response.quorum_signatures = db.parseSignaturesArray(response.validator_signatures);
    return response;
}

// The stored callback link lives on the v1 RESPONSE row alone, so an EXPIRED
// request - which has no v1 row at all - reported "no callback execution
// recorded" while the injected expired-callback EXECUTE sat on chain a couple of
// indexes away. Derive it for that case, and flag the derivation so the page can
// say where the link came from instead of implying the indexer stamped it.
async function resolveExpiryLinks(db, config, request, response, status){
    let callbackIndex   = (response) ? response.callback_execute_action_index : null;
    let callbackDerived = false;
    let expireAction    = null;
    if(request && status === 'expired'){
        expireAction = await db.resolveAttestationExpireAction(config, request);
        if(db.util.isNull(callbackIndex)){
            callbackIndex   = await db.deriveAttestationCallbackExecute(config, request);
            callbackDerived = !db.util.isNull(callbackIndex);
        }
    }
    return { callbackIndex, callbackDerived, expireAction };
}

// Derived, because ATTEST v2 persists no ROW. It does mint an ACTION, and
// expire_action_index names it (null when the block's expire actions and
// expired requests do not line up). `expired` is the stored terminal state,
// never a clock comparison against deadline_block: a request past its deadline
// that the expiry sweep has not reached yet is still 'pending'.
function expiryLeg(request, status, expireAction){
    return {
        request_status:      status,
        deadline_block:      (request) ? request.deadline_block : null,
        resolved_block:      (request) ? request.resolved_block : null,
        expired:             status === 'expired',
        expire_action_index: expireAction
    };
}

// The relay legs (ATTEST v3/v4) as the page reads them: this round's own
// origin_chain/origin_action_index columns, never a second query for rows that are
// by construction on ANOTHER chain's indexer DB.
function relayLeg(db, request, response){
    return {
        is_relay:            !!(request && !db.util.isNull(request.origin_chain)),
        origin_chain:        (request) ? request.origin_chain : null,
        origin_action_index: (request) ? request.origin_action_index : null,
        response_relayed:    !!(response && !db.util.isNull(response.origin_action_index))
    };
}

class AttestationReaders {
    // ATTEST v2 (expire) mints an action and writes NO ROW, so `attests` names neither
    // side of the pair. The two are correlated POSITIONALLY WITHIN THE BLOCK, which is
    // exact rather than a guess, because the indexer fixes both orders:
    //   - the sweep selects what it expires in ONE deterministic order
    //     (xchain-indexer db.getExpiredAttestationRequests: deadline_block ASC,
    //     action_index ASC) and mints one v2 action per selected request in that loop,
    //     so the v2 action indexes ascend in exactly that order;
    //   - request_status 'expired' is written by that sweep and by NOTHING else (the
    //     v1/v3/v4 response paths write only 'fulfilled' or 'errored'; a retryable
    //     round leaves the request pending), so the two lists cover the same set.
    // Equal length is therefore an INVARIANT, and it is checked rather than assumed:
    // a block where the two disagree yields no link at all, because a rank correlation
    // over unequal lists names the WRONG request, which is worse than naming none.
    //
    // The rank machinery is only load-bearing for a block that expired several requests
    // at once; the common block carries one of each.
    async correlateAttestationExpiries(config, blockIndex){
        if(this.util.isNull(blockIndex)) return [];
        // Bounded well above the indexer's per-block expiry cap
        // (ATTEST_MAX_EXPIRIES_PER_BLOCK = 25) so a raised cap widens the read instead of
        // silently truncating one list and disabling the correlation.
        let cap = 100;
        let acts = await this.doQuery(config,
            `SELECT
                a1.action_index
            FROM
                actions a1
                INNER JOIN index_actions a2 ON (a2.id=a1.action_id)
            WHERE a1.block_index=? AND a2.action='ATTEST' AND a1.action_format=2
            ORDER BY a1.action_index ASC
            LIMIT ` + cap, [blockIndex]);
        if(!acts || !acts.length) return [];
        let reqs = await this.doQuery(config,
            `SELECT
                m.action_index,
                m.request_id,
                m.provider_id,
                m.contract_index,
                m.callback_method,
                m.deadline_block,
                m.request_status,
                m.resolved_block
            FROM attests m
            WHERE m.version=0 AND m.request_status='expired' AND m.resolved_block=?
            ORDER BY m.deadline_block ASC, m.action_index ASC
            LIMIT ` + cap, [blockIndex]);
        if(!reqs || reqs.length !== acts.length) return [];
        return acts.map((a, i) => ({
            expire_action_index: a.action_index,
            request:             reqs[i]
        }));
    }

    // The v2 expire action that retired one v0 request row, or null when the block's
    // two lists do not line up (see correlateAttestationExpiries).
    async resolveAttestationExpireAction(config, request){
        if(!request || String(request.request_status) !== 'expired') return null;
        let pairs = await this.correlateAttestationExpiries(config, request.resolved_block);
        let hit   = pairs.find(p => p.request && String(p.request.request_id) === String(request.request_id));
        return (hit) ? hit.expire_action_index : null;
    }

    // The inverse read, for the ACTION page of a v2: the v0 request this expire retired.
    async resolveAttestationExpireRequest(config, expireActionIndex, blockIndex){
        let pairs = await this.correlateAttestationExpiries(config, blockIndex);
        let hit   = pairs.find(p => Number(p.expire_action_index) === Number(expireActionIndex));
        return (hit) ? hit.request : null;
    }

    // Seed the lifecycle page from a v2 expire's own action_index. Reads the action's
    // block (the expire writes no attests row, so there is nothing else to key on) and
    // hands back the correlated v0 request row.
    async seedAttestationFromExpireAction(config, actionIndex){
        if(!this.util.isNumeric(actionIndex)) return null;
        let rows = await this.doQuery(config,
            `SELECT
                a1.block_index,
                a1.action_format
            FROM
                actions a1
                INNER JOIN index_actions a2 ON (a2.id=a1.action_id)
            WHERE a1.action_index=? AND a2.action='ATTEST' AND a1.action_format=2
            LIMIT 1`, [Number(actionIndex)]);
        if(!rows || !rows.length) return null;
        return await this.resolveAttestationExpireRequest(config, Number(actionIndex), rows[0].block_index);
    }

    // The system-injected callback EXECUTE for one request.
    //
    // attests.callback_execute_action_index is stamped on the v1 RESPONSE row only
    // (xchain-indexer setAttestationResponseCallbackIndex ... WHERE version = 1), so an
    // EXPIRED request has no stored link anywhere: the v2 sweep injects the expired
    // callback (injectExpiredCallback) and there is no v1 row to stamp. The execution
    // itself is unambiguous on its own columns: the injected EXECUTE calls the request's
    // OWN contract and callback method with the request_id as its first positional
    // parameter (INPUT_PARAMS is the '|'-joined argument list), and a request id is
    // unique chain-wide, so this identifies exactly the callback for THIS request.
    //
    // The id is re-validated as 64 hex before it reaches the LIKE: a request_id is the
    // only user-influenced part of the pattern and hex carries no % or _ wildcard.
    async deriveAttestationCallbackExecute(config, request){
        if(!request) return null;
        let requestId = String(request.request_id || '').toLowerCase();
        if(!/^[0-9a-f]{64}$/.test(requestId)) return null;
        if(this.util.isNull(request.contract_index) || this.util.isNull(request.callback_method)) return null;
        let rows = await this.doQuery(config,
            `SELECT
                m.action_index
            FROM contract_executions m
            WHERE m.contract_index=? AND m.method_name=? AND m.input_params LIKE CONCAT(?, '|%')
            ORDER BY m.action_index ASC
            LIMIT 1`, [request.contract_index, request.callback_method, requestId]);
        return (rows && rows.length) ? rows[0].action_index : null;
    }

    // Composed ATTESTATION lifecycle (M4.3). QUERY is EITHER the 64-hex request_id (the
    // correlation key every leg carries) or the action_index of any ATTEST action in the
    // round. A numeric QUERY resolves through getAttestationByActionIndex, the positional-arg
    // point read the WS ChangeDetector already owns: it is REUSED here rather than re-routed
    // or reshaped, because the detector depends on its signature exactly as it stands.
    //
    // WHAT THE SCHEMA FORCED, and it contradicts the obvious reading of the lifecycle:
    // ATTEST v2 (expire) writes NO ROW OF ITS OWN. It is system-synthesized, allocates an
    // action_index with FORMAT 2, and then only FLIPS the v0 request row's request_status to
    // 'expired' and stamps resolved_block (xchain-indexer attest/index.js parseExpire). So the
    // expiry leg below is DERIVED from the request row, not selected from a v2 row. The
    // expire ACTION does exist and has a working page, so it is resolved through the
    // in-block correlation above and named here rather than declared unlinkable.
    //
    // Relay legs (ATTEST v3/v4) likewise write ordinary version 0 / version 1 rows carrying
    // origin_chain + origin_action_index, so they arrive in the same request_id read; the
    // relay block below names them rather than issuing a second query for rows that are by
    // construction on ANOTHER chain's indexer DB.
    async getAttestation(config){
        let limit     = this.detailLimit(config);
        let requestId = await resolveAttestationRequestId(this, config);
        if(!requestId) return [null];

        let rows = await readAttestationLegs(this, config, requestId, limit);
        if(!rows || !rows.length) return [null];

        let request  = parseRequestLeg(this, rows);
        let response = parseResponseLeg(this, rows);
        let status   = (request) ? request.request_status : null;
        let links    = await resolveExpiryLinks(this, config, request, response, status);

        return [{
            query:      config.data.search,
            request_id: requestId,
            provider_id: rows[0].provider_id,
            legs:       rows,
            request:    request,
            response:   response,
            expiry:     expiryLeg(request, status, links.expireAction),
            relay:      relayLeg(this, request, response),
            callback_execute_action_index: links.callbackIndex,
            callback_execute_derived:      links.callbackDerived
        }];
    }

    async getAttestationsSince(config, sinceBlockIndex, limit){
        let query = `SELECT
                        m.action_index,
                        m.version,
                        m.request_id,
                        m.provider_id,
                        m.contract_index,
                        m.request_status,
                        m.response_status,
                        m.payload,
                        m.callback_params_json,
                        a2.address as source,
                        fp.address as fee_payer,
                        m.block_index,
                        s1.status
                    FROM
                        attests m
                        LEFT JOIN actions             a1 ON (a1.action_index=m.action_index)
                        LEFT JOIN transactions        t1 ON (t1.tx_index=a1.tx_index)
                        LEFT JOIN index_addresses     a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT JOIN index_addresses     fp ON (fp.id=m.fee_payer_id)
                        LEFT JOIN index_statuses      s1 ON (s1.id=m.status_id)
                    WHERE
                        m.block_index > ?
                    ORDER BY m.action_index ASC
                    LIMIT ?`;
        let results = await this.doQuery(config, query, [sinceBlockIndex, limit]);
        return results || [];
    }

    async getAttestationByActionIndex(config, action_index){
        let query = `SELECT
                        m.action_index, m.version, m.request_id, m.provider_id, m.contract_index,
                        m.request_status, m.response_status, m.payload, m.callback_params_json, m.block_index,
                        fp.address as fee_payer
                    FROM attests m
                        LEFT JOIN index_addresses fp ON (fp.id=m.fee_payer_id)
                    WHERE m.action_index=?
                    LIMIT 1`;
        let results = await this.doQuery(config, query, [action_index]);
        return (results && results.length) ? results[0] : null;
    }
}

module.exports = AttestationReaders.prototype;
