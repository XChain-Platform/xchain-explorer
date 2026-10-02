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
 ********************************************************************/

'use strict';

const listReaders = require('./lists.js');
const ATTEST_BATCH_COLUMNS = [
    'batch_action_index', 'batch_window_start', 'batch_window_end', 'batch_row_count'
];
const ATTEST_BATCH_PROBE_TTL_MS = 60000;

async function attestBatchColumnsPresent(db, config){
    if(!db.attestBatchColumnMemo) db.attestBatchColumnMemo = {};
    let memo = db.attestBatchColumnMemo[config.coin];
    if(memo && (memo.present || Date.now() - memo.at < ATTEST_BATCH_PROBE_TTL_MS))
        return memo.present;
    try {
        let placeholders = ATTEST_BATCH_COLUMNS.map(() => '?').join(',');
        let rows = await db.doQuery(config,
            `SELECT COLUMN_NAME
             FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='attests'
               AND COLUMN_NAME IN (${placeholders})
             LIMIT ${ATTEST_BATCH_COLUMNS.length}`, ATTEST_BATCH_COLUMNS);
        let found = new Set((rows || []).map(r => String(r.COLUMN_NAME)));
        let present = ATTEST_BATCH_COLUMNS.every(name => found.has(name));
        db.attestBatchColumnMemo[config.coin] = { present, at: Date.now() };
        return present;
    } catch(_){
        db.attestBatchColumnMemo[config.coin] = { present: false, at: Date.now() };
        return false;
    }
}
function batchProjection(withBatch){
    if(!withBatch) return '';
    return `,
                CASE WHEN m.version IN (5, 6) THEN m.request_id ELSE NULL END as batch_key,
                m.batch_window_start,
                m.batch_window_end,
                m.batch_row_count,
                m.batch_action_index`;
}

