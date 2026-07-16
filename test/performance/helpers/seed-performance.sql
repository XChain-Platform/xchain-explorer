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

-- XChain Explorer Performance Test - Seed Data
-- Self-contained: truncates all data tables and inserts a large dataset
-- Designed to expose N+1 query patterns and test throughput under volume

SET FOREIGN_KEY_CHECKS=0;

TRUNCATE TABLE order_matches;
TRUNCATE TABLE order_statuses;
TRUNCATE TABLE order_cancels;
TRUNCATE TABLE order_edits;
TRUNCATE TABLE order_expires;
TRUNCATE TABLE swap_matches;
TRUNCATE TABLE swap_cancels;
TRUNCATE TABLE swap_edits;
TRUNCATE TABLE swap_expires;
TRUNCATE TABLE dispenser_cancels;
TRUNCATE TABLE dispenser_closes;
TRUNCATE TABLE dispenser_edits;
TRUNCATE TABLE dispenser_expires;
TRUNCATE TABLE dispenses;
TRUNCATE TABLE dispensers;
TRUNCATE TABLE sweeps;
TRUNCATE TABLE swaps;
TRUNCATE TABLE orders;
TRUNCATE TABLE sleeps;
TRUNCATE TABLE sends;
TRUNCATE TABLE mints;
TRUNCATE TABLE messages;
TRUNCATE TABLE lists;
TRUNCATE TABLE links;
TRUNCATE TABLE issues;
TRUNCATE TABLE files;
TRUNCATE TABLE fees;
TRUNCATE TABLE dividends;
TRUNCATE TABLE destroys;
TRUNCATE TABLE callbacks;
TRUNCATE TABLE broadcasts;
TRUNCATE TABLE batches;
TRUNCATE TABLE airdrops;
TRUNCATE TABLE addresses;
TRUNCATE TABLE credits;
TRUNCATE TABLE debits;
TRUNCATE TABLE escrows;
TRUNCATE TABLE tokens;
TRUNCATE TABLE balances;
TRUNCATE TABLE mappings_actions;
TRUNCATE TABLE actions;
TRUNCATE TABLE transactions;
TRUNCATE TABLE blocks;
TRUNCATE TABLE index_actions;
TRUNCATE TABLE index_addresses;
TRUNCATE TABLE index_coins;
TRUNCATE TABLE index_memos;
TRUNCATE TABLE index_statuses;
TRUNCATE TABLE index_tickers;
TRUNCATE TABLE index_transactions;

SET FOREIGN_KEY_CHECKS=1;

-- ============================================================
-- Reference / index tables
-- ============================================================

INSERT INTO index_actions (id, action) VALUES
(1, 'SEND'), (2, 'ISSUE'), (3, 'ORDER'), (4, 'DESTROY'),
(5, 'DISPENSER'), (6, 'DISPENSE'), (7, 'MINT'), (8, 'BROADCAST'),
(9, 'SWEEP'), (10, 'SLEEP');

INSERT INTO index_statuses (id, status) VALUES
(1, 'valid'), (2, 'invalid'), (3, 'open'), (4, 'filled'), (5, 'cancelled');

INSERT INTO index_coins (id, coin) VALUES
(1, 'BTC'), (2, 'LTC'), (3, 'DOGE');

INSERT INTO index_memos (id, memo) VALUES
(1, ''), (2, 'Test memo'), (3, 'Performance test');

