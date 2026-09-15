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
 * XChain Explorer - WHERE clauses for the standalone and hub-mirrored lists
 *
 * One part of src/db/query_sql.js: the clause builders for the tables that do
 * NOT hang off the actions/transactions/blocks chain (slash and capability
 * events, the price/oracle rollups, the hub-mirrored match, reorg, checkpoint
 * and governance tables, the operational p2p/config/telemetry tables), plus the
 * anchor and xcall lists that do join the chain but filter on their own columns.
 * Each builder takes the anchor the entry resolved and returns the whole WHERE
 * text for its method.
 *
 * Plain functions, not a class body: nothing here reaches Database.prototype.
 *
 ********************************************************************/

'use strict';

function slashEventsClause(db, config, sql){
    let type = config.data.type;
    // slash_events has no actions/transactions chain; join directly via m.block_index
    // and resolve type=address through the staker's pubkey (signing_pubkey_id).
    if(type=='block')    sql += ' AND m.block_index=?';
    if(type=='contract') sql += ' AND m.target_contract_index=?';
    if(type=='address')  sql += ` AND m.signing_pubkey_id IN (
                SELECT DISTINCT signing_pubkey_id FROM contract_stakes
                WHERE source_id = (SELECT id FROM index_addresses WHERE address=?)
            )`;
    return sql;
}

function capabilitySlashEventsClause(db, config, sql){
    let type = config.data.type;
    // capability_slash_events joins blocks directly; filter by block, capability engine, or pubkey.
    if(type=='block')      sql += ' AND m.block_index=?';
    if(type=='capability') sql += ' AND m.capability=?';
    if(type=='pubkey')     sql += ' AND pk.pubkey=?';
    if(type=='address')    sql += ' AND sub.address=?';
    return sql;
}

function fullNodeVerificationsClause(db, config, sql){
    let type = config.data.type;
    // full_node_verifications joins the actions/transactions/blocks chain via
    // m.action_index (one row per verified validator). Filter on the verdict's own
    // block (m.block_index), the challenge epoch (m.epoch_height), the verified
    // signing pubkey (pk), or the staking source address (a3, joined on m.source_id).
    if(type=='block')   sql += ' AND m.block_index=?';
    if(type=='epoch')   sql += ' AND m.epoch_height=?';
    if(type=='pubkey')  sql += ' AND pk.pubkey=?';
    if(type=='address') sql += ' AND a3.address=?';
    return sql;
}

function priceSnapshotsClause(db, config, sql){
    let type = config.data.type;
    // price_snapshots is a standalone table; filter on its own columns directly
    if(type=='pair')   sql += ' AND m.coin_pair=?';
    if(type=='round')  sql += ' AND m.round_number=?';
    if(type=='status') sql += ' AND m.status=?';
    return sql;
}

function oraclePricesClause(db, config, sql){
    let type = config.data.type;
    // oracle_prices is a standalone hub-mirror table; filter on its own columns
    if(type=='token')   sql += ' AND m.tick=?';
    if(type=='address') sql += ' AND m.source_address=?';
    return sql;
}

function attestValidatorStatsClause(db, config, sql){
    let type = config.data.type;
    // attest_validator_stats is a standalone counters table; filter on its own
    // unique-key columns directly. No 'block' type: last_updated_block is a
    // mutable "most recently touched" stamp, not a stable per-row block identity,
    // so filtering on it would answer a question that drifts under the caller.
    if(type=='pubkey')   sql += ' AND m.validator_pubkey=?';
    if(type=='provider') sql += ' AND m.provider_id=?';
    return sql;
}

function validatorCapabilitiesClause(db, config, sql){
    let type = config.data.type;
    if(type=='capability') sql += ' AND m.capability=?';
    if(type=='pubkey')     sql += ' AND m.signing_pubkey=?';
    return sql;
}

