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

const {
    ANCHOR_DETAIL,
    ANCHOR_SECTIONS,
    ATTEST_DETAIL,
    NODEPROOF_DETAIL,
    NODEPROOF_VERIFICATIONS,
    PRICE_DETAIL,
    ROLLCALL_DETAIL,
    ROLLCALL_SIGNERS
} = require('../db/action_detail/consensus_sql');

// One logger for the whole service, cached at require time per the
// observability contract: getLogger() returns a lazy singleton that resolves to
// the real shipper once the entry point installs it.
const { getLogger } = require('../observability');
const log = getLogger();

const ANCHOR = {
    // ANCHOR action (DOGE-only). The wire set restarted at v0: v0 is
    // the per-network checkpoint bundle, v1 the archive head (carries both its
    // own checkpoint fields and the match archive, plus a publisher-attestation
    // tail that may legitimately be empty, D4), v2 the archive continuation
    // chunk. Every row mined below ANCHOR_ACTIVATION for its network reused
    // these same version bytes under an older, unrelated meaning; this query has
    // no version filter and selects every row identically regardless of version
    // or activation, so a legacy row's columns come back exactly as stored and
    // it is the RENDERER's job (anchor_detail_render.js) to tell a legacy row
    // from a current one, not this query's. archive_b64 is omitted (large; only
    // the recovery assembler needs it). The SPV root columns (state_root,
    // state_root_version, block_merkle_root, block_merkle_version) and
    // publisher / publisher_attestations (the elected PUBLISHER pubkey and the
    // raw XANCPUB quorum sigs) are NULL on rows that never carried them; all are
    // selected unconditionally so the detail view matches the getAnchors() list
    // and checkpoint-reader surfaces, and consumers re-verify rather than trust
    // this display-only transport.
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = ANCHOR_DETAIL;
        query2 = ANCHOR_SECTIONS;
        return { query, query2, query3 };
    },
    // Attach the per-chain sections of a v0 bundle. Gated on version 0 exactly as
    // db.getAnchor gates its own section read: every other version is a single
    // checkpoint or an archive chunk, and presenting it as a one-section bundle would
    // invent a structure it does not have.
    //
    // snapshot_block on the header is the BUNDLE's block, the MAX over the sections. A
    // chain that lagged rides at its own older section snapshot_block, while the
    // election and the publisher attestation are both drawn at the MAX, so section 0's
    // block as the bundle's looks the electorate up at the wrong height.
    afterQuery2(ctx, data, results) {
        let sections = Array.isArray(results) ? results : [];
        data['sections']      = [];
        data['section_count'] = 1;
        if(Number(data['version']) !== 0) return;
        data['sections']      = sections;
        data['section_count'] = sections.length || 1;
        let blocks = sections
            .map(s => (s.snapshot_block === null || s.snapshot_block === undefined) ? null : Number(s.snapshot_block))
            .filter(v => v !== null && !Number.isNaN(v));
        if(blocks.length) data['snapshot_block'] = Math.max(...blocks);
    },
    // Expand the inlined publisher-attestation JSON on ANCHOR responses that
    // carry a publisher tail (today's v0 bundle and v1 archive head; formerly
    // v4/v5/v6 before the wire set restarted) into a structured array
    // the action-detail page can render. NULL/absent on every other row, which
    // yields an empty array so the client leaves the publisher row hidden.
    afterMain({ action_index }, data) {
        if(data['publisher_attestations']){
            try { data['publisher_attestations'] = JSON.parse(data['publisher_attestations']); }
            catch(_) { log.warn('ACTION_DETAIL_JSON_PARSE_FAILED', { action: 'ANCHOR', field: 'publisher_attestations', action_index, err: _.message }); data['publisher_attestations'] = []; }
        } else {
            data['publisher_attestations'] = [];
        }
    },
};

