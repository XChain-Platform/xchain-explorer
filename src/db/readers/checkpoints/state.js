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
 * XChain Explorer - state-tree, balance and block-leaf reads for SPV proofs
 *
 * One part of src/db/readers/checkpoints.js (the entry composes it through
 * composeReaderParts). The indexer-DB half of SPV proof serving (the signed
 * checkpoint half sits in checkpoints/checkpoints.js): per-block sub-roots, the
 * SMT node store, the as-of-height leaf preimages, and the canonical per-block
 * leaf rows an action proof is built from.
 *
 * Authored as a class body whose prototype is exported, like every other
 * family under src/db/: `this` is the Database instance at call time, and the
 * methods reach Database.prototype non-enumerable, by descriptor.
 *
 ********************************************************************/

'use strict';

// The ledger half of one block's canonical leaf rows. `db` is the Database instance
// getBlockLeafRows runs on: the two halves are plain functions, not methods, so cutting
// the gather up adds no name to Database.prototype.
async function readLedgerLeafRows(db, config, bi){
    const ledger = { credits: [], debits: [], escrows: [] };
    ledger.credits = await db.doQuery(config,
        `SELECT c.action_index, a1.address AS address, t1.tick AS tick, c.amount
             FROM credits c
                INNER JOIN actions a ON (a.action_index=c.action_index)
                LEFT  JOIN index_addresses a1 ON (a1.id=c.address_id)
                LEFT  JOIN index_tickers   t1 ON (t1.id=c.tick_id)
             WHERE a.block_index=?
             ORDER BY c.action_index ASC, a1.address COLLATE utf8_bin ASC, t1.tick COLLATE utf8mb4_bin ASC, c.amount ASC`, [bi]);
    ledger.debits = await db.doQuery(config,
        `SELECT d.action_index, a1.address AS address, t1.tick AS tick, d.amount
             FROM debits d
                INNER JOIN actions a ON (a.action_index=d.action_index)
                LEFT  JOIN index_addresses a1 ON (a1.id=d.address_id)
                LEFT  JOIN index_tickers   t1 ON (t1.id=d.tick_id)
             WHERE a.block_index=?
             ORDER BY d.action_index ASC, a1.address COLLATE utf8_bin ASC, t1.tick COLLATE utf8mb4_bin ASC, d.amount ASC`, [bi]);
    ledger.escrows = await db.doQuery(config,
        `SELECT e.action_index, a1.address AS address, t1.tick AS tick, e.amount
             FROM escrows e
                INNER JOIN actions a ON (a.action_index=e.action_index)
                LEFT  JOIN index_addresses a1 ON (a1.id=e.address_id)
                LEFT  JOIN index_tickers   t1 ON (t1.id=e.tick_id)
             WHERE a.block_index=?
             ORDER BY e.action_index ASC, a1.address COLLATE utf8_bin ASC, t1.tick COLLATE utf8mb4_bin ASC, e.amount ASC`, [bi]);
    return ledger;
}