function capabilitySnapshotsClause(db, config, sql){
    let type = config.data.type;
    // capability_snapshots is the historical electorate: which signing keys
    // carried which stake weight for a capability at a given snapshot block.
    // 'block' answers the row's core question (electorate AT block N);
    // 'capability' and 'pubkey' narrow the other two axes.
    if(type=='block')      sql += ' AND m.snapshot_block=?';
    if(type=='capability') sql += ' AND m.capability=?';
    if(type=='pubkey')     sql += ' AND m.signing_pubkey=?';
    return sql;
}

function governanceProposalsClause(db, config, sql){
    let type = config.data.type;
    if(type=='status')    sql += ' AND m.status=?';
    if(type=='parameter') sql += ' AND m.parameter=?';
    if(type=='proposal')  sql += ' AND m.proposal_id=?';
    return sql;
}

function governanceVotesClause(db, config, sql){
    let type = config.data.type;
    if(type=='proposal') sql += ' AND m.proposal_id=?';
    if(type=='voter')    sql += ' AND m.voter_pubkey=?';
    return sql;
}

function peersClause(db, config, sql){
    // p2p_peers is a hub-local operational table; filter on its own columns.
    if(config.data.type=='validator') sql += ' AND m.validator_id=?';
    return sql;
}

function consensusStateClause(db, config, sql){
    // consensus_state is a key/value table; filter by key_name.
    if(config.data.type=='key') sql += ' AND m.key_name=?';
    return sql;
}

function configsClause(db, config, sql){
    let type = config.data.type;
    // configs is the hub config oracle store (coin/network/module/param);
    // filter by coin or module.
    if(type=='coin')   sql += ' AND m.coin=?';
    if(type=='module') sql += ' AND m.module=?';
    return sql;
}

function telemetryPingsClause(db, config, sql){
    let type = config.data.type;
    // telemetry_pings is anonymous xchain-node telemetry; filter by event
    // type, anonymous install UUID, or country.
    if(type=='event')   sql += ' AND m.event=?';
    if(type=='install') sql += ' AND m.install_id=?';
    if(type=='country') sql += ' AND m.country=?';
    return sql;
}

function crossChainClause(db, config, sql){
    let type   = config.data.type;
    let method = config.data.method;
    // standalone mirror tables (no actions/transactions chain); filter on
    // their own columns directly. matches carry snapshot_block (the
    // BTC-anchored quorum block); settlements carry the local block_index.
    if(type=='match')  sql += ' AND m.match_id=?';
    if(type=='block')  sql += (method=='getCrossChainSettlements') ? ' AND m.block_index=?' : ' AND m.snapshot_block=?';
    if(type=='status' && method=='getCrossChainMatches') sql += ' AND m.status=?';
    return sql;
}

function reorgsClause(db, config, sql){
    let type = config.data.type;
    // reorg_attestations is a hub-mirrored, cross-chain table; the mandatory
    // per-coin chain scope is appended separately in getReorgs (matching
    // getCrossChainMatches' network filter above), so this branch only narrows
    // WITHIN that scope. 'block' reuses the platform-wide block-height type name
    // (reorg_height IS a block height).
    if(type=='status') sql += ' AND m.status=?';
    if(type=='block')  sql += ' AND m.reorg_height=?';
    return sql;
}

function slashProposalsClause(db, config, sql){
    let type = config.data.type;
    // Platform-global table (no chain axis), so these are the only two
    // filters, and they mirror the hub RPC's two server-side filters exactly
    // so neither transport has to post-filter. No 'block' type: round_number
    // is an oracle round (or an attestation pseudo-round), not a block height,
    // and QUERY_DESC['block'] reads 'block height'.
    if(type=='status') sql += ' AND m.status=?';
    if(type=='pubkey') sql += ' AND m.validator_pubkey=?';
    return sql;
}