const ATTEST = {
    // ATTEST action. Every version lives in `attests`, distinguished by `version`:
    // v0 request and v1 response (verified federation sigs ride in the
    // validator_signatures JSON column on v1 rows), plus the batch pair, v5 head
    // and v6 continuation. A batch row is a CHUNK TABLE entry on the ANCHOR archive
    // precedent: the head carries the signed window header (start/end, row count, the
    // BTC height its quorum snapshot is drawn at) and slot 0, each continuation
    // carries one later slot, and every v0/v1 column is NULL on both. request_id
    // holds the batch key there and provider_id is the empty string. batch_chunk_b64
    // is omitted for the same reason ANCHOR omits archive_b64 above: it is large and
    // only the reassembler reads it.
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = ATTEST_DETAIL;
        return { query, query2, query3 };
    },
    // Expand the inlined validator-signature JSON on ATTEST responses into
    // a structured array the action-detail page can render.
    async afterMain({ db, config, action_index }, data) {
        if(data['validator_signatures']){
            try { data['signatures'] = JSON.parse(data['validator_signatures']); }
            catch(_) { log.warn('ACTION_DETAIL_JSON_PARSE_FAILED', { action: 'ATTEST', field: 'validator_signatures', action_index, err: _.message }); data['signatures'] = []; }
        } else {
            data['signatures'] = [];
        }
        delete data['validator_signatures'];
        // ATTEST v2 (expire) is system-synthesized and writes no attests row
        // (it only flips the original v0 request's status), so the attests
        // branch returned nothing and the de-blank fallback populated only
        // baseline fields, leaving version NULL. Tag the version from the
        // action format so the client badges it 'Expire (v2)' instead of
        // mislabeling it 'Request (v0)'.
        if(db.util.isNull(data['version']) && !db.util.isNull(data['action_format']))
            data['version'] = data['action_format'];
        // A v2 page that names nothing is a dead end: REQUEST_ID is on the wire (the
        // synthetic action is VERSION|REQUEST_ID) but no column persists it, so the
        // page rendered Request ID, Provider and Contract blank beside a badge saying
        // this action expired something. The request is recovered from the SAME
        // in-block correlation the lifecycle page uses (db.correlateAttestationExpiries),
        // which resolves to null rather than to a guess when the block's two lists
        // disagree; a page with no link beats a page with the wrong one.
        if(Number(data['version']) === 2 && db.util.isNull(data['request_id'])){
            let request = await db.resolveAttestationExpireRequest(config, action_index, data['block_index']);
            if(request){
                data['request_id']           = request.request_id;
                data['provider_id']          = request.provider_id;
                data['contract_index']       = request.contract_index;
                data['request_action_index'] = request.action_index;
                data['request_status']       = request.request_status;
                data['deadline_block']       = request.deadline_block;
                // The expired callback the sweep injected. Same derivation the
                // lifecycle page uses, and null when there was no callback to fire.
                data['callback_execute_action_index'] = await db.deriveAttestationCallbackExecute(config, request);
            }
        }
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
        query = NODEPROOF_DETAIL;
        return { query, query2, query3 };
    },
    // NODEPROOF: attach the per-validator PASS list this verdict recorded. One row
    // per verified full node (sharing this action_index), each carrying the verified
    // signing pubkey and its staking source address (index_pubkeys / index_addresses).
    async afterMain({ db, config, action_index }, data) {
        let verifs = await db.doQuery(config, NODEPROOF_VERIFICATIONS, [action_index]);
        data['verifications'] = (verifs && verifs.length) ? verifs : [];
    },
};

