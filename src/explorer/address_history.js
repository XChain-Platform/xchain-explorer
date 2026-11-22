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
 * XChain Explorer - batch address history: POST /{COIN}/api/history
 *
 * Body {"addresses":[..], "limit", "before", "since", "until"}. Answers ONE
 * merged, newest-first page of the confirmed actions that touched any of the
 * addresses, each carrying the per-address, per-token balance effect it had in
 * base units. A page is complete for every requested address over the
 * action_index span it covers, so a caller can fold pages into balance history
 * without reconciling per-address cursors.
 *
 * Unlike POST /balances this does not re-drive the per-address GET: that path
 * reads each action's handler detail one action at a time, and this route's
 * contract is a fixed statement count however many addresses and rows it serves.
 * The rows carry the history feed's own columns; per-action `details` and
 * `status` stay on GET /{COIN}/api/action/{ACTION_INDEX}.
 *
 * Installed onto XChainExplorer.prototype by explorer/install.js.
 *
 ********************************************************************/

'use strict';

const { canonicalCoinAddress } = require('./request/address_shape.js');
const { coinReadGate } = require('./coin_read_gate.js');

const HISTORY_LIMIT_DEFAULT = 50;
const HISTORY_LIMIT_MAX     = 100;

// Unit the *_base effect fields are counted in: the token's smallest unit,
// amount x 10^decimals, as a decimal string so no amount passes through a float.
const AMOUNT_UNIT = 'base';

function refusal(error, code){
    return { refusal: { error, code } };
}

// An optional non-negative integer body field; undefined and null mean absent.
function optionalInteger(util, value){
    if(value === undefined || value === null) return { value: null };
    if(!util.isSafeIntegerParam(value)) return { invalid: true };
    return { value: Number(value) };
}

/**
 * Validate the paging and window fields of a history body.
 * Returns { options } or { refusal } carrying the 400 body.
 */
function parseHistoryOptions(util, body){
    const limit  = optionalInteger(util, body.limit);
    if(limit.invalid || (limit.value !== null && (limit.value < 1 || limit.value > HISTORY_LIMIT_MAX)))
        return refusal('limit must be an integer from 1 to ' + HISTORY_LIMIT_MAX, 'INVALID_LIMIT');
    const before = optionalInteger(util, body.before);
    if(before.invalid || before.value === 0)
        return refusal('before must be a positive action_index from a previous next_cursor', 'INVALID_CURSOR');
    const since  = optionalInteger(util, body.since);
    const until  = optionalInteger(util, body.until);
    if(since.invalid || until.invalid)
        return refusal('since and until must be unix timestamps in seconds', 'INVALID_RANGE');
    if(since.value !== null && until.value !== null && since.value > until.value)
        return refusal('since must not be later than until', 'INVALID_RANGE');
    return { options: {
        limit:  (limit.value === null) ? HISTORY_LIMIT_DEFAULT : limit.value,
        before: before.value,
        since:  since.value,
        until:  until.value
    } };
}

// Canonical spelling of each address, in request order. A spelling the coin
// cannot carry is refused; an unknown coin keeps the caller's spelling.
function canonicalAddresses(config, coin, addresses){
    const out = [];
    for(const address of addresses){
        const canonical = canonicalCoinAddress(config, coin, address);
        if(canonical === false) return { invalid: address };
        const spelled = (canonical === null) ? address : canonical;
        if(!out.includes(spelled)) out.push(spelled);
    }
    return { addresses: out };
}

// Exact decimal string of a BigNumber, never exponent notation.
function plain(value){
    return value.toFixed();
}

/**
 * Fold credit and debit rows into one effect per action, address and token.
 * Sums stay exact; the conversion to base units happens once per effect, so a
 * caller summing net_base over every action gets the ledger total unrounded.
 */
