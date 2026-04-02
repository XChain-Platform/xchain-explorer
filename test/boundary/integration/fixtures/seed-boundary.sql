-- XChain Explorer Boundary Test - Edge Case Seed Data
-- Extends baseline schema with boundary-condition records

-- Reference tables
INSERT INTO index_actions (id, action) VALUES
(1, 'SEND'), (2, 'ISSUE'), (3, 'ORDER'), (4, 'DESTROY'),
(5, 'DISPENSER'), (6, 'DISPENSE'), (7, 'MINT'), (8, 'BROADCAST');

INSERT INTO index_addresses (id, address) VALUES
(1, 'bc1qaddr1aaaaaaaaaaaaaaaaaaaaaaaaaaa'),
(2, 'bc1qaddr2bbbbbbbbbbbbbbbbbbbbbbbbbbb'),
(3, 'bc1qaddr3ccccccccccccccccccccccccccc'),
(4, 'bc1qaddr4ddddddddddddddddddddddddddd'),
(5, 'bc1qaddr5eeeeeeeeeeeeeeeeeeeeeeeeeee');

INSERT INTO index_tickers (id, tick) VALUES
(1, 'XCHAIN'),
(2, 'TOKENONE'),
(3, 'TOKENTWO'),
(4, 'ZEROSUPPLY'),
(5, 'MAXVAL'),
(6, 'TINYTOK');

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

