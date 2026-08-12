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
 * Detail handlers for the validator-produced actions: ANCHOR checkpoints,
 * ATTEST, NODEPROOF verdicts and PRICE oracle rounds.
 ********************************************************************/

'use strict';

const ANCHOR = {
    // ANCHOR action (DOGE-only). v0 checkpoint, v1 checkpoint+archive, v2
    // continuation chunk, v3 checkpoint+SPV roots (post CHECKPOINT_COMMITMENT
    // flag-day), v4 v0+publisher attestation (rootless), v5 v3+publisher
    // attestation (root-bearing, mainnet-preferred), v6 v1+publisher attestation
    // (post ARCHIVE_REWARD flag-day). archive_b64 is omitted (large; only the
    // recovery assembler needs it). The SPV root columns (state_root,
    // state_root_version, block_merkle_root, block_merkle_version) are NULL
    // except on v3/v5, and publisher / publisher_attestations (the elected
    // PUBLISHER pubkey and the raw XANCPUB quorum sigs) are NULL except on
    // v4/v5/v6; all are selected unconditionally so the detail view matches the
    // getAnchors() list and checkpoint-reader surfaces, and consumers re-verify
    // rather than trust this display-only transport.
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = `SELECT
                    a2.action,
                    a1.action_format,
                    m.action_index,
                    m.version,
                    m.chain,
                    m.network,
                    b1.block_index,
                    m.block_index as anchored_block_index,
                    m.block_hash,
                    m.ledger_hash,
                    m.actions_hash,
                    m.contract_hash,
                    m.checkpoint_seq,
                    m.snapshot_block,
                    m.match_batch_seq,
                    m.match_count,
                    m.batch_crc32,
                    m.total_chunks,
                    m.chunk_index,
                    m.state_root,
                    m.state_root_version,
                    m.block_merkle_root,
                    m.block_merkle_version,
                    m.validator_signatures,
                    m.block_index_doge,
                    m.publisher,
                    m.publisher_attestations,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    s1.status
                FROM
                    anchor_actions m
                    INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                    INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                WHERE
                    m.action_index=?
                LIMIT 1`;
        return { query, query2, query3 };
    },
    // Expand the inlined publisher-attestation JSON on ANCHOR v4/v5/v6 responses
    // into a structured array the action-detail page can render. NULL/absent for
    // v0-v3 (and the rootless/archive variants without a publisher tail), which
    // yields an empty array so the client leaves the publisher row hidden.
    afterMain({ action_index }, data) {
        if(data['publisher_attestations']){
            try { data['publisher_attestations'] = JSON.parse(data['publisher_attestations']); }
            catch(_) { console.warn('getActionData: ANCHOR publisher_attestations parse failed for action_index=' + action_index + ':', _); data['publisher_attestations'] = []; }
        } else {
            data['publisher_attestations'] = [];
        }
    },
};

const ATTEST = {
    // ATTEST action (v0 request / v1 response; both rows live in `attests`,
    // distinguished by `version`; verified federation sigs ride in the
    // validator_signatures JSON column on v1 rows)
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = `SELECT
                    a2.action,
                    a1.action_format,
                    m.action_index,
                    m.version,
                    m.request_id,
                    m.provider_id,
                    m.contract_index,
                    fp.address as fee_payer,
                    m.callback_method,
                    m.redundancy,
                    m.deadline_block,
                    m.gas_escrow,
                    m.fee_amount,
                    ft.tick as fee_tick,
                    m.request_status,
                    m.response_hash,
                    m.response_status,
                    m.response_payload,
                    m.meta,
                    m.validator_signatures,
                    m.callback_execute_action_index,
                    m.payload,
                    m.callback_params_json,
                    a3.address as source,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    s1.status
                FROM
                    attests m
                    INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                    LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                    LEFT  JOIN index_addresses    fp ON (fp.id=m.fee_payer_id)
                    LEFT  JOIN index_tickers      ft ON (ft.id=m.fee_tick_id)
                    LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                WHERE
                    m.action_index=?
                LIMIT 1`;
        return { query, query2, query3 };
    },
    // Expand the inlined validator-signature JSON on ATTEST responses into
    // a structured array the action-detail page can render.
    afterMain({ db, action_index }, data) {
        if(data['validator_signatures']){
            try { data['signatures'] = JSON.parse(data['validator_signatures']); }
            catch(_) { console.warn('getActionData: ATTEST validator_signatures parse failed for action_index=' + action_index + ':', _); data['signatures'] = []; }
        } else {
            data['signatures'] = [];
        }
        delete data['validator_signatures'];
        // ATTEST v2 (expire) is system-synthesized and writes no attests row
        // (it only flips the original v0 request's status), so the attests
        // branch returned nothing and the de-blank fallback populated only
        // baseline fields, leaving version NULL. Tag the version from the
        // action format so the client badges it 'Expire (v2)' instead of
        // mislabeling it 'Request (v0)'. The correlated v0 request's fields
        // are not resolvable here (the indexer stores no link from the
        // expire action to the request), so only baseline data + version show.
        if(db.util.isNull(data['version']) && !db.util.isNull(data['action_format']))
            data['version'] = data['action_format'];
    },
};