function foldEffects(util, rows, addressOrder){
    const byAction = new Map();
    for(const row of rows){
        const action = Number(row.action_index);
        if(!byAction.has(action)) byAction.set(action, new Map());
        const key = row.address + '\u0000' + row.tick;
        const effects = byAction.get(action);
        if(!effects.has(key))
            effects.set(key, { address: row.address, tick: row.tick, decimals: row.decimals, credit: util.bcnum(0), debit: util.bcnum(0) });
        const effect = effects.get(key);
        const amount = util.bcnum(String(util.plainDecimal(row.amount) || 0));
        if(Number(row.direction) > 0) effect.credit = effect.credit.plus(amount);
        else effect.debit = effect.debit.plus(amount);
    }
    const shaped = new Map();
    for(const [action, effects] of byAction){
        const list = [...effects.values()].map((effect) => shapeEffect(util, effect));
        list.sort((a, b) => (addressOrder.indexOf(a.address) - addressOrder.indexOf(b.address)) || String(a.tick).localeCompare(String(b.tick)));
        shaped.set(action, list);
    }
    return shaped;
}

function shapeEffect(util, effect){
    const net      = effect.credit.minus(effect.debit);
    const decimals = util.isNull(effect.decimals) ? null : Number(effect.decimals);
    const scale    = (decimals === null) ? null : util.bcnum(10).pow(decimals);
    return {
        address:     effect.address,
        tick:        effect.tick,
        decimals,
        credit_base: (scale === null) ? null : plain(effect.credit.times(scale)),
        debit_base:  (scale === null) ? null : plain(effect.debit.times(scale)),
        net_base:    (scale === null) ? null : plain(net.times(scale)),
        net_whole:   plain(net)
    };
}

// Chain indices as decimal strings, the per-address history feed's own wire
// shape (BIGINT columns), so they stay exact above 2^53.
function chainIndex(value){
    return (value === undefined || value === null) ? null : String(value);
}

function shapeAction(page, row, effects){
    const base = row || {};
    return {
        action_index:  String(page.action_index),
        action:        (base.action === undefined) ? null : base.action,
        block_index:   chainIndex(base.block_index),
        timestamp:     chainIndex(base.timestamp),
        tx_hash:       (base.tx_hash === undefined) ? null : base.tx_hash,
        tx_index:      chainIndex(base.tx_index),
        parent_batch_action_index: chainIndex(base.parent_batch_action_index),
        addresses:     page.addresses,
        effects:       effects || []
    };
}

class AddressHistoryBatch {

    async processAddressHistoryBatchRequest(req, res){
        const body   = (req.body && typeof req.body === 'object') ? req.body : {};
        const parsed = this.parseBatchAddresses(body);
        if(parsed.refusal)
            return this.sendBatchJson(res, 400, parsed.refusal);
        const opts = parseHistoryOptions(this.util, body);
        if(opts.refusal)
            return this.sendBatchJson(res, 400, opts.refusal);
        const coin = String((req.params && req.params.coin) || '').toUpperCase();
        const gate = await coinReadGate(this, coin, res);
        if(gate.refusal)
            return this.sendBatchJson(res, 503, gate.refusal);
        const canonical = canonicalAddresses(gate.config, coin, parsed.addresses);
        if(canonical.invalid !== undefined)
            return this.sendBatchJson(res, 400, { error: 'Invalid address: ' + canonical.invalid.slice(0, 128), code: 'INVALID_ADDRESS' });
        const out = await this.readAddressHistory({ coin, data: {} }, canonical.addresses, opts.options);
        return this.sendBatchJson(res, 200, out);
    }

    // The three statements, then the response body. No statement runs per
    // address or per row: page, rows and effects each cover the whole request.
    async readAddressHistory(dbConfig, addresses, options){
        const page    = await this.db.getAddressHistoryPage(dbConfig, addresses, options);
        const indexes = page.map((entry) => entry.action_index);
        const rows    = await this.db.getAddressHistoryRows(dbConfig, indexes);
        const effects = await this.db.getAddressHistoryEffects(dbConfig, indexes, addresses);
        const rowByIndex = new Map(rows.map((row) => [Number(row.action_index), row]));
        const folded  = foldEffects(this.util, effects, addresses);
        return {
            amount_unit: AMOUNT_UNIT,
            addresses,
            limit:       options.limit,
            before:      options.before,
            since:       options.since,
            until:       options.until,
            next_cursor: (page.length === options.limit) ? String(page[page.length - 1].action_index) : null,
            actions:     page.map((entry) => shapeAction(entry, rowByIndex.get(entry.action_index), folded.get(entry.action_index)))
        };
    }
}

module.exports = { methods: AddressHistoryBatch.prototype, parseHistoryOptions, HISTORY_LIMIT_MAX };
