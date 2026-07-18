-- ********************************************************************
--
-- Copyright © 2025-2026 Dankest, LLC
-- Based on XChain Platform by Dankest, LLC - https://dankest.llc
--
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- This file is part of XChain Platform. Licensed under the GNU Affero
-- General Public License v3.0 or later; see LICENSE.md. A commercial
-- license (without AGPL source-disclosure terms) is available -
-- contact legal@dankest.llc.
--
-- ********************************************************************

-- XChain Explorer Integration Test - Baseline Seed Data
-- Populates a minimal but realistic dataset for API testing

-- Reference tables first (index_*)
INSERT INTO index_actions (id, action) VALUES
(1, 'SEND'), (2, 'ISSUE'), (3, 'ORDER'), (4, 'DESTROY'),
(5, 'DISPENSER'), (6, 'DISPENSE'), (7, 'MINT'), (8, 'BROADCAST'), (9, 'XCALL');

INSERT INTO index_addresses (id, address) VALUES
(1, 'bc1qaddr1aaaaaaaaaaaaaaaaaaaaaaaaaaa'),
(2, 'bc1qaddr2bbbbbbbbbbbbbbbbbbbbbbbbbbb'),
(3, 'bc1qaddr3ccccccccccccccccccccccccccc'),
(4, 'bc1qaddr4ddddddddddddddddddddddddddd'),
(5, 'bc1qaddr5eeeeeeeeeeeeeeeeeeeeeeeeeee');

INSERT INTO index_tickers (id, tick) VALUES
(1, 'XCHAIN'), (2, 'TOKENONE'), (3, 'TOKENTWO'), (4, 'TOKENTHREE');

INSERT INTO index_transactions (id, hash) VALUES
(1, 'aaa1111111111111111111111111111111111111111111111111111111111111'),
(2, 'bbb2222222222222222222222222222222222222222222222222222222222222'),
(3, 'ccc3333333333333333333333333333333333333333333333333333333333333'),
(4, 'ddd4444444444444444444444444444444444444444444444444444444444444'),
(5, 'eee5555555555555555555555555555555555555555555555555555555555555'),
(6, 'fff6666666666666666666666666666666666666666666666666666666666666'),
(7, 'ggg7777777777777777777777777777777777777777777777777777777777777'),
(8, 'hhh8888888888888888888888888888888888888888888888888888888888888'),
(9, 'iii9999999999999999999999999999999999999999999999999999999999999'),
(10, 'jjj0000000000000000000000000000000000000000000000000000000000000'),
(11, 'kkk1111111111111111111111111111111111111111111111111111111111111'),
(12, 'lll2222222222222222222222222222222222222222222222222222222222222'),
(13, 'mmm3333333333333333333333333333333333333333333333333333333333333'),
(14, 'nnn4444444444444444444444444444444444444444444444444444444444444'),
(15, 'ooo5555555555555555555555555555555555555555555555555555555555555'),
(16, 'ppp6666666666666666666666666666666666666666666666666666666666666'),
(17, 'qqq7777777777777777777777777777777777777777777777777777777777777'),
(18, 'rrr8888888888888888888888888888888888888888888888888888888888888'),
(19, 'sss9999999999999999999999999999999999999999999999999999999999999'),
(20, 'ttt0000000000000000000000000000000000000000000000000000000000000');

