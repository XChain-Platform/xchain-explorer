/*
 * Copyright © 2025–2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Licensed under the GNU Affero GPL v3.0 or later; see LICENSE.md.
 * A commercial license is available - contact legal@dankest.llc.
 *
 * Typed 200 bodies for docs/openapi.build.js, keyed by the db method a route calls.
 *
 * Every row schema below lists exactly the columns its reader's query selects,
 * typed as the response sink writes them: a BIGINT column (action and block
 * indexes, block times, list references) leaves utility.jsonStringify as a
 * decimal string, a TINYINT/INT column stays a JSON number, and text is a
 * string. test/unit/http/openapi_response_schemas.test.js runs each reader and
 * fails when a selected column and its row schema disagree, so a column added
 * to a query lands here in the same change.
 *
 * Pure data plus two builders: no I/O, no requires, safe to load from a test.
 */
'use strict';

// Column type codes. Upper case never leaves the sink as null; lower case can.
const COLUMN_TYPES = {
    S: { type: 'string' },
    s: { type: ['string', 'null'] },
    D: { type: 'string', pattern: '^[0-9]+$' },
    d: { type: ['string', 'null'], pattern: '^[0-9]+$' },
    i: { type: ['integer', 'null'] },
};

// Build a row object from 'name:code' pairs, sorted the way the API ksorts rows.
function rowSchema(description, spec, notes, extra) {
    const properties = {};
    for (const field of spec.trim().split(/\s+/)) {
        const [name, code] = field.split(':');
        if (!COLUMN_TYPES[code]) throw new Error(`openapi.schemas: unknown column code ${code} on ${name}`);
        properties[name] = Object.assign({}, COLUMN_TYPES[code],
            notes && notes[name] ? { description: notes[name] } : {});
    }
    Object.assign(properties, extra || {});
    const sorted = {};
    for (const name of Object.keys(properties).sort()) sorted[name] = properties[name];
    return { type: 'object', description, properties: sorted };
}

const TX_TAIL = 'block_index:D timestamp:D tx_hash:s tx_index:d';
const ACTION_HEAD = 'action:S action_index:D action_format:i source:s';