function emissionsClause(db, config, sql){
    let type = config.data.type;
    // contract_emissions carries no contract_index of its own (it is reachable
    // only by joining through contract_executions on execution_index), so
    // contract/block filter the joined `ce` alias. block_index lives on
    // contract_executions directly, which is why this does NOT reuse the generic
    // b1.block_index branch below (that one assumes an actions/blocks join this
    // method does not make). 'execution' filters contract_emissions' own indexed
    // execution_index column.
    if(type=='contract')  sql += ' AND ce.contract_index=?';
    if(type=='execution') sql += ' AND m.execution_index=?';
    if(type=='block')     sql += ' AND ce.block_index=?';
    return sql;
}

function xcallsClause(db, config, sql){
    let type = config.data.type;
    // xcalls joins the actions/transactions/blocks chain (b1 alias); filter on its own columns.
    // contract = the source contract that emitted the call (contract_index, now indexed).
    if(type=='block')    sql += ' AND b1.block_index=?';
    if(type=='contract') sql += ' AND m.contract_index=?';
    if(type=='status')   sql += ' AND m.request_status=?';
    return sql;
}

function anchorsClause(db, config, sql){
    let type = config.data.type;
    // anchor_actions joins the actions/transactions/blocks chain (b1 via t1); filter on its own columns.
    if(type=='block')   sql += ' AND b1.block_index=?';
    if(type=='chain')   sql += ' AND m.chain=?';
    if(type=='network') sql += ' AND m.network=?';
    if(type=='status')  sql += ' AND s1.status=?';
    return sql;
}

function anchorRewardAttestationsClause(db, config, sql){
    let type = config.data.type;
    // anchor_reward_attestations is a standalone hub-mirror table (no actions/
    // transactions chain); filter on its own columns. 'anchor' answers "the rewards
    // behind THIS ANCHOR transaction"; 'block' matches the table's own
    // idx_snapshot_block (network, snapshot_block) key; 'pubkey' narrows to one
    // elected publisher's reward history.
    if(type=='anchor')  sql += ' AND m.doge_anchor_txid=?';
    if(type=='block')   sql += ' AND m.snapshot_block=?';
    if(type=='pubkey')  sql += ' AND m.publisher=?';
    return sql;
}

function commitmentsClause(db, config, sql){
    // state_tree_roots has no actions/transactions/blocks chain; filter on its own
    // column directly, matching getAnchors/getCrossChainMatches above.
    if(config.data.type=='block') sql += ' AND m.block_index=?';
    return sql;
}

function xcallClause(db, config, sql){
    // single-call lifecycle keyed by the deterministic 64-hex call_id
    sql += ' AND m.call_id=?';
    return sql;
}

const MIRROR_CLAUSE_BUILDERS = {
    getSlashEvents:               slashEventsClause,
    getCapabilitySlashEvents:     capabilitySlashEventsClause,
    getFullNodeVerifications:     fullNodeVerificationsClause,
    getPriceSnapshots:            priceSnapshotsClause,
    getOraclePrices:              oraclePricesClause,
    getAttestValidatorStats:      attestValidatorStatsClause,
    getValidatorCapabilities:     validatorCapabilitiesClause,
    getCapabilitySnapshots:       capabilitySnapshotsClause,
    getGovernanceProposals:       governanceProposalsClause,
    getGovernanceVotes:           governanceVotesClause,
    getPeers:                     peersClause,
    getConsensusState:            consensusStateClause,
    getConfigs:                   configsClause,
    getTelemetryPings:            telemetryPingsClause,
    getCrossChainMatches:         crossChainClause,
    getCrossChainSettlements:     crossChainClause,
    getReorgs:                    reorgsClause,
    getSlashProposals:            slashProposalsClause,
    getEmissions:                 emissionsClause,
    getXcalls:                    xcallsClause,
    getAnchors:                   anchorsClause,
    getAnchorRewardAttestations:  anchorRewardAttestationsClause,
    getCommitments:               commitmentsClause,
    getXcall:                     xcallClause
};

module.exports = { MIRROR_CLAUSE_BUILDERS };