-- Ledger/actions hashes for blocks
INSERT INTO index_transactions (id, hash) VALUES
(21, 'ledger_hash_block_1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
(22, 'ledger_hash_block_2_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
(23, 'ledger_hash_block_3_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
(24, 'ledger_hash_block_4_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
(25, 'ledger_hash_block_5_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
(26, 'ledger_hash_block_6_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
(27, 'ledger_hash_block_7_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
(28, 'ledger_hash_block_8_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
(29, 'ledger_hash_block_9_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
(30, 'ledger_hash_block_10_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

INSERT INTO index_statuses (id, status) VALUES
(1, 'valid'), (2, 'invalid'), (3, 'open'), (4, 'filled'), (5, 'cancelled');

INSERT INTO index_coins (id, coin) VALUES
(1, 'BTC'), (2, 'LTC'), (3, 'DOGE');

INSERT INTO index_memos (id, memo) VALUES
(1, 'Test memo 1'), (2, 'Test memo 2');

-- index_fiats: pre-populated by schema.sql (from DDL), not needed here

INSERT INTO index_mime_types (id, type) VALUES
(1, 'image/png');

-- Blocks (10 blocks)
INSERT INTO blocks (id, block_index, block_time, ledger_hash_id, actions_hash_id) VALUES
(1, 1, 1700000000, 21, NULL),
(2, 2, 1700000600, 22, NULL),
(3, 3, 1700001200, 23, NULL),
(4, 4, 1700001800, 24, NULL),
(5, 5, 1700002400, 25, NULL),
(6, 6, 1700003000, 26, NULL),
(7, 7, 1700003600, 27, NULL),
(8, 8, 1700004200, 28, NULL),
(9, 9, 1700004800, 29, NULL),
(10, 10, 1700005400, 30, NULL);

-- Transactions (20 txs across blocks, each with source_id)
INSERT INTO transactions (tx_index, block_index, tx_hash_id, source_id) VALUES
(1, 1, 1, 1), (2, 1, 2, 2),
(3, 2, 3, 1), (4, 2, 4, 3),
(5, 3, 5, 2), (6, 3, 6, 1),
(7, 4, 7, 4), (8, 4, 8, 2),
(9, 5, 9, 1), (10, 5, 10, 3),
(11, 6, 11, 5), (12, 6, 12, 1),
(13, 7, 13, 2), (14, 7, 14, 4),
(15, 8, 15, 3), (16, 8, 16, 1),
(17, 9, 17, 5), (18, 9, 18, 2),
(19, 10, 19, 1), (20, 10, 20, 3);

-- Actions (30 actions across txs)
-- action_id: 1=SEND, 2=ISSUE, 3=ORDER, 4=DESTROY, 5=DISPENSER, 6=DISPENSE, 7=MINT, 8=BROADCAST
INSERT INTO actions (action_index, block_index, tx_index, tx_vout, action_id, action_format) VALUES
(1, 1, 1, 0, 2, 1),   -- ISSUE in block 1
(2, 1, 2, 0, 2, 1),   -- ISSUE in block 1
(3, 2, 3, 0, 1, 1),   -- SEND in block 2
(4, 2, 4, 0, 1, 1),   -- SEND in block 2
(5, 3, 5, 0, 1, 1),   -- SEND in block 3
(6, 3, 6, 0, 1, 1),   -- SEND in block 3
(7, 4, 7, 0, 3, 1),   -- ORDER in block 4
(8, 4, 8, 0, 3, 1),   -- ORDER in block 4
(9, 5, 9, 0, 1, 1),   -- SEND in block 5
(10, 5, 10, 0, 1, 1),  -- SEND in block 5
(11, 6, 11, 0, 5, 1),  -- DISPENSER in block 6
(12, 6, 12, 0, 5, 1),  -- DISPENSER in block 6
(13, 7, 13, 0, 6, 1),  -- DISPENSE in block 7
(14, 7, 14, 0, 6, 1),  -- DISPENSE in block 7
(15, 8, 15, 0, 1, 1),  -- SEND in block 8
(16, 8, 16, 0, 1, 1),  -- SEND in block 8
(17, 9, 17, 0, 2, 1),  -- ISSUE in block 9
(18, 9, 18, 0, 7, 1),  -- MINT in block 9
(19, 10, 19, 0, 1, 1), -- SEND in block 10
(20, 10, 20, 0, 4, 1), -- DESTROY in block 10
(21, 3, 5, 1, 3, 1),   -- ORDER in block 3 (same tx as action 5)
(22, 4, 7, 1, 3, 1),   -- ORDER in block 4
(23, 5, 9, 1, 3, 1),   -- ORDER in block 5
(24, 5, 10, 1, 3, 1),  -- ORDER in block 5
(25, 6, 11, 1, 6, 1),  -- DISPENSE in block 6
(26, 6, 12, 1, 6, 1),  -- DISPENSE in block 6
(27, 7, 13, 1, 1, 1),  -- SEND in block 7
(28, 8, 15, 1, 7, 1),  -- MINT in block 8
(29, 9, 17, 1, 2, 1),  -- ISSUE in block 9
(30, 10, 19, 1, 8, 1),  -- BROADCAST in block 10
(31, 10, 20, 1, 9, 0); -- XCALL (v0 request) in block 10

-- Tokens (4 tokens)
INSERT INTO tokens (id, tick_id, action_index, last_action_index, supply, max_supply, max_mint, decimals, description,
    lock_max_supply, lock_mint, lock_mint_supply, lock_max_mint, lock_description, lock_sleep, lock_callback,
    callback_block, callback_tick_id, callback_amount, allow_list, block_list, mint_address_max, mint_start_block, mint_stop_block,
    owner_id, coin_price, coin_floor) VALUES
(1, 1, 1, 18, '1000000.00000000', '21000000.00000000', '1000.00000000', 8, 'XChain gas token',
    0, 0, 0, 0, 0, 0, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1, '0.00010000', '0'),
(2, 2, 2, 17, '500000.00000000', '1000000.00000000', '500.00000000', 8, 'Test Token One',
    1, 0, 0, 0, 0, 0, 0, NULL, NULL, NULL, NULL, NULL, '100.00000000', NULL, NULL, 2, '0.00005000', '0'),
(3, 3, 17, 17, '250000.00000000', '500000.00000000', NULL, 8, 'Test Token Two',
    0, 0, 0, 0, 0, 0, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1, '0.00002000', '0'),
(4, 4, 29, 29, '100.0000', '100.0000', NULL, 4, 'Test Token Three (4 decimals)',
    1, 1, 1, 1, 1, 0, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 3, '0.01000000', '0.00500000');

-- Balances (10 rows across addresses and tokens)
INSERT INTO balances (id, address_id, tick_id, amount) VALUES
(1, 1, 1, '500000.00000000'),
(2, 1, 2, '100000.00000000'),
(3, 1, 3, '50000.00000000'),
(4, 2, 1, '200000.00000000'),
(5, 2, 2, '150000.00000000'),
(6, 3, 1, '100000.00000000'),
(7, 3, 3, '100000.00000000'),
(8, 4, 2, '50000.00000000'),
(9, 4, 4, '75.0000'),
(10, 5, 4, '25.0000');

-- Sends (8 sends)
INSERT INTO sends (action_index, tick_id, destination_id, amount, memo_id, status_id) VALUES
(3, 1, 2, '1000.00000000', 1, 1),
(4, 2, 1, '500.00000000', NULL, 1),
(5, 1, 3, '2000.00000000', NULL, 1),
(6, 2, 4, '250.00000000', 2, 1),
(9, 1, 5, '100.00000000', NULL, 1),
(10, 3, 2, '750.00000000', NULL, 1),
(15, 2, 1, '300.00000000', 1, 2),
(16, 1, 4, '50.00000000', NULL, 1);

-- Additional sends for the SEND action in blocks 7 and 10
INSERT INTO sends (action_index, tick_id, destination_id, amount, memo_id, status_id) VALUES
(19, 1, 2, '500.00000000', NULL, 1),
(27, 3, 5, '125.00000000', NULL, 1);

-- Issues (4 issues)
INSERT INTO issues (action_index, tick_id, max_supply, max_mint, decimals, description, mint_supply,
    transfer_id, transfer_supply_id, lock_max_supply, lock_mint, lock_mint_supply, lock_max_mint,
    lock_description, lock_sleep, lock_callback, callback_block, callback_tick_id, callback_amount,
    allow_list, block_list, mint_address_max, mint_start_block, mint_stop_block, memo_id, status_id) VALUES
(1, 1, '21000000.00000000', '1000.00000000', '8', 'XChain gas token', NULL,
    NULL, NULL, '0', '0', '0', '0', '0', '0', '0', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1),
(2, 2, '1000000.00000000', '500.00000000', '8', 'Test Token One', NULL,
    NULL, NULL, '1', '0', '0', '0', '0', '0', '0', NULL, NULL, NULL, NULL, NULL, '100.00000000', NULL, NULL, NULL, 1),
(17, 3, '500000.00000000', NULL, '8', 'Test Token Two', NULL,
    NULL, NULL, '0', '0', '0', '0', '0', '0', '0', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1),
(29, 4, '100.0000', NULL, '4', 'Test Token Three (4 decimals)', NULL,
    NULL, NULL, '1', '1', '1', '1', '1', '0', '0', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1);

-- Orders (6 orders with different statuses)
INSERT INTO orders (action_index, give_coin_id, give_tick_id, give_amount, get_coin_id, get_tick_id, get_amount,
    get_address_id, expiration, allow_list, block_list, memo_id, status_id) VALUES
(7, NULL, 1, '100.00000000', NULL, 2, '200.00000000', NULL, 100, NULL, NULL, NULL, 3),
(8, NULL, 2, '50.00000000', NULL, 1, '25.00000000', NULL, 100, NULL, NULL, NULL, 3),
(21, NULL, 1, '500.00000000', NULL, 3, '1000.00000000', NULL, 200, NULL, NULL, NULL, 4),
(22, NULL, 3, '200.00000000', NULL, 1, '100.00000000', NULL, 200, NULL, NULL, NULL, 5),
(23, NULL, 2, '75.00000000', NULL, 3, '150.00000000', NULL, 50, NULL, NULL, NULL, 3),
(24, NULL, 1, '1000.00000000', NULL, 2, '2000.00000000', NULL, 500, NULL, NULL, NULL, 3);

-- Order statuses (for market order queries - need latest status per order)
INSERT INTO order_statuses (action_index, order_action_index, status_id) VALUES
(7, 7, 3),    -- order 7 -> open
(8, 8, 3),    -- order 8 -> open
(21, 21, 3),  -- order 21 -> initially open
(22, 22, 3),  -- order 22 -> initially open
(23, 23, 3),  -- order 23 -> open
(24, 24, 3),  -- order 24 -> open
(100, 21, 4), -- order 21 -> filled (later status update, higher action_index)
(101, 22, 5); -- order 22 -> cancelled

-- Order matches (3 matches)
INSERT INTO order_matches (action_index, give_action_index, give_coin_id, give_tick_id, give_amount,
    get_action_index, get_coin_id, get_tick_id, get_amount, status_id) VALUES
(50, 7, 1, 1, '50.00000000', 8, 1, 2, '100.00000000', 1),
(51, 21, 1, 1, '500.00000000', 22, 1, 3, '1000.00000000', 1),
(52, 23, 1, 2, '25.00000000', 24, 1, 1, '50.00000000', 1);

-- Dispensers (3: open, closed, empty)
INSERT INTO dispensers (action_index, give_coin_id, give_tick_id, give_amount, give_escrow,
    get_coin_id, get_tick_id, get_amount, get_address_id, fiat_id, fiat_amount,
    expiration, allow_list, block_list, memo_id, status_id) VALUES
(11, NULL, 2, '10.00000000', '100.00000000', NULL, 1, '0.00100000', NULL, NULL, NULL, 100, NULL, NULL, NULL, 3),
(12, NULL, 3, '5.00000000', '50.00000000', NULL, 1, '0.00050000', NULL, NULL, NULL, 200, NULL, NULL, NULL, 4),
(25, NULL, 1, '1.00000000', '10.00000000', NULL, 2, '2.00000000', NULL, NULL, NULL, 50, NULL, NULL, NULL, 3);

-- Dispenses (4 dispenses)
INSERT INTO dispenses (action_index, dispenser_action_index, give_coin_id, give_tick_id, give_amount,
    get_coin_id, get_tick_id, get_amount, destination_id, status_id) VALUES
(13, 11, NULL, 2, '10.00000000', NULL, 1, '0.00100000', 3, 1),
(14, 11, NULL, 2, '10.00000000', NULL, 1, '0.00100000', 4, 1),
(25, 12, NULL, 3, '5.00000000', NULL, 1, '0.00050000', 2, 1),
(26, 25, NULL, 1, '1.00000000', NULL, 2, '2.00000000', 5, 1);

-- Credits (8 entries)
INSERT INTO credits (action_index, address_id, tick_id, amount) VALUES
(3, 2, 1, '1000.00000000'),
(4, 1, 2, '500.00000000'),
(5, 3, 1, '2000.00000000'),
(6, 4, 2, '250.00000000'),
(9, 5, 1, '100.00000000'),
(10, 2, 3, '750.00000000'),
(18, 2, 1, '50.00000000'),
(19, 2, 1, '500.00000000');

-- Debits (8 entries)
INSERT INTO debits (action_index, address_id, tick_id, amount) VALUES
(3, 1, 1, '1000.00000000'),
(4, 3, 2, '500.00000000'),
(5, 2, 1, '2000.00000000'),
(6, 1, 2, '250.00000000'),
(9, 1, 1, '100.00000000'),
(10, 3, 3, '750.00000000'),
(19, 1, 1, '500.00000000'),
(20, 3, 1, '1000.00000000');

-- Escrows (4 entries - from orders/dispensers)
INSERT INTO escrows (action_index, address_id, tick_id, amount) VALUES
(7, 4, 1, '100.00000000'),
(8, 2, 2, '50.00000000'),
(11, 5, 2, '100.00000000'),
(12, 1, 3, '50.00000000');

-- Markets (2 trading pairs)
INSERT INTO markets (id, tick1_id, tick1_price, tick1_bid, tick1_ask,
    tick1_24hr_price, tick1_24hr_high, tick1_24hr_low, tick1_24hr_change, tick1_24hr_volume,
    tick2_id, tick2_price, tick2_bid, tick2_ask,
    tick2_24hr_price, tick2_24hr_high, tick2_24hr_low, tick2_24hr_change, tick2_24hr_volume,
    last_updated) VALUES
(1, 1, '2.00000000', '1.95000000', '2.05000000',
    '1.98000000', '2.10000000', '1.90000000', '1.50', '5000.00000000',
    2, '0.50000000', '0.48000000', '0.52000000',
    '0.49000000', '0.55000000', '0.45000000', '-1.50', '10000.00000000',
    1700005400),
(2, 1, '5.00000000', '4.90000000', '5.10000000',
    '4.95000000', '5.20000000', '4.80000000', '2.00', '3000.00000000',
    3, '0.20000000', '0.19000000', '0.21000000',
    '0.19500000', '0.22000000', '0.18000000', '-2.00', '15000.00000000',
    1700005400);

-- Destroys (1 destroy)
INSERT INTO destroys (action_index, tick_id, amount, memo_id, status_id) VALUES
(20, 1, '1000.00000000', NULL, 1);

-- Mints (2 mints)
INSERT INTO mints (action_index, tick_id, amount, destination_id, memo_id, status_id) VALUES
(18, 1, '50.00000000', 2, NULL, 1),
(28, 2, '100.00000000', 3, NULL, 1);

-- Broadcasts (1 broadcast)
INSERT INTO broadcasts (action_index, message, `value`, fee, memo_id, broadcast_action_index, status_id) VALUES
(30, 'BTC/USD price feed', '65000.00', '0.001', NULL, NULL, 1);

-- Mappings for history queries
INSERT INTO mappings_actions (action_index, type_id, id) VALUES
(3, 2, 1), (3, 2, 2), (3, 1, 1),
(4, 2, 3), (4, 2, 1), (4, 1, 2),
(5, 2, 2), (5, 2, 3), (5, 1, 1),
(6, 2, 1), (6, 2, 4), (6, 1, 2),
(9, 2, 1), (9, 2, 5), (9, 1, 1),
(10, 2, 3), (10, 2, 2), (10, 1, 3),
(18, 2, 2), (18, 1, 1),
(19, 2, 1), (19, 2, 2), (19, 1, 1),
(20, 2, 3), (20, 1, 1);

-- ---------------------------------------------------------------------------
-- XCALL cross-chain call lifecycle (action 31, block 10): a completed call
-- with its target-chain execution outcome and source-chain callback delivery.
-- ---------------------------------------------------------------------------
INSERT INTO xcalls (action_index, version, call_id, contract_index, target_chain, target_contract_index, method, params_json, gas_limit, cross_hops, callback_method, callback_params_json, deadline_block, request_status, result_status, result_payload, resolved_block, callback_action_index, block_index, status_id) VALUES
(31, 0, 'cafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafe', 11, 'DOGE', 99, 'onArrival', '["x"]', 50000, 1, 'onResult', '["ctx"]', 300, 'completed', 'ok', '"42"', 10, NULL, 10, 1);

INSERT INTO cross_chain_call_executions (action_index, call_id, execute_action_index, result_status, return_payload_b64, gas_used, block_index) VALUES
(32, 'cafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafe', 33, 'ok', 'NDI=', 1000, 10);

INSERT INTO cross_chain_call_callbacks (action_index, call_id, result_status, block_index) VALUES
(34, 'cafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafe', 'ok', 10);

-- ---------------------------------------------------------------------------
-- Deployed contract (action 40, block 10): backs the contract-page fields
-- (code / code_hash_ok / methods / constructor_params) and the read-only
-- simulation endpoint. code_hash is the real sha256 of the code string.
-- ---------------------------------------------------------------------------
INSERT INTO index_actions (id, action) VALUES (10, 'DEPLOY');

INSERT INTO actions (action_index, block_index, tx_index, tx_vout, action_id, action_format) VALUES
(40, 10, 20, 2, 10, 0); -- DEPLOY in block 10

INSERT INTO contracts (action_index, source_id, code, code_hash, api_version, status_id, block_index) VALUES
(40, 1, 'module.exports = {
    abi: { version: 1, methods: {
        greet: { summary: "Read the stored greeting", params: [], view: true },
        fail: { summary: "Always reverts", params: [] }
    } },
    initialize: function(xchain){ xchain.state.set("greeting", xchain.getInputParam(0)); },
    greet: function(xchain){ return xchain.state.get("greeting") + " @" + xchain.getBlockHeight(); },
    fail: function(xchain){ xchain.revert("always fails"); }
};', '22c284e6186c427bfbb65feaaa8e146cae007aa9c58eb9c73b658196f27327db', 1, 1, 10);

INSERT INTO contract_executions (action_index, contract_index, caller_id, method_name, input_params, gas_used, gas_limit, status_id, error_message, emitted_count, block_index) VALUES
(40, 40, 1, 'constructor', 'howdy', 1200, 50000, 1, NULL, 0, 10);

INSERT INTO contract_state (contract_index, state_key, state_value, block_index, action_index) VALUES
(40, 'greeting', '"stale"', 10, 40),
(40, 'greeting', '"howdy"', 10, 40); -- later row wins (MAX(id) per key)