-- Ledger hashes for blocks
INSERT INTO index_transactions (id, hash) VALUES
(21, 'ledger_hash_block_1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
(22, 'ledger_hash_block_2_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
(23, 'ledger_hash_block_3_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
(24, 'ledger_hash_block_4_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
(25, 'ledger_hash_block_5_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

INSERT INTO index_statuses (id, status) VALUES
(1, 'valid'), (2, 'invalid'), (3, 'open'), (4, 'filled'), (5, 'cancelled');

INSERT INTO index_coins (id, coin) VALUES
(1, 'BTC'), (2, 'LTC'), (3, 'DOGE');

INSERT INTO index_memos (id, memo) VALUES
(1, 'Test memo 1'), (2, 'Test memo 2');

INSERT INTO index_mime_types (id, type) VALUES
(1, 'image/png');

-- Blocks (5 blocks)
INSERT INTO blocks (id, block_index, block_time, ledger_hash_id, actions_hash_id) VALUES
(1, 1, 1700000000, 21, NULL),
(2, 2, 1700000600, 22, NULL),
(3, 3, 1700001200, 23, NULL),
(4, 4, 1700001800, 24, NULL),
(5, 5, 1700002400, 25, NULL);

-- Transactions (20 txs)
INSERT INTO transactions (tx_index, block_index, tx_hash_id, source_id) VALUES
(1, 1, 1, 1), (2, 1, 2, 2),
(3, 2, 3, 1), (4, 2, 4, 3),
(5, 3, 5, 2), (6, 3, 6, 1),
(7, 4, 7, 4), (8, 4, 8, 2),
(9, 5, 9, 1), (10, 5, 10, 3),
(11, 1, 11, 5), (12, 2, 12, 1),
(13, 3, 13, 2), (14, 3, 14, 4),
(15, 4, 15, 3), (16, 4, 16, 1),
(17, 5, 17, 5), (18, 5, 18, 2),
(19, 5, 19, 1), (20, 5, 20, 3);

-- Actions (20 actions)
INSERT INTO actions (action_index, block_index, tx_index, tx_vout, action_id, action_format) VALUES
(1, 1, 1, 0, 2, 1),
(2, 1, 2, 0, 2, 1),
(3, 2, 3, 0, 1, 1),
(4, 2, 4, 0, 1, 1),
(5, 3, 5, 0, 1, 1),
(6, 3, 6, 0, 1, 1),
(7, 4, 7, 0, 3, 1),
(8, 4, 8, 0, 3, 1),
(9, 5, 9, 0, 1, 1),
(10, 5, 10, 0, 1, 1),
(11, 1, 11, 0, 2, 1),
(12, 2, 12, 0, 2, 1),
(13, 3, 13, 0, 1, 1),
(14, 3, 14, 0, 1, 1),
(15, 4, 15, 0, 1, 1),
(16, 4, 16, 0, 1, 1),
(17, 5, 17, 0, 7, 1),
(18, 5, 18, 0, 7, 1),
(19, 5, 19, 0, 4, 1),
(20, 5, 20, 0, 8, 1);

-- Tokens: includes zero-supply and max-value edge cases
INSERT INTO tokens (id, tick_id, action_index, last_action_index, supply, max_supply, max_mint, decimals, description,
    lock_max_supply, lock_mint, lock_mint_supply, lock_max_mint, lock_description, lock_sleep, lock_callback,
    callback_block, callback_tick_id, callback_amount, allow_list, block_list, mint_address_max, mint_start_block, mint_stop_block,
    owner_id, coin_price, coin_floor) VALUES
(1, 1, 1, 18, '1000000.00000000', '21000000.00000000', '1000.00000000', 8, 'XChain gas token',
    0, 0, 0, 0, 0, 0, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1, '0.00010000', '0'),
(2, 2, 2, 17, '500000.00000000', '1000000.00000000', '500.00000000', 8, 'Test Token One',
    1, 0, 0, 0, 0, 0, 0, NULL, NULL, NULL, NULL, NULL, '100.00000000', NULL, NULL, 2, '0.00005000', '0'),
(3, 3, 11, 11, '250000.00000000', '500000.00000000', NULL, 8, 'Test Token Two',
    0, 0, 0, 0, 0, 0, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1, '0.00002000', '0'),
-- BOUNDARY: Token with zero supply
(4, 4, 12, 12, '0.00000000', '1000000.00000000', NULL, 8, 'Zero supply token',
    0, 0, 0, 0, 0, 0, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 3, '0.00000000', '0'),
-- BOUNDARY: Token with very large supply (near BigInt edge)
(5, 5, 11, 11, '9999999999999999.99999999', '9999999999999999.99999999', NULL, 8, 'Max value token',
    1, 1, 1, 1, 1, 0, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1, '99999.99999999', '0'),
-- BOUNDARY: Token with minimal decimals and tiny values
(6, 6, 12, 12, '0.00000001', '0.00000001', NULL, 8, 'Tiniest token',
    1, 1, 1, 1, 1, 0, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 2, '0.00000001', '0');

-- Balances: includes zero balance and max-value edge cases
INSERT INTO balances (id, address_id, tick_id, amount) VALUES
(1, 1, 1, '500000.00000000'),
(2, 1, 2, '100000.00000000'),
(3, 1, 3, '50000.00000000'),
(4, 2, 1, '200000.00000000'),
(5, 2, 2, '150000.00000000'),
(6, 3, 1, '100000.00000000'),
(7, 3, 3, '100000.00000000'),
-- BOUNDARY: Zero balance
(8, 4, 4, '0.00000000'),
-- BOUNDARY: Maximum value balance
(9, 1, 5, '9999999999999999.99999999'),
-- BOUNDARY: Smallest possible balance (1 satoshi equivalent)
(10, 2, 6, '0.00000001');

-- Sends (10 sends — enough for pagination boundary testing)
INSERT INTO sends (action_index, tick_id, destination_id, amount, memo_id, status_id) VALUES
(3, 1, 2, '1000.00000000', 1, 1),
(4, 2, 1, '500.00000000', NULL, 1),
(5, 1, 3, '2000.00000000', NULL, 1),
(6, 2, 4, '250.00000000', 2, 1),
(9, 1, 5, '100.00000000', NULL, 1),
(10, 3, 2, '750.00000000', NULL, 1),
(13, 2, 1, '300.00000000', 1, 2),
(14, 1, 4, '50.00000000', NULL, 1),
(15, 1, 2, '500.00000000', NULL, 1),
(16, 3, 5, '125.00000000', NULL, 1);

-- Issues (6 issues — including boundary tokens)
INSERT INTO issues (action_index, tick_id, max_supply, max_mint, decimals, description, mint_supply,
    transfer_id, transfer_supply_id, lock_max_supply, lock_mint, lock_mint_supply, lock_max_mint,
    lock_description, lock_sleep, lock_callback, callback_block, callback_tick_id, callback_amount,
    allow_list, block_list, mint_address_max, mint_start_block, mint_stop_block, memo_id, status_id) VALUES
(1, 1, '21000000.00000000', '1000.00000000', '8', 'XChain gas token', NULL,
    NULL, NULL, '0', '0', '0', '0', '0', '0', '0', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1),
(2, 2, '1000000.00000000', '500.00000000', '8', 'Test Token One', NULL,
    NULL, NULL, '1', '0', '0', '0', '0', '0', '0', NULL, NULL, NULL, NULL, NULL, '100.00000000', NULL, NULL, NULL, 1),
(11, 3, '500000.00000000', NULL, '8', 'Test Token Two', NULL,
    NULL, NULL, '0', '0', '0', '0', '0', '0', '0', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1),
(12, 4, '1000000.00000000', NULL, '8', 'Zero supply token', NULL,
    NULL, NULL, '0', '0', '0', '0', '0', '0', '0', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1);

-- Orders (4 orders)
INSERT INTO orders (action_index, give_coin_id, give_tick_id, give_amount, get_coin_id, get_tick_id, get_amount,
    get_address_id, expiration, allow_list, block_list, memo_id, status_id) VALUES
(7, NULL, 1, '100.00000000', NULL, 2, '200.00000000', NULL, 100, NULL, NULL, NULL, 3),
(8, NULL, 2, '50.00000000', NULL, 1, '25.00000000', NULL, 100, NULL, NULL, NULL, 3);

INSERT INTO order_statuses (action_index, order_action_index, status_id) VALUES
(7, 7, 3),
(8, 8, 3);

-- Credits (8 entries)
INSERT INTO credits (action_index, address_id, tick_id, amount) VALUES
(3, 2, 1, '1000.00000000'),
(4, 1, 2, '500.00000000'),
(5, 3, 1, '2000.00000000'),
(6, 4, 2, '250.00000000'),
(9, 5, 1, '100.00000000'),
(10, 2, 3, '750.00000000'),
(17, 2, 1, '50.00000000'),
(15, 2, 1, '500.00000000');

-- Debits (8 entries)
INSERT INTO debits (action_index, address_id, tick_id, amount) VALUES
(3, 1, 1, '1000.00000000'),
(4, 3, 2, '500.00000000'),
(5, 2, 1, '2000.00000000'),
(6, 1, 2, '250.00000000'),
(9, 1, 1, '100.00000000'),
(10, 3, 3, '750.00000000'),
(15, 1, 1, '500.00000000'),
(19, 3, 1, '1000.00000000');

-- Destroys
INSERT INTO destroys (action_index, tick_id, amount, memo_id, status_id) VALUES
(19, 1, '1000.00000000', NULL, 1);

-- Mints
INSERT INTO mints (action_index, tick_id, amount, destination_id, memo_id, status_id) VALUES
(17, 1, '50.00000000', 2, NULL, 1),
(18, 2, '100.00000000', 3, NULL, 1);

-- Broadcasts
INSERT INTO broadcasts (action_index, message, `value`, fee, memo_id, broadcast_action_index, status_id) VALUES
(20, 'BTC/USD price feed', '65000.00', '0.001', NULL, NULL, 1);

-- Markets (1 pair)
INSERT INTO markets (id, tick1_id, tick1_price, tick1_bid, tick1_ask,
    tick1_24hr_price, tick1_24hr_high, tick1_24hr_low, tick1_24hr_change, tick1_24hr_volume,
    tick2_id, tick2_price, tick2_bid, tick2_ask,
    tick2_24hr_price, tick2_24hr_high, tick2_24hr_low, tick2_24hr_change, tick2_24hr_volume,
    last_updated) VALUES
(1, 1, '2.00000000', '1.95000000', '2.05000000',
    '1.98000000', '2.10000000', '1.90000000', '1.50', '5000.00000000',
    2, '0.50000000', '0.48000000', '0.52000000',
    '0.49000000', '0.55000000', '0.45000000', '-1.50', '10000.00000000',
    1700005400);

-- Mappings for history queries
INSERT INTO mappings_actions (action_index, type_id, id) VALUES
(3, 2, 1), (3, 2, 2), (3, 1, 1),
(4, 2, 3), (4, 2, 1), (4, 1, 2),
(5, 2, 2), (5, 2, 3), (5, 1, 1),
(6, 2, 1), (6, 2, 4), (6, 1, 2),
(9, 2, 1), (9, 2, 5), (9, 1, 1),
(10, 2, 3), (10, 2, 2), (10, 1, 3),
(17, 2, 2), (17, 1, 1),
(15, 2, 1), (15, 2, 2), (15, 1, 1),
(19, 2, 3), (19, 1, 1);