// The contract half of the same gather, in the same order the indexer hashes it.
async function readContractLeafRows(db, config, bi){
    const contracts = { contracts: [], state: [], executions: [], emissions: [], deposits: [], withdrawals: [] };
    contracts.contracts = await db.doQuery(config,
        `SELECT c.action_index, a1.address AS source_address, c.code_hash, s1.status AS status
             FROM contracts c
                INNER JOIN actions a ON (a.action_index=c.action_index)
                LEFT  JOIN index_addresses a1 ON (a1.id=c.source_id)
                LEFT  JOIN index_statuses  s1 ON (s1.id=c.status_id)
             WHERE a.block_index=?
             ORDER BY c.action_index ASC`, [bi]);
    contracts.state = await db.doQuery(config,
        `SELECT cs.contract_index, cs.state_key, cs.state_value
             FROM contract_state cs
                INNER JOIN (SELECT MAX(id) as max_id FROM contract_state
                            WHERE block_index=? GROUP BY contract_index, state_key) latest
                   ON cs.id = latest.max_id
             ORDER BY cs.contract_index ASC, cs.state_key ASC`, [bi]);
    contracts.executions = await db.doQuery(config,
        `SELECT ce.action_index, ce.contract_index, a1.address AS caller_address, ce.gas_used, s1.status AS status, ce.emitted_count
             FROM contract_executions ce
                INNER JOIN actions a ON (a.action_index=ce.action_index)
                LEFT  JOIN index_addresses a1 ON (a1.id=ce.caller_id)
                LEFT  JOIN index_statuses  s1 ON (s1.id=ce.status_id)
             WHERE a.block_index=?
             ORDER BY ce.action_index ASC`, [bi]);
    contracts.emissions = await db.doQuery(config,
        `SELECT em.execution_index, em.emitted_action, em.action_index, em.position
             FROM contract_emissions em
                INNER JOIN contract_executions ce ON (ce.action_index=em.execution_index)
                INNER JOIN actions a ON (a.action_index=ce.action_index)
             WHERE a.block_index=?
             ORDER BY em.execution_index ASC, em.position ASC`, [bi]);
    contracts.deposits = await db.doQuery(config,
        `SELECT d.action_index, d.contract_index, a1.address AS source_address, t1.tick AS tick, d.amount, s1.status AS status
             FROM deposits d
                INNER JOIN actions a ON (a.action_index=d.action_index)
                LEFT  JOIN index_addresses a1 ON (a1.id=d.source_id)
                LEFT  JOIN index_tickers   t1 ON (t1.id=d.tick_id)
                LEFT  JOIN index_statuses  s1 ON (s1.id=d.status_id)
             WHERE a.block_index=?
             ORDER BY d.action_index ASC, d.contract_index ASC, a1.address COLLATE utf8_bin ASC, t1.tick COLLATE utf8mb4_bin ASC, d.amount ASC, s1.status COLLATE utf8_bin ASC`, [bi]);
    contracts.withdrawals = await db.doQuery(config,
        `SELECT w.action_index, w.contract_index, a1.address AS source_address, t1.tick AS tick, w.amount, s1.status AS status
             FROM withdrawals w
                INNER JOIN actions a ON (a.action_index=w.action_index)
                LEFT  JOIN index_addresses a1 ON (a1.id=w.source_id)
                LEFT  JOIN index_tickers   t1 ON (t1.id=w.tick_id)
                LEFT  JOIN index_statuses  s1 ON (s1.id=w.status_id)
             WHERE a.block_index=?
             ORDER BY w.action_index ASC, w.contract_index ASC, a1.address COLLATE utf8_bin ASC, t1.tick COLLATE utf8mb4_bin ASC, w.amount ASC, s1.status COLLATE utf8_bin ASC`, [bi]);
    return contracts;
}

class StateTreeReaders {
    // Per-block sub-roots from the indexer DB (state_tree_nodes' companion roots).
    async getStateTreeRow(config, blockIndex) {
        // contract_state_root is the reserved-slot extension column (SPV sub-tree
        // spec Stage A). NULL means the slot committed EMPTY at this height, which
        // is every historical row and every row on a chain that has not armed it.
        // It MUST be selected here: the sub-root set this row reassembles to is
        // what binds a served proof to the signed checkpoint, and omitting a
        // populated column reassembles to the wrong state_root and refuses to
        // serve every proof at that height.
        let rows = await this.doQuery(config,
            `SELECT balances_root, stakes_root, state_root, block_merkle_root, contract_state_root
             FROM state_tree_roots WHERE block_index = ? LIMIT 1`, [Number(blockIndex)]);
        return (rows && rows.length) ? rows[0] : null;
    }