-- 20 addresses
INSERT INTO index_addresses (id, address) VALUES
(1,  'bc1qperf_addr_001_aaaaaaaaaaaaaaaaaaaaa'),
(2,  'bc1qperf_addr_002_bbbbbbbbbbbbbbbbbbbbb'),
(3,  'bc1qperf_addr_003_ccccccccccccccccccccc'),
(4,  'bc1qperf_addr_004_ddddddddddddddddddddd'),
(5,  'bc1qperf_addr_005_eeeeeeeeeeeeeeeeeeeee'),
(6,  'bc1qperf_addr_006_fffffffffffffffffffff'),
(7,  'bc1qperf_addr_007_ggggggggggggggggggggg'),
(8,  'bc1qperf_addr_008_hhhhhhhhhhhhhhhhhhhhh'),
(9,  'bc1qperf_addr_009_iiiiiiiiiiiiiiiiiiiii'),
(10, 'bc1qperf_addr_010_jjjjjjjjjjjjjjjjjjjjj'),
(11, 'bc1qperf_addr_011_kkkkkkkkkkkkkkkkkkkkk'),
(12, 'bc1qperf_addr_012_lllllllllllllllllllll'),
(13, 'bc1qperf_addr_013_mmmmmmmmmmmmmmmmmmmmm'),
(14, 'bc1qperf_addr_014_nnnnnnnnnnnnnnnnnnnnn'),
(15, 'bc1qperf_addr_015_ooooooooooooooooooooo'),
(16, 'bc1qperf_addr_016_ppppppppppppppppppppp'),
(17, 'bc1qperf_addr_017_qqqqqqqqqqqqqqqqqqqqq'),
(18, 'bc1qperf_addr_018_rrrrrrrrrrrrrrrrrrrrr'),
(19, 'bc1qperf_addr_019_sssssssssssssssssssss'),
(20, 'bc1qperf_addr_020_ttttttttttttttttttttt');

-- 10 tokens
INSERT INTO index_tickers (id, tick) VALUES
(1, 'XCHAIN'), (2, 'PERFTOKEN'), (3, 'LOADTEST'), (4, 'STRESS'),
(5, 'BENCHMARK'), (6, 'VOLUME'), (7, 'SPEED'), (8, 'SCALE'),
(9, 'CAPACITY'), (10, 'MEASURE');

-- ============================================================
-- Generate blocks, transactions, actions via stored procedure
-- (MariaDB compatible procedural SQL)
-- ============================================================