// [schema, db method, description, columns, per-column notes]
const ROWS = [
    ['Action', 'getActions', 'One row of the raw action feed',
        'action:S action_index:D action_format:i source:s ' + TX_TAIL],
    ['Address', 'getAddresses', 'ADDRESS action data',
        ACTION_HEAD + ' fee_preference:d require_memo:d dispenser_preference:d memo:s status:s ' + TX_TAIL,
        { dispenser_preference: 'Who may open a dispenser for this address (1=owner only, 2=anyone)' }],
    ['Airdrop', 'getAirdrops', 'AIRDROP action data',
        ACTION_HEAD + ' tick:s list_action_index:d amount:s memo:s status:s ' + TX_TAIL],
    ['Batch', 'getBatches', 'BATCH action data',
        ACTION_HEAD + ' status:s ' + TX_TAIL],
    ['Broadcast', 'getBroadcasts', 'BROADCAST action data',
        ACTION_HEAD + ' message:s value:s fee:s broadcast_action_index:d memo:s status:s ' + TX_TAIL],
    ['Callback', 'getCallbacks', 'CALLBACK action data',
        ACTION_HEAD + ' tick:s callback_tick:s callback_amount:s memo:s status:s ' + TX_TAIL],
    ['Destroy', 'getDestroys', 'DESTROY action data',
        ACTION_HEAD + ' tick:s amount:s memo:s status:s ' + TX_TAIL],
    ['Dividend', 'getDividends', 'DIVIDEND action data',
        ACTION_HEAD + ' tick:s dividend_tick:s amount:s memo:s status:s ' + TX_TAIL],
    ['Dispenser', 'getDispensers', 'DISPENSER action data',
        ACTION_HEAD + ' address:s give_coin:s give_tick:s give_amount:s give_escrow:s give_ownership:i'
            + ' get_coin:s get_tick:s get_amount:s oracle_address:s memo:s status:s ' + TX_TAIL
            + ' escrow_remaining:s current_status:s',
        { give_escrow: 'Amount of GIVE_TICK escrowed when the dispenser was created',
          escrow_remaining: 'Amount of GIVE_TICK left in escrow now (create escrow + refills - payouts); '
            + '"0" once the dispenser is closed, cancelled or expired; null when it cannot be derived',
          current_status: 'The dispenser\'s lifecycle status from its latest status row; `status` is the validity of the creating action only',
          oracle_address: 'The ORACLE_ADDRESS a Mode B dispenser prices against; null otherwise' }],
    ['DispenserCancel', 'getDispenserCancels', 'DISPENSER_CANCEL action data',
        ACTION_HEAD + ' dispenser_action_index:d memo:s status:s ' + TX_TAIL],
    ['DispenserClose', 'getDispenserCloses', 'DISPENSER_CLOSE action data (system-injected, so no transaction fields)',
        'action:S action_index:D action_format:i dispenser_action_index:d dispenser_address:s give_coin:s give_tick:s'
            + ' give_amount:s get_coin:s get_tick:s get_amount:s fiat:s fiat_amount:s oracle_address:s'
            + ' block_index:D timestamp:D status:s close_reason:s',
        { close_reason: 'Why the dispenser closed: empty after an auto-drain, cancelled once the close delay elapses on a cancel' }],
    ['DispenserEdit', 'getDispenserEdits', 'DISPENSER_EDIT action data',
        ACTION_HEAD + ' dispenser_action_index:d give_escrow:s expiration:d allow_list:d block_list:d memo:s status:s ' + TX_TAIL],
    ['DispenserExpire', 'getDispenserExpires', 'DISPENSER_EXPIRE action data (system-injected, so no transaction fields)',
        ACTION_HEAD + ' dispenser_action_index:d block_index:D timestamp:D status:s'],
    ['Dispense', 'getDispenses', 'DISPENSE action data',
        ACTION_HEAD + ' dispenser_action_index:d destination:s give_coin:s give_tick:s give_amount:s get_coin:s'
            + ' get_tick:s get_amount:s status:s ' + TX_TAIL,
        { get_amount: 'Coin attributed to this dispense. When one payment fills several dispenses in the same transaction, this is that dispense\'s share, not the payment\'s full amount' }],
    ['Fee', 'getFees', 'Protocol fee payment data',
        ACTION_HEAD + ' destination:s tick:s method:d amount:s gas_cost:d gas_price:s xchain_amount:s payment_mode:i'
            + ' native_coin_amount:s native_coin:s oracle_round:d fee_preference:i fee_version:i ' + TX_TAIL,
        { method: 'Legacy fee payment method (1=destroy, 2=donate)',
          payment_mode: '1=native coin, 2=XCHAIN balance',
          fee_version: '1=legacy, 2=unified gas' }],
    ['File', 'getFiles', 'FILE action data',
        ACTION_HEAD + ' name:s title:s type:s memo:s status:s gate_ticker:s gate_min_amount:s encryption_method:i key_hash:s ' + TX_TAIL],
    ['Issue', 'getIssues', 'ISSUE action data (the fields as the action declared them)',
        ACTION_HEAD + ' tick:s max_supply:s max_mint:s decimals:s description:s mint_supply:s transfer:s transfer_supply:s'
            + ' lock_max_supply:s lock_mint:s lock_mint_supply:s lock_max_mint:s lock_description:s lock_sleep:s'
            + ' lock_callback:s callback_block:s callback_tick:s callback_amount:s allow_list:d block_list:d'
            + ' mint_address_max:s mint_start_block:s mint_stop_block:s memo:s status:s ' + TX_TAIL],
    ['Link', 'getLinks', 'LINK action data',
        ACTION_HEAD + ' coin1:s coin1_action_index:d coin2:s coin2_action_index:d memo:s status:s ' + TX_TAIL],
    ['List', 'getLists', 'LIST action data',
        ACTION_HEAD + ' type:s edit:s list_action_index:d memo:s status:s ' + TX_TAIL],
    ['Message', 'getMessages', 'MESSAGE action data',
        ACTION_HEAD + ' destination:s encryption_method:s encryption_key:s encrypted_message:s plaintext_message:s'
            + ' status:s coin:s ' + TX_TAIL,
        { coin: 'Destination coin network for cross-chain messages' }],
    ['Mint', 'getMints', 'MINT action data',
        ACTION_HEAD + ' destination:s tick:s amount:s memo:s status:s ' + TX_TAIL],
    ['Order', 'getOrders', 'ORDER action data',
        ACTION_HEAD + ' give_coin:s give_tick:s give_amount:s give_ownership:i get_coin:s get_tick:s get_amount:s'
            + ' get_ownership:i get_address:s expiration:d allow_list:d block_list:d payout_legs:s memo:s status:s ' + TX_TAIL,
        { payout_legs: 'JSON [{to,bps}] split of seller proceeds applied at match; null when none' }],
    ['OrderCancel', 'getOrderCancels', 'ORDER_CANCEL action data',
        ACTION_HEAD + ' order_action_index:d memo:s status:s ' + TX_TAIL],
    ['OrderEdit', 'getOrderEdits', 'ORDER_EDIT action data',
        ACTION_HEAD + ' order_action_index:d expiration:d allow_list:d block_list:d memo:s status:s ' + TX_TAIL],
    ['OrderExpire', 'getOrderExpires', 'ORDER_EXPIRE action data (system-injected, so no transaction fields)',
        ACTION_HEAD + ' order_action_index:d block_index:D timestamp:D status:s'],
    ['OrderMatch', 'getOrderMatches', 'ORDER_MATCH action data (system-injected, so no transaction fields)',
        'action:S action_index:D action_format:i give_coin:s give_action_index:d give_amount:s get_coin:s'
            + ' get_action_index:d get_amount:s settlement_type:s block_index:D timestamp:D status:s'],
    ['Send', 'getSends', 'SEND action data',
        ACTION_HEAD + ' destination:s tick:s amount:s memo:s status:s ' + TX_TAIL],
    ['Sleep', 'getSleeps', 'SLEEP action data',
        ACTION_HEAD + ' type:d tick:s resume_block:s memo:s status:s ' + TX_TAIL],
    ['Swap', 'getSwaps', 'SWAP action data',
        ACTION_HEAD + ' give_coin:s give_tick:s give_amount:s give_ownership:i get_coin:s get_tick:s get_amount:s'
            + ' get_ownership:i get_address:s expiration:d allow_list:d block_list:d payout_legs:s memo:s status:s'
            + ' swap_status:s ' + TX_TAIL,
        { swap_status: 'The swap\'s lifecycle status from its latest status row; `status` is the validity of the creating action only' }],
    ['SwapCancel', 'getSwapCancels', 'SWAP_CANCEL action data',
        ACTION_HEAD + ' swap_action_index:d memo:s status:s ' + TX_TAIL],
    ['SwapEdit', 'getSwapEdits', 'SWAP_EDIT action data',
        ACTION_HEAD + ' swap_action_index:d expiration:d allow_list:d block_list:d memo:s status:s ' + TX_TAIL],
    ['SwapExpire', 'getSwapExpires', 'SWAP_EXPIRE action data (system-injected, so no transaction fields)',
        ACTION_HEAD + ' swap_action_index:d block_index:D timestamp:D status:s'],
    ['SwapMatch', 'getSwapMatches', 'SWAP_MATCH action data (system-injected, so no transaction fields)',
        'action:S action_index:D action_format:i give_coin:s give_action_index:d get_coin:s get_action_index:d'
            + ' block_index:D timestamp:D status:s'],
    ['Sweep', 'getSweeps', 'SWEEP action data',
        ACTION_HEAD + ' destination:s balances:d ownerships:d orders:d swaps:d dispensers:d memo:s status:s ' + TX_TAIL,
        { balances: 'Nonzero when token balances are swept',
          ownerships: 'Nonzero when token ownerships are swept',
          orders: 'Nonzero when open ORDERs are cancelled and their escrow credited to the destination',
          swaps: 'Nonzero when open SWAPs are cancelled and their escrow credited to the destination',
          dispensers: 'Nonzero when open DISPENSERs are closed and their escrow credited to the destination' }],
    ['Credit', 'getCredits', 'Ledger credit data',
        'action:S action_index:D address:s tick:s amount:s ' + TX_TAIL],
    ['Debit', 'getDebits', 'Ledger debit data',
        'action:S action_index:D address:s tick:s amount:s ' + TX_TAIL],
    ['Escrow', 'getEscrows', 'Escrowed balance data',
        'action:S action_index:D address:s tick:s amount:s ' + TX_TAIL],
    ['Balance', 'getBalances', 'Address token balance data',
        'tick:s amount:s supply:s decimals:i coin_price:s'],
    ['TokenRow', 'getTokens', 'One token from the token search',
        'id:d tick:s supply:s max_supply:s max_mint:s decimals:i lock_max_supply:i lock_mint:i lock_mint_supply:i'
            + ' lock_max_mint:i lock_description:i lock_sleep:i lock_callback:i ' + TX_TAIL],
];