    // Raw stored state_value for one contract state key AS-OF a height, or null
    // when the key has no row at or below it OR its winning row is a deletion
    // tombstone. This is the leaf preimage for a contract-state proof, so it must
    // mirror the commitment's mapping exactly (contractStateSubtree.js):
    //
    //   - state_key_bin, the utf8_bin shadow, NEVER state_key. contract_state is
    //     utf8_general_ci, so matching on state_key can return a row for a
    //     DIFFERENT key that merely case-folds to the requested one, and the proof
    //     would be cryptographically valid while binding the wrong key.
    //   - highest id at or below the height, tombstones INCLUDED in the ordering
    //     and tested afterwards. Filtering NULLs first would return the last
    //     surviving write of a deleted key, contradicting the commitment, which
    //     has no leaf for it.
    //   - the RAW stored string, never JSON.parse'd: the client hashes these bytes.
    async getContractStateValueAtHeight(config, contractIndex, stateKey, blockIndex) {
        let rows = await this.doQuery(config,
            `SELECT state_value FROM contract_state
             WHERE contract_index = ? AND state_key_bin = ? AND block_index <= ?
             ORDER BY id DESC LIMIT 1`,
            [Number(contractIndex), String(stateKey), Number(blockIndex)]);
        if (!rows || !rows.length) return null;
        return (rows[0].state_value == null) ? null : String(rows[0].state_value);
    }

    // Locked-balance (XCHAIN_ESC) leaf preimage as-of a height: the latest
    // escrow_leaf_journal row at or below it. The journal is append-only with a
    // block_index (the indexer's writer appends one row per key per block whose
    // total changed), so this read is exact, exactly like contract_state above.
    // MAX(id) runs over ALL rows including NULL tombstones: filtering them
    // before the max would resurrect a released lock at its last positive value.
    // NULL (tombstone) and no-row both return null, which the proof layer maps
    // to "zero locked", matching the reader's delete-on-zero rule.
    async getLockedAmountAtHeight(config, address, tick, blockIndex) {
        tick = await this.getCanonicalTick(config, tick) || tick;
        let rows = await this.doQuery(config,
            `SELECT j.locked_amount FROM escrow_leaf_journal j
             INNER JOIN index_addresses a ON a.id = j.address_id
             INNER JOIN index_tickers   t ON t.id = j.tick_id
             WHERE a.address = ? AND t.tick = ? AND j.block_index <= ?
             ORDER BY j.id DESC LIMIT 1`,
            [String(address), String(tick), Number(blockIndex)]);
        if (!rows || !rows.length) return null;
        return (rows[0].locked_amount == null) ? null : String(rows[0].locked_amount);
    }

    // One internal SMT node (content-addressed) from the indexer node store.
    async getStateNode(config, nodeHashHex) {
        let rows = await this.doQuery(config,
            'SELECT left_hash, right_hash FROM state_tree_nodes WHERE node_hash = ? LIMIT 1',
            [String(nodeHashHex)]);
        return (rows && rows.length) ? rows[0] : null;
    }

    // Authoritative net-spendable balance (SUM credits - SUM debits) at 18 dp,
    // resolved by canonical strings (never the mutable balances cache), matching
    // the indexer's stateCommitment.getNetBalance leaf source.
    async getNetBalance18(config, address, tick) {
        tick = await this.getCanonicalTick(config, tick) || tick;
        let rows = await this.doQuery(config,
            `SELECT CAST(
                (SELECT COALESCE(SUM(CAST(c.amount AS DECIMAL(60,18))),0) FROM credits c
                    INNER JOIN index_addresses a ON a.id=c.address_id
                    INNER JOIN index_tickers   t ON t.id=c.tick_id
                    WHERE a.address=? AND t.tick=?)
              - (SELECT COALESCE(SUM(CAST(d.amount AS DECIMAL(60,18))),0) FROM debits d
                    INNER JOIN index_addresses a ON a.id=d.address_id
                    INNER JOIN index_tickers   t ON t.id=d.tick_id
                    WHERE a.address=? AND t.tick=?)
             AS DECIMAL(60,18)) AS net`,
            [address, tick, address, tick]);
        return (rows && rows.length) ? String(rows[0].net) : '0';
    }