const getAttestationsWithoutBatch = listReaders.getAttestations;
listReaders.getAttestations = async function(config){
    let withBatch = await attestBatchColumnsPresent(this, config);
    let result = await getAttestationsWithoutBatch.call(this, config);
    if(withBatch)
        result[0] = result[0].replace('m.callback_params_json,',
            'm.callback_params_json' + batchProjection(true) + ',');
    return result;
};
async function resolveAttestationRequestId(db, config){
    let search = config.data.search;
    if(!db.util.isNumeric(search)) return {
        requestId: String(search || '').toLowerCase(),
        seed: null
    };
    let seed = await db.getAttestationByActionIndex(config, Number(search));
    if(!seed) seed = await db.seedAttestationFromExpireAction(config, Number(search));
    if(!seed) return null;
    return { requestId: seed.request_id, seed };
}
async function readAttestationLegs(db, config, requestId, limit, withBatch){
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
                m.callback_execute_action_index` + batchProjection(withBatch) + `,
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
async function readBatchResponses(db, config, actionIndex, limit){
    return await db.doQuery(config,
        `SELECT
            r.action_index,
            r.version,
            r.request_id,
            q.action_index as request_action_index,
            r.provider_id,
            r.response_hash,
            r.response_payload,
            r.response_status,
            r.meta,
            r.validator_signatures,
            r.callback_execute_action_index,
            r.batch_action_index,
            r.block_index,
            s.status
         FROM attests r
         LEFT JOIN attests q ON (q.request_id=r.request_id AND q.version=0)
         LEFT JOIN index_statuses s ON (s.id=r.status_id)
         WHERE r.version=1 AND r.batch_action_index=?
         ORDER BY r.action_index ASC
         LIMIT ` + limit, [actionIndex]);
}
function batchLifecycle(db, rows, selected, responses){
    let heads = rows.filter(r => Number(r.version) === 5);
    let selectedRow = rows.find(r => Number(r.action_index) === Number(selected.action_index)) || selected;
    let head = Number(selectedRow.version) === 5 ? selectedRow : heads.find(r => r.source === selectedRow.source);
    if(!head) head = heads[0] || selected;
    let source = head.source;
    let continuations = rows.filter(r => Number(r.version) === 6 && r.source === source);
    let duplicates = heads.filter(r => Number(r.action_index) !== Number(head.action_index)
        && String(r.status) === 'valid').map(r => ({
            action_index: r.action_index,
            tx_hash:      r.tx_hash,
            source:       r.source,
            block_index:  r.block_index
        }));
    head.batch_key = head.request_id;
    for(let row of continuations) row.batch_key = row.request_id;
    for(let row of responses)
        row.quorum_signatures = db.parseSignaturesArray(row.validator_signatures);
    return {
        batch: head,
        continuations,
        responses,
        duplicates
    };
}
function parseRequestLeg(db, rows){
    let request  = rows.find(r => Number(r.version) === 0) || null;
    if(request){
        try { request.callback_params = db.util.isNull(request.callback_params_json) ? null : JSON.parse(request.callback_params_json); }
        catch(e){ request.callback_params = request.callback_params_json; }
        request.responsible_set = db.parseSignaturesArray(request.responsible_set_json);
    }
    return request;
}

function parseResponseLeg(db, rows){
    let response = rows.find(r => Number(r.version) === 1) || null;
    if(response)
        response.quorum_signatures = db.parseSignaturesArray(response.validator_signatures);
    return response;
}

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

function expiryLeg(request, status, expireAction){
    return {
        request_status:      status,
        deadline_block:      (request) ? request.deadline_block : null,
        resolved_block:      (request) ? request.resolved_block : null,
        expired:             status === 'expired',
        expire_action_index: expireAction
    };
}

function relayLeg(db, request, response){
    return {
        is_relay:            !!(request && !db.util.isNull(request.origin_chain)),
        origin_chain:        (request) ? request.origin_chain : null,
        origin_action_index: (request) ? request.origin_action_index : null,
        response_relayed:    !!(response && !db.util.isNull(response.origin_action_index))
    };
}

class AttestationReaders {
    async correlateAttestationExpiries(config, blockIndex){
        if(this.util.isNull(blockIndex)) return [];
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

    async resolveAttestationExpireAction(config, request){
        if(!request || String(request.request_status) !== 'expired') return null;
        let pairs = await this.correlateAttestationExpiries(config, request.resolved_block);
        let hit   = pairs.find(p => p.request && String(p.request.request_id) === String(request.request_id));
        return (hit) ? hit.expire_action_index : null;
    }

    async resolveAttestationExpireRequest(config, expireActionIndex, blockIndex){
        let pairs = await this.correlateAttestationExpiries(config, blockIndex);
        let hit   = pairs.find(p => Number(p.expire_action_index) === Number(expireActionIndex));
        return (hit) ? hit.request : null;
    }

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

    async getAttestation(config){
        let limit    = this.detailLimit(config);
        let resolved = await resolveAttestationRequestId(this, config);
        if(!resolved) return [null];

        let withBatch = await attestBatchColumnsPresent(this, config);
        let rows = await readAttestationLegs(this, config, resolved.requestId, limit, withBatch);
        if(!rows || !rows.length) return [null];

        let selected = resolved.seed || rows[0];
        if(withBatch && [5, 6].includes(Number(selected.version))){
            let heads = rows.filter(r => Number(r.version) === 5);
            let head = Number(selected.version) === 5 ? selected
                : heads.find(r => r.source === selected.source) || heads[0] || selected;
            let responses = Number(head.batch_row_count) === 0 ? []
                : await readBatchResponses(this, config, head.action_index, limit);
            return [batchLifecycle(this, rows, selected, responses || [])];
        }

        let request  = parseRequestLeg(this, rows);
        let response = parseResponseLeg(this, rows);
        let status   = (request) ? request.request_status : null;
        let links    = await resolveExpiryLinks(this, config, request, response, status);

        return [{
            query:      config.data.search,
            request_id: resolved.requestId,
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
        let withBatch = await attestBatchColumnsPresent(this, config);
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
                        ` + (withBatch ? `CASE WHEN m.version IN (5, 6) THEN m.request_id ELSE NULL END as batch_key,
                        m.batch_window_start,
                        m.batch_window_end,
                        m.batch_row_count,
                        m.batch_action_index,
                        ` : ``) + `a2.address as source,
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
        let withBatch = await attestBatchColumnsPresent(this, config);
        let query = `SELECT
                        m.action_index, m.version, m.request_id, m.provider_id, m.contract_index,
                        m.request_status, m.response_status, m.payload, m.callback_params_json, m.block_index,
                        fp.address as fee_payer` + batchProjection(withBatch) + `,
                        a2.address as source, b1.block_time as timestamp, t2.hash as tx_hash,
                        t1.tx_index, s1.status
                    FROM attests m
                        LEFT JOIN actions a1 ON (a1.action_index=m.action_index)
                        LEFT JOIN transactions t1 ON (t1.tx_index=a1.tx_index)
                        LEFT JOIN blocks b1 ON (b1.block_index=a1.block_index)
                        LEFT JOIN index_addresses fp ON (fp.id=m.fee_payer_id)
                        LEFT JOIN index_addresses a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT JOIN index_statuses s1 ON (s1.id=m.status_id)
                        LEFT JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE m.action_index=?
                    LIMIT 1`;
        let results = await this.doQuery(config, query, [action_index]);
        return (results && results.length) ? results[0] : null;
    }
}

module.exports = AttestationReaders.prototype;