const SUMMARY_DETAILS = {
    type: ['object', 'boolean'],
    description: 'Summary fields of the action (tick, amount, destination and the like); false when the action carries none',
};

const HISTORY = rowSchema('History data', 'action:S action_index:D parent_batch_action_index:d status:s ' + TX_TAIL,
    { parent_batch_action_index: 'The BATCH this action rode in; null outside a batch' },
    { details: SUMMARY_DETAILS });

const MARKET = rowSchema('DEX market data',
    'tick1:s tick1_price:s tick1_bid:s tick1_ask:s tick1_24hr_price:s tick1_24hr_high:s tick1_24hr_low:s'
        + ' tick1_24hr_change:s tick1_24hr_volume:s tick2:s tick2_price:s tick2_bid:s tick2_ask:s tick2_24hr_price:s'
        + ' tick2_24hr_high:s tick2_24hr_low:s tick2_24hr_change:s tick2_24hr_volume:s last_updated:d',
    null, { id: { type: 'integer' } });

const TRADE_SIDE = { type: 'string', enum: ['buy', 'sell'] };

const MARKET_HISTORY = rowSchema('DEX market history data', 'action_index:D block_index:D timestamp:D', null, {
    type: TRADE_SIDE, price: { type: 'string' }, amount: { type: 'string' } });