const PRICE = {
    // PRICE action (v0 validator COIN/FIAT snapshot, v0 validator BATCH of rounds,
    // v1 user TOKEN/FIAT oracle).
    //
    // THE BATCH COLUMNS ARE NOT OPTIONAL EXTRAS. A validator PRICE on the wire today
    // is a BATCH (PRICE|0|Z|<deflate> carrying an hourly window of full round bodies),
    // and the indexer deliberately stores NULL in pair_count / pairs_json / sig_count
    // for one (xchain-indexer src/actions/price/index.js: those three would describe only one
    // round out of the window), putting the actual COIN/FIAT prices in rounds_json and
    // the window in batch_first_round / batch_last_round / round_count. Selecting only
    // the single-round columns is why a batch rendered as a page of dashes with every
    // price it carried sitting unread in the row.
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = PRICE_DETAIL;
        return { query, query2, query3 };
    },
    // Expand the inlined JSON columns on PRICE actions into structured arrays so
    // third parties can read the COIN/FIAT pairs and the PBFT signature set.
    // `rounds` is the batch's per-round bodies ([{round, timestamp, btc_block_height,
    // pairs:[{pair, price}]}]) - the same shape the indexer stored and pushed to the
    // hub, so a reader sees the window exactly as the signers signed it. All three
    // columns are dropped from the response after expansion: a consumer reads the
    // arrays, not a JSON string wrapped in JSON.
    afterMain({ action_index }, data) {
        if(data['pairs_json']){
            try { data['pairs'] = JSON.parse(data['pairs_json']); }
            catch(_) { log.warn('ACTION_DETAIL_JSON_PARSE_FAILED', { action: 'PRICE', field: 'pairs_json', action_index, err: _.message }); data['pairs'] = []; }
        }
        if(data['sigs_json']){
            try { data['signatures'] = JSON.parse(data['sigs_json']); }
            catch(_) { log.warn('ACTION_DETAIL_JSON_PARSE_FAILED', { action: 'PRICE', field: 'sigs_json', action_index, err: _.message }); data['signatures'] = []; }
        }
        if(data['rounds_json']){
            try { data['rounds'] = JSON.parse(data['rounds_json']); }
            catch(_) { log.warn('ACTION_DETAIL_JSON_PARSE_FAILED', { action: 'PRICE', field: 'rounds_json', action_index, err: _.message }); data['rounds'] = []; }
        }
        delete data['pairs_json'];
        delete data['sigs_json'];
        delete data['rounds_json'];
    },
};

const ROLLCALL = {
    // ROLLCALL action (liveness roll call, DOGE-only, validator-broadcast).
    // Wire: ROLLCALL|0|EPOCH_HEIGHT|LEDGER_HASH|PUBLISHER|SIG_COUNT|PUBKEY_i|SIG_i...
    //
    // NO LEDGER EFFECTS ON THIS action_index. The publish reward exists
    // (ROLLCALL_REWARD_AMOUNT) but it is credited by the BTC-side epoch close
    // (xchain-indexer/src/consensus/rollcall_close.js), on a different chain from the action
    // being rendered here, so credits/debits/escrows keyed on this action_index are
    // always empty. Same shape as NODEPROOF above.
    effects: { credits: false, debits: false, escrows: false },
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        // epoch_height / ledger_hash / publisher are action-level constants repeated
        // on every rollcall_signers row this action wrote, so any one row carries
        // them; the per-validator present list is attached in afterMain below.
        query = ROLLCALL_DETAIL;
        return { query, query2, query3 };
    },
    // The signer list IS the present list: a validator is recorded present at an
    // epoch precisely by having signed the canonical. Scoped to THIS action_index,
    // not to the epoch: rollcall_signers is unique on (epoch_height, pubkey) with
    // INSERT IGNORE, so it is a first-seen index across the whole epoch, and several
    // ROLLCALL actions per epoch are EXPECTED and union together. Showing the epoch's
    // full union on one action's page would credit this action with signatures it
    // did not carry.
    //
    // Ordered by pubkey, not by an autoincrement: rollcall_signers has NO id column
    // (its primary key is the composite (epoch_height, pubkey)), so the `ORDER BY id`
    // that the NODEPROOF handler above can use would be a SQL error here.
    async afterMain({ db, config, action_index }, data) {
        let signers = await db.doQuery(config, ROLLCALL_SIGNERS, [action_index]);
        data['signers'] = (signers && signers.length) ? signers : [];
        // ROLLCALL v1 GATES field as carried on this action's row (comma-joined
        // '<module>.<EXPORT>' consensus-gate keys, `rollcall_signers.gates`); NULL
        // on every v0 row, so the client badges v0 without a gates list and v1 as
        // 'ROLLCALL v1' with the parsed list (action_format already selected above).
        data['gates'] = data['gates'] ? data['gates'].split(',') : [];
    },
};

module.exports = {
    ANCHOR,
    ATTEST,
    NODEPROOF,
    PRICE,
    ROLLCALL
};