    // Height-bounded net-spendable balance: the SAME query shape/arithmetic as
    // getNetBalance18 (DECIMAL(60,18) SUM(credits)-SUM(debits), returned as a
    // canonical string), but each side is bounded to actions committed at or
    // before blockIndex. credits/debits carry no block_index of their own, so we
    // bind height through actions.action_index (the canonical "at height" join,
    // same as stateHash.js's tick-touch query), matching the state at the moment
    // the indexer computed the checkpoint-height balances leaf. A balance proof
    // must serve the amount committed at cp.block_index, NOT the current tip, or
    // the SDK's amountLeaf(amount) check false-rejects with LEAF_AMOUNT_MISMATCH.
    async getNetBalance18AtHeight(config, address, tick, blockIndex) {
        tick = await this.getCanonicalTick(config, tick) || tick;
        let rows = await this.doQuery(config,
            `SELECT CAST(
                (SELECT COALESCE(SUM(CAST(c.amount AS DECIMAL(60,18))),0) FROM credits c
                    INNER JOIN index_addresses a  ON a.id=c.address_id
                    INNER JOIN index_tickers   t  ON t.id=c.tick_id
                    INNER JOIN actions         ac ON ac.action_index=c.action_index
                    WHERE a.address=? AND t.tick=? AND ac.block_index<=?)
              - (SELECT COALESCE(SUM(CAST(d.amount AS DECIMAL(60,18))),0) FROM debits d
                    INNER JOIN index_addresses a  ON a.id=d.address_id
                    INNER JOIN index_tickers   t  ON t.id=d.tick_id
                    INNER JOIN actions         ac ON ac.action_index=d.action_index
                    WHERE a.address=? AND t.tick=? AND ac.block_index<=?)
             AS DECIMAL(60,18)) AS net`,
            [address, tick, Number(blockIndex), address, tick, Number(blockIndex)]);
        return (rows && rows.length) ? String(rows[0].net) : '0';
    }

    // The action's own block_index (its consensus block, a.block_index), which
    // resolves the block whose block_merkle_root an action proof binds to. Null if the
    // action does not exist on this server.
    async getActionBlockIndex(config, actionIndex) {
        let rows = await this.doQuery(config,
            'SELECT block_index FROM actions WHERE action_index=? LIMIT 1', [Number(actionIndex)]);
        return (rows && rows.length && rows[0].block_index != null) ? Number(rows[0].block_index) : null;
    }

    // The canonical per-block leaf rows (ledger/actions/contracts) in the EXACT order
    // + binary collations the indexer's getBlockHashes hashes them (SPV spec §5.1).
    // A verbatim port of the indexer gather (db.js getBlockHashes): every query scopes
    // by the ACTION's own block_index (a.block_index, covering tx_index-NULL synthetic
    // actions), resolves canonical strings (never local AUTO_INCREMENT ids), and pins
    // BINARY collations on the tie-order keys so the order is collation-independent.
    // Returns the shape merkle.blockMerkleLeaves consumes; a single byte of drift from
    // the indexer gather silently invalidates every produced action proof.
    async getBlockLeafRows(config, block_index) {
        const bi = Number(block_index);
        const ledger = await readLedgerLeafRows(this, config, bi);
        const actions = await this.doQuery(config,
            `SELECT a.action_index, a.tx_index, ia.action AS action
             FROM actions a
                LEFT JOIN index_actions ia ON (ia.id=a.action_id)
             WHERE a.block_index=?
             ORDER BY a.action_index ASC`, [bi]);
        const contracts = await readContractLeafRows(this, config, bi);
        return { block_index: bi, ledger, actions, contracts };
    }
}

module.exports = StateTreeReaders.prototype;
