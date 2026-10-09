/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 *********************************************************************/

'use strict';

// Keys far above anything the earlier conformance tests write, so no seed collides.
const BASE = 900000;
const BLOCK_INDEX = BASE + 1;
const TX_INDEX = BASE + 1;
const PUBKEY = 'ab'.repeat(32);

// Intern one index value, reusing a row an earlier test made and recording only new ones.
async function intern(conn, made, table, column, value) {
    const found = await conn.query('SELECT id FROM ' + table + ' WHERE ' + column + '=? LIMIT 1', [value]);
    if (found.length) return Number(found[0].id);
    const res = await conn.query('INSERT INTO ' + table + ' (' + column + ') VALUES (?)', [value]);
    made.push([table, 'id', Number(res.insertId)]);
    return Number(res.insertId);
}

// Insert one row and record the key that deletes it again.
async function insertRow(conn, made, table, row, key) {
    const columns = Object.keys(row);
    const res = await conn.query('INSERT INTO ' + table + ' (' + columns.join(', ') + ') VALUES ('
        + columns.map(() => '?').join(', ') + ')', columns.map((column) => row[column]));
    made.push([table, key, key === 'id' ? Number(res.insertId) : row[key]]);
}

async function seedIndexes(conn, made, balanceAddress) {
    const ids = {};
    ids.source = await intern(conn, made, 'index_addresses', 'address', 'bcrt1qmanifestsource');
    ids.custody = await intern(conn, made, 'index_addresses', 'address', balanceAddress);
    ids.tick = await intern(conn, made, 'index_tickers', 'tick', 'MANIFESTA');
    ids.tick2 = await intern(conn, made, 'index_tickers', 'tick', 'MANIFESTB');
    ids.valid = await intern(conn, made, 'index_statuses', 'status', 'valid');
    ids.pubkey = await intern(conn, made, 'index_pubkeys', 'pubkey', PUBKEY);
    ids.txHash = await intern(conn, made, 'index_transactions', 'hash', 'manifest-tx-' + TX_INDEX);
    return ids;
}

// One block and one transaction carry an action per reader, each with its own action_index.
async function seedSpine(conn, made, ids, actions) {
    await insertRow(conn, made, 'blocks', { block_index: BLOCK_INDEX, block_time: 1700000600 }, 'block_index');
    await insertRow(conn, made, 'transactions', {
        tx_index: TX_INDEX, block_index: BLOCK_INDEX, tx_hash_id: ids.txHash, source_id: ids.source, fee: 1000, data: '',
    }, 'tx_index');
    const index = {};
    let vout = 0;
    for (const [reader, action] of Object.entries(actions)) {
        const actionId = await intern(conn, made, 'index_actions', 'action', action);
        index[reader] = BASE + 1 + vout;
        await insertRow(conn, made, 'actions', {
            action_index: index[reader], block_index: BLOCK_INDEX, tx_index: TX_INDEX, tx_vout: vout,
            action_id: actionId, action_format: 0, source_id: ids.source,
        }, 'action_index');
        vout++;
    }
    return index;
}

// Seed one served row for every dashboard-mapped reader; returns the rows to delete.
async function seedManifestReaders(pool, database, probe) {
    const made = [];
    const conn = await pool.getConnection();
    try {
        await conn.query('USE `' + database + '`');
        const ids = await seedIndexes(conn, made, probe.balanceAddress);
        const a = await seedSpine(conn, made, ids, {
            token: 'ISSUE', order: 'ORDER', contract: 'DEPLOY', execution: 'EXECUTE', stake: 'STAKE',
            unstake: 'UNSTAKE', validator: 'STAKE', price: 'PRICE', attest: 'ATTEST',
        });
        const at = { block_index: BLOCK_INDEX, status_id: ids.valid };
        await insertRow(conn, made, 'tokens', {
            tick_id: ids.tick, action_index: a.token, supply: '10', max_supply: '10', max_mint: '0',
            decimals: 0, lock_max_supply: 1, owner_id: ids.source,
        }, 'id');
        await insertRow(conn, made, 'markets', { tick1_id: ids.tick, tick2_id: ids.tick2, tick1_24hr_change: '0' }, 'id');
        await insertRow(conn, made, 'orders', {
            action_index: a.order, give_tick_id: ids.tick, give_amount: '1', get_tick_id: ids.tick2, get_amount: '1',
            status_id: ids.valid,
        }, 'action_index');
        await insertRow(conn, made, 'contracts', Object.assign({
            action_index: a.contract, source_id: ids.source, code: 'export {}', code_hash: '0'.repeat(64),
            api_version: 1, cooldown_blocks: 10, slash_destination_id: ids.source,
        }, at), 'action_index');
        await insertRow(conn, made, 'contract_state', {
            contract_index: probe.stateContract, state_key: 'manifest', state_value: '1',
            block_index: BLOCK_INDEX, action_index: a.execution,
        }, 'id');
        await insertRow(conn, made, 'balances', { address_id: ids.custody, tick_id: ids.tick, amount: '1' }, 'id');
        await insertRow(conn, made, 'contract_executions', Object.assign({
            action_index: a.execution, contract_index: a.contract, caller_id: ids.source, method_name: 'run',
            gas_used: 1, gas_limit: 10,
        }, at), 'action_index');
        const staker = { source_id: ids.source, signing_pubkey_id: ids.pubkey, amount: '1' };
        await insertRow(conn, made, 'contract_stakes', Object.assign({
            action_index: a.stake, target_contract_index: a.contract, tick_id: ids.tick, version: 3,
            activation_block: BLOCK_INDEX, deactivation_block: null,
        }, staker, at), 'action_index');
        await insertRow(conn, made, 'contract_unstakes', Object.assign({
            action_index: a.unstake, target_contract_index: a.contract, tick_id: ids.tick,
            cooldown_end_block: BLOCK_INDEX + 10,
        }, staker, at), 'action_index');
        await insertRow(conn, made, 'slash_events', {
            execution_index: a.execution, target_contract_index: a.contract, signing_pubkey_id: ids.pubkey,
            tick_id: ids.tick, amount: '1', destination_id: ids.source, block_index: BLOCK_INDEX,
        }, 'id');
        await insertRow(conn, made, 'stakes', Object.assign({
            action_index: a.validator, version: 0, activation_block: BLOCK_INDEX, deactivation_block: null,
        }, staker, at), 'action_index');
        await insertRow(conn, made, 'prices', Object.assign({
            action_index: a.price, version: 0, source_id: ids.source, round_number: 1,
            batch_first_round: 1, batch_last_round: 1, round_count: 1,
        }, { status_id: ids.valid }), 'action_index');
        await insertRow(conn, made, 'attests', Object.assign({
            action_index: a.attest, version: 1, request_id: 'cd'.repeat(32), provider_id: 'http_get',
            response_status: 'ok',
        }, at), 'action_index');
        return made;
    } catch (e) {
        await deleteSeeded(pool, database, made);
        throw e;
    } finally {
        conn.release();
    }
}

// Delete every seeded row, newest first, so later tests see the schema as it was.
async function deleteSeeded(pool, database, made) {
    const conn = await pool.getConnection();
    try {
        await conn.query('USE `' + database + '`');
        for (const [table, key, value] of made.slice().reverse()) {
            await conn.query('DELETE FROM ' + table + ' WHERE ' + key + '=?', [value]);
        }
    } finally {
        conn.release();
    }
}

module.exports = { BASE, seedManifestReaders, deleteSeeded };