const MARKET_ORDER = rowSchema('DEX market order data', 'action_index:D', null, {
    type: TRADE_SIDE, price: { type: 'string' }, amount: { type: ['string', 'null'] },
    expiration: { type: ['string', 'integer', 'null'],
        description: 'Expiration block: a decimal string, or a number once an ORDER_EDIT has changed it' } });

const LEDGER_EFFECT = rowSchema('One ledger row the action wrote', 'address:s tick:s amount:s');
const LEDGER_EFFECTS = (what) => ({ type: ['array', 'null'], items: LEDGER_EFFECT, description: `The ${what} this action wrote; null when none` });

const ACTION_FEE = rowSchema('The protocol fee this action paid',
    'source:s destination:s tick:s amount:s method:d gas_cost:d gas_price:s xchain_amount:s payment_mode:i'
        + ' native_coin_amount:s native_coin:s oracle_round:d fee_preference:i fee_version:i');

const RUNTIME = { type: 'string', description: 'Amount of time to execute and return the data' };
const NULLABLE_STRING = { type: ['string', 'null'] };
const NULLABLE_INTEGER = { type: ['integer', 'null'] };

const ACTION_DETAIL = {
    type: 'object',
    description: 'One action, fully decoded. Carries the fields its action type defines (the columns its list route serves plus any detail-only sections) and the ledger tail below, which every action carries.',
    properties: {
        action: { type: 'string' },
        action_format: NULLABLE_INTEGER,
        action_index: COLUMN_TYPES.D,
        block_index: COLUMN_TYPES.d,
        credits: LEDGER_EFFECTS('credits'),
        debits: LEDGER_EFFECTS('debits'),
        escrows: LEDGER_EFFECTS('escrows'),
        fee: { oneOf: [{ type: 'null' }, ACTION_FEE], description: 'Action fee information; null when the action paid none' },
        runtime: RUNTIME,
        source: NULLABLE_STRING,
        status: NULLABLE_STRING,
        timestamp: COLUMN_TYPES.d,
        tx_data: { type: ['string', 'null'], description: 'The decoded action string of the carrying transaction; null for a system-injected action' },
        tx_hash: NULLABLE_STRING,
        tx_index: COLUMN_TYPES.d,
    },
};

const BLOCK = {
    type: 'object',
    description: 'COIN block data',
    properties: {
        actions_hash: { type: ['string', 'null'], description: 'sha256 of the block\'s actions data' },
        block_index: COLUMN_TYPES.D,
        contract_hash: { type: ['string', 'null'], description: 'sha256 of the block\'s contract data' },
        ledger_hash: { type: ['string', 'null'], description: 'sha256 of the block\'s credits, debits, escrows and balances' },
        runtime: RUNTIME,
        state_hash: { type: ['string', 'null'], description: 'sha256 of in-place mutations and backdated credits (replication integrity only)' },
        timestamp: COLUMN_TYPES.D,
    },
    required: ['block_index', 'timestamp'],
};

