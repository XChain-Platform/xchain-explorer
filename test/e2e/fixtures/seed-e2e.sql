--********************************************************************
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
--********************************************************************

-- XChain Explorer E2E Test — Supplemental Seed Data
-- Layers on top of seed-baseline.sql (IDs start at 200+ to avoid conflicts)

-- ============================================================
-- 1. Additional reference data
-- ============================================================

INSERT INTO index_tickers (id, tick) VALUES
(200, 'BIGTOKEN'),
(201, 'SUMTOKEN');

INSERT INTO index_addresses (id, address) VALUES
(210, 'bc1qe2eaddr210aaaaaaaaaaaaaaaaaaaaaa'),
(211, 'bc1qe2eaddr211bbbbbbbbbbbbbbbbbbbbbb'),
(212, 'bc1qe2eaddr212cccccccccccccccccccccc');

INSERT INTO index_transactions (id, hash) VALUES
(200, 'e2e_tx_200_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
(201, 'e2e_tx_201_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
(202, 'e2e_tx_202_ccccccccccccccccccccccccccccccccccccccccccccccccccc'),
(203, 'e2e_tx_203_ddddddddddddddddddddddddddddddddddddddddddddddddd'),
(204, 'e2e_tx_204_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'),
(205, 'e2e_tx_205_fffffffffffffffffffffffffffffffffffffffffffffffffff'),
(206, 'e2e_tx_206_ggggggggggggggggggggggggggggggggggggggggggggggggggg'),
(207, 'e2e_tx_207_hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh'),
(208, 'e2e_tx_208_iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii'),
(209, 'e2e_tx_209_jjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjj'),
(210, 'ledger_hash_block_201_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
(211, 'ledger_hash_block_202_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
(212, 'ledger_hash_block_203_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
(213, 'ledger_hash_block_204_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
(214, 'ledger_hash_block_205_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

INSERT INTO index_actions (id, action) VALUES
(9, 'ORDER_MATCH');

-- ============================================================
-- 2. Additional blocks
-- ============================================================

INSERT INTO blocks (id, block_index, block_time, ledger_hash_id, actions_hash_id) VALUES
(201, 201, 1700060000, 210, NULL),
(202, 202, 1700060600, 211, NULL),
(203, 203, 1700061200, 212, NULL),
(204, 204, 1700061800, 213, NULL),
(205, 205, 1700062400, 214, NULL);

-- ============================================================
-- 3. Multi-action block 201 (E2E-04)
--    Contains SEND + MINT + BROADCAST + ISSUE in one block
-- ============================================================

INSERT INTO transactions (tx_index, block_index, tx_hash_id, source_id) VALUES
(200, 201, 200, 210),
(201, 201, 201, 210),
(202, 201, 202, 210),
(203, 201, 203, 210);

-- action_id: 1=SEND, 2=ISSUE, 7=MINT, 8=BROADCAST
INSERT INTO actions (action_index, block_index, tx_index, tx_vout, action_id, action_format) VALUES
(200, 201, 200, 0, 1, 1),   -- SEND in block 201
(201, 201, 201, 0, 2, 1),   -- ISSUE in block 201
(202, 201, 202, 0, 7, 1),   -- MINT in block 201
(203, 201, 203, 0, 8, 1);   -- BROADCAST in block 201

INSERT INTO sends (action_index, tick_id, destination_id, amount, memo_id, status_id) VALUES
(200, 1, 211, '100.00000000', NULL, 1);

INSERT INTO issues (action_index, tick_id, max_supply, max_mint, decimals, description, mint_supply,
    transfer_id, transfer_supply_id, lock_max_supply, lock_mint, lock_mint_supply, lock_max_mint,
    lock_description, lock_sleep, lock_callback, callback_block, callback_tick_id, callback_amount,
    allow_list, block_list, mint_address_max, mint_start_block, mint_stop_block, memo_id, status_id) VALUES
(201, 200, '99999999999999999.00000000', NULL, '8', 'BigToken for E2E testing', NULL,
    NULL, NULL, '0', '0', '0', '0', '0', '0', '0', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1);

INSERT INTO mints (action_index, tick_id, amount, destination_id, memo_id, status_id) VALUES
(202, 1, '25.00000000', 211, NULL, 1);

INSERT INTO broadcasts (action_index, message, `value`, fee, memo_id, broadcast_action_index, status_id) VALUES
(203, 'E2E test broadcast', '42000.00', '0.001', NULL, NULL, 1);

-- ============================================================
-- 4. BIGTOKEN — BigInt serialization (E2E-14)
-- ============================================================

INSERT INTO tokens (id, tick_id, action_index, last_action_index, supply, max_supply, max_mint, decimals, description,
    lock_max_supply, lock_mint, lock_mint_supply, lock_max_mint, lock_description, lock_sleep, lock_callback,
    callback_block, callback_tick_id, callback_amount, allow_list, block_list, mint_address_max, mint_start_block, mint_stop_block,
    owner_id, coin_price, coin_floor) VALUES
(200, 200, 201, 201, '50000000000000000.00000000', '99999999999999999.00000000', NULL, 8, 'BigToken for E2E testing',
    0, 0, 0, 0, 0, 0, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 210, '0.00000001', '0');

INSERT INTO balances (id, address_id, tick_id, amount) VALUES
(200, 1, 200, '18014398509481984.00000000');

-- ============================================================
-- 5. SUMTOKEN — supply == sum(holder balances) (E2E-38)
-- ============================================================

INSERT INTO tokens (id, tick_id, action_index, last_action_index, supply, max_supply, max_mint, decimals, description,
    lock_max_supply, lock_mint, lock_mint_supply, lock_max_mint, lock_description, lock_sleep, lock_callback,
    callback_block, callback_tick_id, callback_amount, allow_list, block_list, mint_address_max, mint_start_block, mint_stop_block,
    owner_id, coin_price, coin_floor) VALUES
(201, 201, 201, 201, '3000.00000000', '10000.00000000', '100.00000000', 8, 'Sum verification token',
    0, 0, 0, 0, 0, 0, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 210, '0.00001000', '0');

INSERT INTO balances (id, address_id, tick_id, amount) VALUES
(201, 210, 201, '1000.00000000'),
(202, 211, 201, '1200.00000000'),
(203, 212, 201, '800.00000000');

-- ============================================================
-- 6. E2E address 210 — credits/debits consistency (E2E-37)
--    balance = 1500, credits = 2000, debits = 500
-- ============================================================

-- Transactions for credits/debits of addr 210
INSERT INTO transactions (tx_index, block_index, tx_hash_id, source_id) VALUES
(204, 202, 204, 210),
(205, 203, 205, 210),
(206, 204, 206, 1);

INSERT INTO actions (action_index, block_index, tx_index, tx_vout, action_id, action_format) VALUES
(204, 202, 204, 0, 1, 1),
(205, 203, 205, 0, 1, 1),
(206, 204, 206, 0, 1, 1);

-- addr 210 balance: 1500 XCHAIN
INSERT INTO balances (id, address_id, tick_id, amount) VALUES
(204, 210, 1, '1500.00000000');

-- Credits: 1200 + 800 = 2000
INSERT INTO credits (action_index, address_id, tick_id, amount) VALUES
(204, 210, 1, '1200.00000000'),
(206, 210, 1, '800.00000000');

-- Debits: 500
INSERT INTO debits (action_index, address_id, tick_id, amount) VALUES
(205, 210, 1, '500.00000000');

-- Sends for the credit/debit actions (needed for action queries)
INSERT INTO sends (action_index, tick_id, destination_id, amount, memo_id, status_id) VALUES
(204, 1, 210, '1200.00000000', NULL, 1),
(205, 1, 1, '500.00000000', NULL, 1),
(206, 1, 210, '800.00000000', NULL, 1);

-- Mappings for history queries
INSERT INTO mappings_actions (action_index, type_id, id) VALUES
(200, 2, 210), (200, 2, 211), (200, 1, 1),
(201, 1, 200),
(202, 2, 211), (202, 1, 1),
(203, 2, 210),
(204, 2, 210), (204, 1, 1),
(205, 2, 210), (205, 1, 1),
(206, 2, 210), (206, 2, 1), (206, 1, 1);

-- ============================================================
-- 7. Market history data (E2E-11)
--    Orders with non-null get_address_id, plus matches
-- ============================================================

-- Additional transactions/actions for market history orders
INSERT INTO transactions (tx_index, block_index, tx_hash_id, source_id) VALUES
(207, 202, 207, 1),
(208, 203, 208, 2);

INSERT INTO actions (action_index, block_index, tx_index, tx_vout, action_id, action_format) VALUES
(207, 202, 207, 0, 3, 1),  -- ORDER
(208, 203, 208, 0, 3, 1);  -- ORDER

-- Orders with get_address_id set (required for market history INNER JOIN)
INSERT INTO orders (action_index, give_coin_id, give_tick_id, give_amount, get_coin_id, get_tick_id, get_amount,
    get_address_id, expiration, allow_list, block_list, memo_id, status_id) VALUES
(207, NULL, 1, '300.00000000', NULL, 2, '600.00000000', 1, 300, NULL, NULL, NULL, 3),
(208, NULL, 2, '150.00000000', NULL, 1, '75.00000000', 2, 300, NULL, NULL, NULL, 3);

INSERT INTO order_statuses (action_index, order_action_index, status_id) VALUES
(207, 207, 3),
(208, 208, 3);

-- Order matches for market history — give_action_index and get_action_index must reference orders with get_address_id
INSERT INTO transactions (tx_index, block_index, tx_hash_id, source_id) VALUES
(209, 204, 209, 1);

INSERT INTO actions (action_index, block_index, tx_index, tx_vout, action_id, action_format) VALUES
(209, 204, 209, 0, 9, 1);  -- ORDER_MATCH

INSERT INTO order_matches (action_index, give_action_index, give_coin_id, give_tick_id, give_amount,
    get_action_index, get_coin_id, get_tick_id, get_amount, status_id) VALUES
(209, 207, 1, 1, '150.00000000', 208, 1, 2, '300.00000000', 1);
