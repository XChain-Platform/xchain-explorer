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
 * XChain Explorer - cross-chain, slash and governance lists
 *
 * Cross-chain matches and settlements, both slash event families, the hub
 * governance proposals and votes, and the federation slash proposals.
 *
 * One part of src/db/readers/staking_governance.js (the entry composes it through
 * composeReaderParts). Authored as a class body whose prototype is exported,
 * like every other family under src/db/: `this` is the Database instance at
 * call time, and the methods reach Database.prototype non-enumerable, by
 * descriptor.
 *
 ********************************************************************/

'use strict';

class GovernanceReaders {
    // Get list of cross-chain MATCH records (type ∈ {match, block, status}; block = snapshot_block).
    // cross_chain_matches is a standalone mirror of the hub's finalized match table with no
    // actions/transactions chain, so no joins; ordered by the mirror cursor m.id.
    // validator_signatures (the 2f+1 quorum proof) is included: matches have no separate
    // detail endpoint, and the proof is the point of inspecting one.
    async getCrossChainMatches(config){
        let sql   = config.data.sql;
        // cross_chain_matches is hub-mirrored: xchain-sync never replicates it, so it is
        // served only from the mandatory co-located hub DB, never from a stale local mirror.
        // matchSource throws (fail loud) if no co-located hub DB is configured for this coin.
        // The hub table is multi-network, so a network filter rides along; it appends one `?`
        // AFTER any type filter in sql.where.data, so the returned args must be ordered
        // [<type filter?>, network].
        let src   = this.matchSource(config);
        let count = `SELECT
                        count(*) as total
                    FROM
                        ${src.table} m
                    WHERE ` + sql.where.data + src.networkFilter;
        let query = `SELECT
                        m.id,
                        m.match_id,
                        m.snapshot_block,
                        m.network,
                        m.a_chain,
                        m.a_action_index,
                        m.a_kind,
                        m.a_tick,
                        m.a_amount,
                        m.a_filled_before,
                        m.a_ownership,
                        m.a_payout_addr,
                        m.b_chain,
                        m.b_action_index,
                        m.b_kind,
                        m.b_tick,
                        m.b_amount,
                        m.b_filled_before,
                        m.b_ownership,
                        m.b_payout_addr,
                        m.effective_time,
                        m.validator_signatures,
                        m.status,
                        m.batch_root,
                        m.anchor_txid,
                        m.finalizing_view,
                        m.created_at
                    FROM
                        ${src.table} m
                    WHERE ` + sql.where.data + src.networkFilter + sql.where.offset +`
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        // Non-redirect path: keep args null (baseArgs defaults to [config.data.search],
        // current behavior). Redirect path: supply explicit args so the network `?` binds;
        // [config.data.search] only when a type filter (match/block/status) added its own `?`.
        let args = null;
        if(src.networkParam !== null){
            let typeArgs = ['match','block','status'].includes(config.data.type) ? [config.data.search] : [];
            args = [...typeArgs, src.networkParam];
        }
        return [query, args, count];
    }

    async getCrossChainSettlements(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        cross_chain_settlements m
                        INNER JOIN blocks             b1 ON (b1.block_index=m.block_index)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        m.action_index,
                        m.match_id,
                        m.local_action_index,
                        m.block_index,
                        b1.block_time as timestamp
                    FROM
                        cross_chain_settlements m
                        INNER JOIN blocks             b1 ON (b1.block_index=m.block_index)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Get list of SLASH events (xchain.contract.slash emissions, type in {address, block, contract})
    // slash_events has no action_index of its own (side-effect of an EXECUTE), so this joins
    // blocks directly via m.block_index and orders by m.id rather than action_index.
    async getSlashEvents(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        slash_events m
                        INNER JOIN blocks             b1 ON (b1.block_index=m.block_index)
                        LEFT  JOIN index_pubkeys      a3 ON (a3.id=m.signing_pubkey_id)
                        LEFT  JOIN index_addresses    a4 ON (a4.id=m.destination_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        m.id,
                        m.execution_index,
                        m.target_contract_index,
                        a3.pubkey as slashed_pubkey,
                        a4.address as destination,
                        t3.tick,
                        m.amount,
                        m.block_index,
                        b1.block_time as timestamp
                    FROM
                        slash_events m
                        INNER JOIN blocks             b1 ON (b1.block_index=m.block_index)
                        LEFT  JOIN index_pubkeys      a3 ON (a3.id=m.signing_pubkey_id)
                        LEFT  JOIN index_addresses    a4 ON (a4.id=m.destination_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Get list of capability_slash_events (equivocation bond-burns against consensus validators).
    // Mirrors getSlashEvents; joins blocks directly via m.block_index.
    // type in {block, capability, pubkey, address} where address matches the submitter.
    async getCapabilitySlashEvents(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        capability_slash_events m
                        INNER JOIN blocks             b1 ON (b1.block_index=m.block_index)
                        LEFT  JOIN index_pubkeys      pk ON (pk.id=m.signing_pubkey_id)
                        LEFT  JOIN index_addresses    sub ON (sub.id=m.submitter_id)
                        LEFT  JOIN index_addresses    dst ON (dst.id=m.destination_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        m.id,
                        m.slash_action_index,
                        pk.pubkey as slashed_pubkey,
                        m.capability,
                        m.equiv_key,
                        m.amount,
                        m.bounty_amount,
                        m.treasury_amount,
                        sub.address as submitter,
                        dst.address as destination,
                        m.block_index,
                        b1.block_time as timestamp
                    FROM
                        capability_slash_events m
                        INNER JOIN blocks             b1 ON (b1.block_index=m.block_index)
                        LEFT  JOIN index_pubkeys      pk ON (pk.id=m.signing_pubkey_id)
                        LEFT  JOIN index_addresses    sub ON (sub.id=m.submitter_id)
                        LEFT  JOIN index_addresses    dst ON (dst.id=m.destination_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Governance parameter proposals. type in {status, parameter, proposal}. id-keyed.
    // Primary transport: hub JSON-RPC via HubOperationalCache; the co-located hub
    // schema read serves ONLY the no-hub deployment shape. A configured hub that is
    // unreachable past the stale ceiling fails loud; this table is the clearest
    // case for it, since governance_proposals carries no freshness column
    // at all, so a per-row freshness cap on the schema read is unbuildable.
    async getGovernanceProposals(config){
        let ops = this.explorer.hubOperational;
        if(ops && ops.enabled()){
            let rows = await ops.getGovernanceProposals({
                status:      config.data.type=='status'    ? config.data.search : undefined,
                parameter:   config.data.type=='parameter' ? config.data.search : undefined,
                proposal_id: config.data.type=='proposal'  ? config.data.search : undefined
            });
            if(rows) return this.pageHubOperationalRows(config, rows);
            this.hubOperationalOutage('governance_proposals');
        }
        let sql = config.data.sql;
        let src = this.hubSource(config, 'governance_proposals');
        let count = `SELECT count(*) as total FROM ${src.table} m WHERE ` + sql.where.data;
        let query = `SELECT
                        m.id,
                        m.proposal_id,
                        m.proposer_pubkey,
                        m.parameter,
                        m.current_value,
                        m.proposed_value,
                        m.status,
                        m.voting_end,
                        m.activation_block
                    FROM ${src.table} m
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Per-validator governance votes. type in {proposal, voter}. id-keyed.
    // Primary transport: hub JSON-RPC via HubOperationalCache; the co-located hub
    // schema read serves ONLY the no-hub deployment shape. A configured hub that is
    // unreachable past the stale ceiling fails loud.
    async getGovernanceVotes(config){
        let ops = this.explorer.hubOperational;
        if(ops && ops.enabled()){
            let rows = await ops.getGovernanceVotes({
                proposal_id:  config.data.type=='proposal' ? config.data.search : undefined,
                voter_pubkey: config.data.type=='voter'    ? config.data.search : undefined
            });
            if(rows) return this.pageHubOperationalRows(config, rows);
            this.hubOperationalOutage('governance_votes');
        }
        let sql = config.data.sql;
        let src = this.hubSource(config, 'governance_votes');
        let count = `SELECT count(*) as total FROM ${src.table} m WHERE ` + sql.where.data;
        let query = `SELECT
                        m.id,
                        m.proposal_id,
                        m.voter_pubkey,
                        m.vote,
                        m.created_at
                    FROM ${src.table} m
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Federation slash proposals (hub-owned, id-keyed). Primary transport: hub
    // JSON-RPC via HubOperationalCache over the hub's NEW unauthenticated
    // getslashproposals RPC (added for this row alongside the hub-side evidence
    // hashing). Unlike reorg_attestations there is NO chain column and none is
    // missing: the offenses are federation-wide (oracle and attestation rounds are
    // not per-chain, and a signing pubkey is one identity across every chain), so
    // this table is platform-global like validator_capabilities/governance_* and
    // binds no chain filter on either transport. Adding one later would empty this
    // page permanently, since no row can ever carry a chain value to match.
    //
    // Rows with status 'pending' are UNADJUDICATED ACCUSATIONS: SlashDetector
    // records evidence, and only a passed SLASH_PENALTY governance vote moves a row
    // off 'pending' (SlashGovernance.applyFinalized). status is therefore carried on
    // every row and rendered as its own labelled column, never as a row colour.
    //
    // The verbatim `evidence` blob is NEVER served on either leg. The RPC leg gets
    // evidence_hash from the hub (SlashDetector.hashEvidence, sha256 of the stored
    // text, the same digest SlashGovernance's voted evidence hash is built from);
    // the co-located leg computes the identical digest in SQL. Hashing hub-side is
    // the ruling's point: the hub's own POST surface serves this RPC to anyone, so
    // explorer-side redaction alone would leak.
    //
    // A configured-but-unreachable hub fails loud past the stale ceiling
    // (hubOperationalOutage); the co-located read below serves only the no-hub
    // deployment shape. type in {status, pubkey}, matching the hub RPC's two
    // server-side filters exactly, so neither transport post-filters. No 'block'
    // type: round_number is an oracle round (or an attestation pseudo-round), not a
    // block height.
    async getSlashProposals(config){
        let ops = this.explorer.hubOperational;
        if(ops && ops.enabled()){
            let rows = await ops.getSlashProposals({
                status:           config.data.type=='status' ? config.data.search : undefined,
                validator_pubkey: config.data.type=='pubkey' ? config.data.search : undefined
            });
            if(rows) return this.pageHubOperationalRows(config, rows);
            this.hubOperationalOutage('slash_proposals');
        }
        let sql = config.data.sql;
        let src = this.hubSource(config, 'slash_proposals');
        let count = `SELECT count(*) as total FROM ${src.table} m WHERE ` + sql.where.data;
        let query = `SELECT
                        m.id,
                        m.validator_pubkey,
                        m.offense_type,
                        m.round_number,
                        SHA2(COALESCE(m.evidence,''), 256) AS evidence_hash,
                        m.status,
                        m.created_at
                    FROM ${src.table} m
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }
}

module.exports = GovernanceReaders.prototype;
