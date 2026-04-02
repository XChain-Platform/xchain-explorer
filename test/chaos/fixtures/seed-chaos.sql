-- Chaos Engineering seed data
-- Minimal dataset sufficient for API health checks and query correctness verification
-- Schema must match test/integration/fixtures/schema.sql

-- Reference tables
INSERT IGNORE INTO index_actions (id, action) VALUES
    (1, 'SEND'), (2, 'ISSUE'), (3, 'ORDER'), (4, 'DESTROY');

INSERT IGNORE INTO index_addresses (id, address) VALUES
    (1, 'bcrt1qchaosaddr1aaaaaaaaaaaaaaaaaaaaaa'),
    (2, 'bcrt1qchaosaddr2bbbbbbbbbbbbbbbbbbbbbb'),
    (3, 'bcrt1qchaosaddr3cccccccccccccccccccccc');

INSERT IGNORE INTO index_tickers (id, tick) VALUES
    (1, 'XCHAIN'), (2, 'CHAOSTEST'), (3, 'BTC');

INSERT IGNORE INTO index_transactions (id, hash) VALUES
    (1, 'chaos_tx_hash_001_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    (2, 'chaos_tx_hash_002_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
    (3, 'chaos_tx_hash_003_cccccccccccccccccccccccccccccccccccccccccc'),
    (4, 'chaos_ledger_hash_100_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    (5, 'chaos_ledger_hash_101_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    (6, 'chaos_ledger_hash_102_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    (7, 'chaos_ledger_hash_103_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    (8, 'chaos_ledger_hash_104_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

INSERT IGNORE INTO index_statuses (id, status) VALUES
    (1, 'valid'), (2, 'invalid');

INSERT IGNORE INTO index_coins (id, coin) VALUES
    (1, 'BTC');

-- Blocks (5 blocks)
INSERT IGNORE INTO blocks (id, block_index, block_time, ledger_hash_id, actions_hash_id) VALUES
    (1, 100, 1700000000, 4, NULL),
    (2, 101, 1700000060, 5, NULL),
    (3, 102, 1700000120, 6, NULL),
    (4, 103, 1700000180, 7, NULL),
    (5, 104, 1700000240, 8, NULL);

-- Transactions
INSERT IGNORE INTO transactions (tx_index, block_index, tx_hash_id, source_id) VALUES
    (1, 100, 1, 1),
    (2, 101, 2, 2),
    (3, 102, 3, 1);

-- Actions
INSERT IGNORE INTO actions (action_index, block_index, tx_index, tx_vout, action_id, action_format) VALUES
    (1, 100, 1, 0, 2, 0),
    (2, 101, 2, 0, 1, 0);

-- Sends
INSERT IGNORE INTO sends (action_index, tick_id, destination_id, amount, memo_id, status_id) VALUES
    (2, 2, 2, '50000000', NULL, 1);

-- Balances
INSERT IGNORE INTO balances (id, address_id, tick_id, amount) VALUES
    (1, 1, 2, '50000000'),
    (2, 2, 2, '50000000'),
    (3, 1, 1, '1000000000');