const TRANSACTION = {
    type: 'object',
    description: 'Transaction data. An unknown transaction answers only an empty actions list and a null tx_data.',
    properties: {
        actions: {
            type: 'array',
            description: 'Actions this transaction carried, newest first',
            items: rowSchema('One action summary', 'action:s action_index:D status:s', null, { details: SUMMARY_DETAILS }),
        },
        block_index: COLUMN_TYPES.D,
        runtime: RUNTIME,
        source: NULLABLE_STRING,
        timestamp: COLUMN_TYPES.D,
        tx_data: { type: ['string', 'null'], description: 'The decoded action string the transaction carries' },
        tx_hash: NULLABLE_STRING,
        tx_index: COLUMN_TYPES.D,
    },
    required: ['actions', 'tx_data'],
};

const AMOUNTS_OR_NULL = (names, schema) => Object.fromEntries(names.map((n) => [n, schema]));

const ADDRESS_INFO = {
    type: 'object',
    description: 'Address information (type, native-coin balances and UTXO counts from this coin\'s UTXO tracker, controller bindings). Tracker fields stay null when no tracker is configured or it is unreachable.',
    properties: {
        address: { type: 'string' },
        balances: { type: 'object', description: 'Balances of COIN (BTC, LTC, DOGE, etc) as decimal strings',
            properties: AMOUNTS_OR_NULL(['confirmed', 'pending', 'received'], NULLABLE_STRING) },
        controllers: { type: 'array', items: { type: 'object' }, description: 'Controller bindings still gating this address\'s native actions; empty when none' },
        estimated_value: { type: 'object', description: 'Estimated value of the confirmed balance in COIN and in USD',
            properties: AMOUNTS_OR_NULL(['btc', 'usd'], NULLABLE_STRING) },
        info: { type: 'object', properties: {
            address: { type: 'string' },
            address_id: { type: ['integer', 'null'], description: 'The address\'s deterministic index id, for ^<id> compaction; null when not deterministic' } } },
        mempool_ready: { type: 'boolean', description: 'Present only when the tracker reports it' },
        runtime: RUNTIME,
        tracker_available: { type: 'boolean' },
        type: { type: ['string', 'null'], description: 'Address Type (P2PKH, P2SH, Bech32, P2TR)' },
        utxos: { type: 'object', description: 'Unspent Transaction Output counts (UTXOs)',
            properties: AMOUNTS_OR_NULL(['confirmed', 'pending'], NULLABLE_INTEGER) },
    },
    required: ['address', 'balances', 'utxos', 'estimated_value', 'tracker_available', 'controllers', 'info'],
};

const BOOL_MAP = (names) => Object.fromEntries(names.map((n) => [n, { type: 'boolean' }]));
const NUMBER = { type: 'number' };

const TOKEN = {
    type: 'object',
    description: 'Token data. `locks.bridge` and the bridge fields of `info` appear only on a database that carries the bridge columns.',
    properties: {
        callback: { type: 'object', properties: {
            amount: { type: ['string', 'null'] }, block: COLUMN_TYPES.d, price: NULLABLE_STRING, tick: NULLABLE_STRING } },
        controllers: { type: 'array', items: { type: 'object' } },
        info: { type: 'object', properties: {
            bridge_chains: NULLABLE_STRING, bridged: NULLABLE_INTEGER, coin: { type: 'string' },
            decimals: { type: 'integer' }, description: NULLABLE_STRING, escrow_action_index: COLUMN_TYPES.d,
            min_depth: COLUMN_TYPES.d, owner: NULLABLE_STRING, tick: NULLABLE_STRING,
            tick_id: { type: ['integer', 'null'], description: 'Deterministic ticker id, for ^<id> compaction; null when not deterministic' } } },
        linked_files: { type: 'array', items: { type: 'object', properties: {
            action_index: { type: 'integer' }, block_index: { type: 'integer' }, gated: { type: 'boolean' },
            name: NULLABLE_STRING, title: NULLABLE_STRING, type: NULLABLE_STRING } } },
        lists: { type: 'object', properties: AMOUNTS_OR_NULL(['allow', 'block'], NULLABLE_INTEGER) },
        locks: { type: 'object', properties: BOOL_MAP(['bridge', 'callback', 'description', 'max_mint', 'max_supply', 'mint', 'mint_supply', 'sleep']) },
        market: { type: 'object', properties: { floor: NUMBER, price: NUMBER } },
        mints: { type: 'object', properties: AMOUNTS_OR_NULL(['address_max', 'max', 'start_block', 'stop_block'], NUMBER) },
        open_polls: { type: 'array', items: { type: 'object' } },
        projects: { type: 'array', items: { type: 'object' } },
        registry: { oneOf: [{ type: 'null' }, { type: 'object', properties: AMOUNTS_OR_NULL(
            ['link_action_index', 'membership_action_index', 'roster_action_index', 'total'], { type: 'integer' }) }] },
        runtime: RUNTIME,
        supply: { type: 'object', properties: {
            current: NULLABLE_STRING, decimals: { type: 'integer' }, max: NULLABLE_STRING } },
    },
    required: ['info', 'callback', 'market', 'lists', 'locks', 'mints', 'supply'],
};