const NODEPROOF = {
    effects: { credits: false, debits: false, escrows: false },
    // NODEPROOF action (full-node possession-proof verdict v0). The verdict is a
    // single quorum-signed action that writes one full_node_verifications row per
    // PASS pubkey, all sharing this action_index; so challenge_id/epoch_height/
    // target_height are verdict-level constants (pulled here from any one row) and
    // the per-validator PASS list is attached as `verifications` below.
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = `SELECT
                    a4.action,
                    a1.action_format,
                    m.action_index,
                    m.challenge_id,
                    m.epoch_height,
                    m.target_height,
                    a2.address as source,
                    m.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index
                FROM
                    full_node_verifications m
                    INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                    INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                    LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                WHERE
                    m.action_index=?
                LIMIT 1`;
        return { query, query2, query3 };
    },
    // NODEPROOF: attach the per-validator PASS list this verdict recorded. One row
    // per verified full node (sharing this action_index), each carrying the verified
    // signing pubkey and its staking source address (index_pubkeys / index_addresses).
    async afterMain({ db, config, action_index }, data) {
        let verifs = await db.doQuery(config,
            `SELECT
                    m.signing_pubkey_id,
                    pk.pubkey as signing_pubkey,
                    m.source_id,
                    a3.address as staking_source,
                    m.passed,
                    m.block_index
             FROM full_node_verifications m
                LEFT JOIN index_pubkeys   pk ON (pk.id=m.signing_pubkey_id)
                LEFT JOIN index_addresses a3 ON (a3.id=m.source_id)
             WHERE m.action_index=?
             ORDER BY m.id ASC`, [action_index]);
        data['verifications'] = (verifs && verifs.length) ? verifs : [];
    },
};

const PRICE = {
    // PRICE action (v0 validator COIN/FIAT snapshot + v1 user TOKEN/FIAT oracle)
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = `SELECT
                    a4.action,
                    m.action_index,
                    a1.action_format,
                    m.version,
                    a2.address as source,
                    m.round_number,
                    m.round_timestamp,
                    m.pair_count,
                    m.pairs_json,
                    m.sig_count,
                    m.sigs_json,
                    c1.coin,
                    t3.tick,
                    f1.code as fiat,
                    m.value,
                    m.fee as oracle_fee,
                    m.validation_status,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    m1.memo,
                    s1.status
                FROM
                    prices m
                    INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                    INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                    LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                    LEFT  JOIN index_coins        c1 ON (c1.id=m.coin_id)
                    LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                    LEFT  JOIN index_fiats        f1 ON (f1.id=m.fiat_id)
                    LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                    LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                WHERE
                    m.action_index=?
                LIMIT 1`;
        return { query, query2, query3 };
    },
    // Expand the inlined JSON columns on PRICE actions into structured arrays so
    // third parties can read the COIN/FIAT pairs and the PBFT signature set (v0).
    afterMain({ action_index }, data) {
        if(data['pairs_json']){
            try { data['pairs'] = JSON.parse(data['pairs_json']); }
            catch(_) { console.warn('getActionData: PRICE pairs_json parse failed for action_index=' + action_index + ':', _); data['pairs'] = []; }
        }
        if(data['sigs_json']){
            try { data['signatures'] = JSON.parse(data['sigs_json']); }
            catch(_) { console.warn('getActionData: PRICE sigs_json parse failed for action_index=' + action_index + ':', _); data['signatures'] = []; }
        }
        delete data['pairs_json'];
        delete data['sigs_json'];
    },
};

module.exports = {
    ANCHOR,
    ATTEST,
    NODEPROOF,
    PRICE
};