-- 100 blocks
DELIMITER //
CREATE PROCEDURE seed_perf_data()
BEGIN
    DECLARE i INT DEFAULT 1;
    DECLARE tx_idx INT DEFAULT 1;
    DECLARE act_idx INT DEFAULT 1;
    DECLARE tx_hash_idx INT DEFAULT 1;

    -- Insert 200 transaction hashes
    WHILE tx_hash_idx <= 200 DO
        INSERT INTO index_transactions (id, hash) VALUES
            (tx_hash_idx, CONCAT('perf_tx_hash_', LPAD(tx_hash_idx, 4, '0'), '_', REPEAT('a', 48)));
        SET tx_hash_idx = tx_hash_idx + 1;
    END WHILE;

    -- Insert 100 blocks
    WHILE i <= 100 DO
        INSERT INTO blocks (id, block_index, block_time, ledger_hash_id, actions_hash_id)
            VALUES (i, i, 1700000000 + (i * 600), NULL, NULL);
        SET i = i + 1;
    END WHILE;

    -- Insert 200 transactions (2 per block)
    SET i = 1;
    WHILE i <= 100 DO
        INSERT INTO transactions (tx_index, block_index, tx_hash_id, source_id) VALUES
            (tx_idx, i, tx_idx, ((tx_idx - 1) MOD 20) + 1);
        SET tx_idx = tx_idx + 1;
        INSERT INTO transactions (tx_index, block_index, tx_hash_id, source_id) VALUES
            (tx_idx, i, tx_idx, ((tx_idx - 1) MOD 20) + 1);
        SET tx_idx = tx_idx + 1;
        SET i = i + 1;
    END WHILE;

    -- Insert 200 actions (one per transaction)
    -- Distribute action types: SEND(1), ISSUE(2), ORDER(3), BROADCAST(8)
    SET i = 1;
    WHILE i <= 200 DO
        INSERT INTO actions (action_index, block_index, tx_index, tx_vout, action_id, action_format) VALUES
            (i, ((i - 1) DIV 2) + 1, i, 0, CASE (i MOD 4) WHEN 0 THEN 1 WHEN 1 THEN 2 WHEN 2 THEN 3 ELSE 8 END, 1);
        SET i = i + 1;
    END WHILE;

    -- Insert 100 sends (action_ids where MOD 4 = 0, plus extras)
    SET i = 1;
    WHILE i <= 100 DO
        INSERT INTO sends (action_index, tick_id, destination_id, amount, memo_id, status_id) VALUES
            (i * 2, ((i - 1) MOD 10) + 1, ((i) MOD 20) + 1, CONCAT(i * 1000, '.00000000'), 1, 1);
        SET i = i + 1;
    END WHILE;

    -- Insert 10 tokens
    SET i = 1;
    WHILE i <= 10 DO
        INSERT INTO tokens (tick_id, max_supply, max_mint, decimals, description, lock_max_supply, lock_mint, lock_mint_supply, lock_max_mint, lock_description, lock_sleep, lock_callback, coin_price, action_index) VALUES
            (i, '21000000.00000000', '1000.00000000', 8, CONCAT('Performance test token ', i), 0, 0, 0, 0, 0, 0, 0, '0.00000000', i);
        SET i = i + 1;
    END WHILE;

    -- Insert 100 balances (10 addresses x 10 tokens)
    SET i = 1;
    WHILE i <= 10 DO
        BEGIN
            DECLARE j INT DEFAULT 1;
            WHILE j <= 10 DO
                INSERT INTO balances (address_id, tick_id, amount) VALUES
                    (i, j, CONCAT(((i * j) * 100), '.00000000'));
                SET j = j + 1;
            END WHILE;
        END;
        SET i = i + 1;
    END WHILE;

    -- Insert 50 issues
    SET i = 1;
    WHILE i <= 50 DO
        INSERT INTO issues (action_index, tick_id, max_supply, max_mint, decimals, description, mint_supply, allow_list, block_list, memo_id, status_id) VALUES
            (i + 100, ((i - 1) MOD 10) + 1, '21000000.00000000', '1000.00000000', 8, CONCAT('Issue ', i), '0.00000000', 0, 0, 1, 1);
        SET i = i + 1;
    END WHILE;

    -- Insert 20 orders (for orderbook testing)
    SET i = 1;
    WHILE i <= 20 DO
        INSERT INTO orders (action_index, give_coin_id, give_tick_id, give_amount, get_coin_id, get_tick_id, get_amount, get_address_id, expiration, allow_list, block_list, memo_id, status_id) VALUES
            (i + 150, 1, 1, CONCAT(i * 100, '.00000000'), 1, 2, CONCAT(i * 50, '.00000000'), ((i - 1) MOD 20) + 1, 0, 0, 0, 1, 1);
        -- Order status: make them all 'open'
        INSERT INTO order_statuses (action_index, order_action_index, status_id) VALUES
            (i + 150, i + 150, 3);
        SET i = i + 1;
    END WHILE;

    -- Insert 50 broadcasts
    SET i = 1;
    WHILE i <= 50 DO
        INSERT INTO broadcasts (action_index, message, memo_id, status_id) VALUES
            (i + 50, CONCAT('Broadcast message number ', i), 1, 1);
        SET i = i + 1;
    END WHILE;

    -- Insert mappings_actions for history queries
    SET i = 1;
    WHILE i <= 200 DO
        -- Map by address (type_id=2)
        INSERT INTO mappings_actions (action_index, type_id, id) VALUES
            (i, 2, ((i - 1) MOD 20) + 1);
        -- Map by token (type_id=1) for sends and issues
        IF (i MOD 2) = 0 THEN
            INSERT INTO mappings_actions (action_index, type_id, id) VALUES
                (i, 1, ((i - 1) MOD 10) + 1);
        END IF;
        SET i = i + 1;
    END WHILE;

END //
DELIMITER ;

CALL seed_perf_data();
DROP PROCEDURE IF EXISTS seed_perf_data;