const PRICE_LEVEL = { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2, description: '[price, amount]' };

const ORDERBOOK = {
    type: 'object',
    description: 'DEX market orderbook data',
    properties: {
        asks: { type: 'array', items: PRICE_LEVEL, description: 'Open asks aggregated by price, lowest first' },
        bids: { type: 'array', items: PRICE_LEVEL, description: 'Open bids aggregated by price, highest first' },
        market: { type: 'string', description: 'TICK1/TICK2; present only when the book has orders' },
        runtime: RUNTIME,
    },
    required: ['asks', 'bids'],
};

// /status body, kept field-for-field with getStatus by the tip-freshness suite.
const EXPLORER_STATUS = {
    "type": "object",
    "description": "Explorer status data",
    "properties": {
        "available": {
            "type": "object",
            "description": "Coin networks this instance serves as CURRENT data, keyed by coin ticker. Starts from the configured availability map and then drops every coin the tip-age gate marks stale (see 'stale'), so this map varies per request and a delisted coin still appears in 'supported'. Read this to decide whether to query a coin; read 'supported' to learn which coins the instance knows about at all.",
            "additionalProperties": {
                "type": "string"
            }
        },
        "hub_config_fetched_at": {
            "type": [
                "string",
                "null"
            ],
            "description": "ISO-8601 timestamp of the last successful hub-config fetch. null until the first successful fetch.",
            "format": "date-time"
        },
        "hub_config_age_seconds": {
            "type": [
                "integer",
                "null"
            ],
            "description": "Seconds since the last successful hub-config fetch. A climbing value means the served hub-derived config is stale. null until the first successful fetch."
        },
        "last_block": {
            "type": "object",
            "description": "Most recent block index processed by the indexer, keyed by coin ticker (e.g. RBTC: 850). Value is null for a coin whose per-coin DB read failed (the outage this health endpoint exists to surface).",
            "additionalProperties": {
                "type": [
                    "integer",
                    "null"
                ]
            }
        },
        "last_block_time": {
            "type": "object",
            "description": "Unix block_time of the most recent block processed by the indexer, keyed by coin ticker. Compare against the chain tip to detect indexer lag. Value is null for a coin whose per-coin DB read failed.",
            "additionalProperties": {
                "type": [
                    "integer",
                    "null"
                ]
            }
        },
        "decoder_tip": {
            "type": "object",
            "description": "Decoder's highest processed block index, keyed by coin ticker. null when the decoder tip is unavailable.",
            "additionalProperties": {
                "type": [
                    "integer",
                    "null"
                ]
            }
        },
        "decoder_lag_blocks": {
            "type": "object",
            "description": "decoder_tip minus last_block (how far the indexer trails the decoder), keyed by coin ticker. null when the decoder tip is unavailable.",
            "additionalProperties": {
                "type": [
                    "integer",
                    "null"
                ]
            }
        },
        "tip_age_seconds": {
            "type": "object",
            "description": "Wall-clock seconds between now and the block_time of the newest indexed block, keyed by coin ticker. Never negative: a tip dated ahead of this host clamps to 0 here and reports its skew in tip_future_seconds. null when that block_time is missing or unreadable. Unlike decoder_lag_blocks this sees a JOINT indexer+decoder freeze, because it measures against the local clock rather than against the other replica. Only coins this instance measures (those with a live pool) appear here.",
            "additionalProperties": {
                "type": [
                    "integer",
                    "null"
                ]
            }
        },
        "tip_future_seconds": {
            "type": "object",
            "description": "Seconds the newest indexed block is dated AHEAD of this host's clock, keyed by coin ticker; 0 when the tip is not ahead, null when block_time is missing or unreadable. A non-zero value is host clock drift or a chain with lax timestamp rules, and it means tip_age_seconds is clamped rather than measured. Skew past the tolerance (EXPLORER_TIP_MAX_FUTURE_SKEW_S_<COIN>, else EXPLORER_TIP_MAX_FUTURE_SKEW_S, default 7200; 0 disables the check) reads stale, so a future-dated tip cannot pass as fresh indefinitely. Only coins this instance measures appear here.",
            "additionalProperties": {
                "type": [
                    "integer",
                    "null"
                ]
            }
        },
        "indexer_state": {
            "type": "object",
            "description": "Why the indexer trails the decoder, keyed by coin ticker. 'live' when decoder_lag_blocks is 0; 'future_block_wait' when the next block (last_block + 1) carries a block_time dated ahead of this host's clock, meaning no node on the chain may commit it yet and the pause is consensus rather than failure; 'behind' when that next block is already admissible and still uncommitted, which is the state worth alerting on; null when it cannot be determined. Read this field, NOT tip_future_seconds, to tell a deliberate wait apart from a wedge: tip_future_seconds describes the block the indexer has already committed, which is always past-dated, so it reads 0 for the whole duration of a future_block_wait. Chains with lax timestamp rules (Bitcoin testnet4 rides the 20-minute minimum-difficulty rule, stamping blocks about 1201s apart into the future) sit in future_block_wait as their steady state. Only coins this instance measures appear here.",
            "additionalProperties": {
                "type": [
                    "string",
                    "null"
                ]
            }
        },
        "next_block_time": {
            "type": "object",
            "description": "The decoder's recorded block_time (unix seconds) for the next block the indexer must commit (last_block + 1), keyed by coin ticker. Read from the decoder DB because the indexer has not committed that block yet. null when the indexer is at the decoder tip, the decoder DB is unreachable, or that block carries no usable timestamp. Only coins this instance measures appear here.",
            "additionalProperties": {
                "type": [
                    "integer",
                    "null"
                ]
            }
        },
        "next_block_future_seconds": {
            "type": "object",
            "description": "Seconds the next block to be committed is dated AHEAD of this host's clock, keyed by coin ticker; 0 when it is not ahead, null when unknown. This is the honest measure of a consensus wait, and the value tip_future_seconds is often mistaken for. Only coins this instance measures appear here.",
            "additionalProperties": {
                "type": [
                    "integer",
                    "null"
                ]
            }
        },
        "indexer_wait_clears_at": {
            "type": "object",
            "description": "ISO-8601 instant at which a 'future_block_wait' ends for that coin, i.e. when this host's clock reaches the next block's timestamp and the block becomes committable, keyed by coin ticker. null in every other state. Present so a client can render a countdown rather than leaving a confirmed-but-unindexed transaction looking lost. Only coins this instance measures appear here.",
            "additionalProperties": {
                "type": [
                    "string",
                    "null"
                ]
            }
        },
        "stale": {
            "type": "object",
            "description": "Tip-freshness verdict per coin ticker: true when tip_age_seconds has passed that coin's max tip age (EXPLORER_TIP_MAX_AGE_S_<COIN>, else EXPLORER_TIP_MAX_AGE_S, default 21600; 0 disables the gate), and also true when tip_future_seconds has passed that coin's max future skew. Fails closed, so a missing or unreadable block_time also reads true. A true entry is removed from 'available' and left in 'supported'. Only coins this instance measures appear here.",
            "additionalProperties": {
                "type": "boolean"
            }
        },
        "replica_halted": {
            "type": "object",
            "description": "Durable consensus-divergence halt verdict per coin ticker, read from xchain-sync's sync_halt tables on the indexer and decoder replicas (true = either database has an active, uncleared halt row). A halted replica keeps reporting a small lag until its source mints past it, so this is detectable neither by 'stale' nor by tip_age_seconds; it composes with 'stale' rather than replacing it (immediate detection here, eventual removal from 'available' there). true/false only when both tables were read successfully; null when the signal could not be determined (table absent, e.g. a DB not built by the sync client, or the read failed) and is never coerced to false. Only coins this instance measures appear here.",
            "additionalProperties": {
                "type": [
                    "boolean",
                    "null"
                ]
            }
        },
        "chain_tip": {
            "type": "object",
            "description": "Coin node's chain tip as the decoder reports it, keyed by coin ticker. null when the decoder health call is unavailable.",
            "additionalProperties": {
                "type": [
                    "integer",
                    "null"
                ]
            }
        },
        "chain_lag_blocks": {
            "type": "object",
            "description": "Decoder's self-reported gap to the chain tip, keyed by coin ticker. null when the decoder health call is unavailable.",
            "additionalProperties": {
                "type": [
                    "integer",
                    "null"
                ]
            }
        },
        "decoder_health": {
            "type": "object",
            "description": "Decoder self-reported status per coin ticker: 'healthy', 'unhealthy', 'node-stale' (the decoder's cached coin-node height is frozen, so chain_tip and chain_lag_blocks are nulled out), 'unconfigured' (no decoder URL set), or 'unreachable' (health call failed).",
            "additionalProperties": {
                "type": "string"
            }
        },
        "supported": {
            "type": "object",
            "description": "Every coin network the XChain platform defines for this instance, keyed by coin ticker with a display name as the value. Static per config: the tip-age gate never removes a coin from here, only from 'available'.",
            "additionalProperties": {
                "type": "string"
            }
        }
    }
};

