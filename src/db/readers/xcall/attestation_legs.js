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
 * XChain Explorer - the ATTEST lifecycle leg reads
 *
 * The bounded read of every leg of one request, and the choice of which v1 row
 * is THE response. One request can carry several v1 rows: retryable rounds
 * (no_quorum, timeout, provider_error) leave it pending, invalid wires are
 * stored too, and only the terminal round carries the callback link.
 *
 ********************************************************************/

'use strict';

const { batchProjection } = require('../../shared.js');

const TERMINAL_RESPONSE_STATUSES = ['ok', 'expired'];

function legQuery(withBatch, where, order, limit){
    return `SELECT
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
            WHERE ` + where + `
            ORDER BY ` + order + `
            LIMIT ` + limit;
}

// Every leg of one round in one bounded read, oldest first so the caller renders the
// lifecycle in the order it happened. request_id+version is indexed.
//
// `blocks` resolves off the action's own block_index, not the transaction's: a
// mirror-applied response has an action_index but no transaction row, and routing
// through t1 left the timestamp NULL for it (attest-response-mirror spec section 4.4).
async function readAttestationLegs(db, config, requestId, limit, withBatch){
    return await db.doQuery(config,
        legQuery(withBatch, 'm.request_id=?', 'm.version ASC, m.action_index ASC', limit), [requestId]);
}

function isTerminal(row){
    return !!row && row.status === 'valid' && TERMINAL_RESPONSE_STATUSES.includes(row.response_status);
}

// The response row among the rows read: the first valid terminal round, else the
// newest valid retry (a request still pending), else the newest v1 row of any status.
function pickResponseLeg(rows){
    const rounds = rows.filter(r => Number(r.version) === 1);
    return rounds.find(isTerminal)
        || rounds.slice().reverse().find(r => r.status === 'valid')
        || rounds[rounds.length - 1] || null;
}

// The same ranking as pickResponseLeg over the whole request, for a legs read that
// hit its LIMIT: retry rounds are bounded only by the deadline, so the terminal row
// can sit past the cap, and its callback link and relay flag with it.
async function readResponseLeg(db, config, requestId, withBatch){
    const tier = `CASE WHEN s1.status='valid' AND m.response_status IN ('ok','expired') THEN 2
                      WHEN s1.status='valid' THEN 1 ELSE 0 END`;
    const order = tier + ' DESC, CASE WHEN ' + tier + ' = 2 THEN m.action_index END ASC, m.action_index DESC';
    const rows = await db.doQuery(config, legQuery(withBatch, 'm.request_id=? AND m.version=1', order, 1), [requestId]);
    return (rows && rows.length) ? rows[0] : null;
}

// The v1 RESPONSE leg, carrying the quorum set that signed it. The extra read runs
// only when the legs read was full and did not already hold the terminal round.
async function resolveResponseLeg(db, config, rows, requestId, limit, withBatch){
    let response = pickResponseLeg(rows);
    if(rows.length >= Number(limit) && !isTerminal(response))
        response = (await readResponseLeg(db, config, requestId, withBatch)) || response;
    if(response) response.quorum_signatures = db.parseSignaturesArray(response.validator_signatures);
    return response;
}

module.exports = { readAttestationLegs, pickResponseLeg, resolveResponseLeg };