// Paged list body: the envelope plus this route's row type.
function listBody(rowName, extra) {
    const properties = Object.assign({
        total: { type: 'integer', description: 'Total number of records available' },
        data: { type: 'array', items: { $ref: '#/components/schemas/' + rowName } },
        runtime: RUNTIME,
    }, extra || {});
    return { type: 'object', properties, required: ['total', 'data'] };
}

// The market readers hand back COUNT(*) untouched, so the sink writes it as a string.
const STRING_TOTAL = { total: { type: 'string', pattern: '^[0-9]+$', description: 'Total number of records available, as a decimal string' } };

const HOLDER = listBody('HolderRow', {
    coin_price: { type: 'string', description: 'Token price in COIN; absent when the token has no holders' },
    decimals: { type: 'integer', description: 'Absent when the token has no holders' },
    supply: { type: 'string', description: 'Absent when the token has no holders' },
    tick: { type: 'string', description: 'Absent when the token has no holders' },
});
HOLDER.description = 'Token holder data';

const COMPONENT_SCHEMAS = Object.assign(
    Object.fromEntries(ROWS.map(([name, , description, spec, notes]) => [name, rowSchema(description, spec, notes)])),
    {
        ActionDetail: ACTION_DETAIL, AddressInfo: ADDRESS_INFO, Block: BLOCK, ExplorerStatus: EXPLORER_STATUS,
        History: HISTORY, Holder: HOLDER, HolderRow: rowSchema('One holder of a token', 'address:s amount:s'),
        Market: MARKET, MarketHistory: MARKET_HISTORY, MarketOrder: MARKET_ORDER, Orderbook: ORDERBOOK,
        Token: TOKEN, Transaction: TRANSACTION,
    });

// db method -> row schema of its paged list body.
const ROW_SCHEMAS = Object.assign(Object.fromEntries(ROWS.map(([name, method]) => [method, name])), {
    getHistory: 'History', getMarkets: 'Market', getMarketHistory: 'MarketHistory', getMarketOrders: 'MarketOrder',
});

// db method -> extra top-level fields its list body carries.
const LIST_EXTRAS = {
    getBalances: { address: { type: ['string', 'null'], description: 'The queried address, echoed when it is address-shaped' } },
    getMarkets: STRING_TOTAL, getMarketHistory: STRING_TOTAL, getMarketOrders: STRING_TOTAL,
};

// db method -> component schema of its whole 200 body.
const BODY_SCHEMAS = {
    getAction: 'ActionDetail', getAddress: 'AddressInfo', getBlock: 'Block', getHolders: 'Holder',
    getOrderbook: 'Orderbook', getStatus: 'ExplorerStatus', getToken: 'Token', getTransaction: 'Transaction',
};

// The typed 200 schema for a route calling `method`, or null for the generic one.
function responseSchema(method) {
    if (BODY_SCHEMAS[method]) return { $ref: '#/components/schemas/' + BODY_SCHEMAS[method] };
    if (ROW_SCHEMAS[method]) return listBody(ROW_SCHEMAS[method], LIST_EXTRAS[method]);
    return null;
}

module.exports = { COMPONENT_SCHEMAS, ROW_SCHEMAS, BODY_SCHEMAS, POST_PASS_COLUMNS: { getDispensers: ['escrow_remaining', 'current_status'] }, responseSchema };
