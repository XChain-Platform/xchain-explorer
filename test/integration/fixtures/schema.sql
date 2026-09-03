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

-- XChain Explorer Integration Test Schema
-- Auto-generated from xchain-indexer/src/sql/*.sql

-- ============================================================
-- 1. Reference / index tables
-- ============================================================

DROP TABLE IF EXISTS index_actions;
CREATE TABLE index_actions (
    id     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    action VARCHAR(250) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE INDEX action on index_actions (action);

DROP TABLE IF EXISTS index_addresses;
CREATE TABLE index_addresses (
    id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    address     VARCHAR(120) NOT NULL,
    block_index BIGINT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX address on index_addresses (address(62));

DROP TABLE IF EXISTS index_coins;
CREATE TABLE index_coins (
    id   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    coin VARCHAR(250) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX coin on index_coins (coin);

DROP TABLE IF EXISTS index_fiats;
CREATE TABLE index_fiats (
    id   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    code VARCHAR(250) NOT NULL,
    name VARCHAR(250)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX code on index_fiats (code);

INSERT INTO index_fiats values (1,  'USD', 'US Dollar');
INSERT INTO index_fiats values (2,  'CAD', 'Canadian Dollar');
INSERT INTO index_fiats values (3,  'AUD', 'Austrailian Dollar');
INSERT INTO index_fiats values (4,  'MXN', 'Mexican Peso');
INSERT INTO index_fiats values (5,  'GBP', 'Great Britian Pound');
INSERT INTO index_fiats values (6,  'JPY', 'Japanese Yen');
INSERT INTO index_fiats values (7,  'CNY', 'Chinese Yuan');
INSERT INTO index_fiats values (8,  'CHF', 'Swiss Franc');
INSERT INTO index_fiats values (9,  'BRL', 'Brazillian Real');
INSERT INTO index_fiats values (10, 'INR', 'Indian Rupee');

DROP TABLE IF EXISTS index_memos;
CREATE TABLE index_memos (
    id     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    memo   VARCHAR(250) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX memo on index_memos (memo);

DROP TABLE IF EXISTS index_mime_types;
CREATE TABLE index_mime_types (
    id   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    type VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX type on index_mime_types (type);

DROP TABLE IF EXISTS index_statuses;
CREATE TABLE index_statuses (
    id     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    status VARCHAR(250) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX status on index_statuses (status);

DROP TABLE IF EXISTS index_tickers;
CREATE TABLE index_tickers (
    id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tick        TEXT NOT NULL,
    block_index BIGINT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE UNIQUE INDEX tick on index_tickers (tick(200));

DROP TABLE IF EXISTS index_transactions;
CREATE TABLE index_transactions (
    id   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    hash VARCHAR(250) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX hash on index_transactions (hash(64));

-- ============================================================
-- 2. Core tables
-- ============================================================

DROP TABLE IF EXISTS blocks;
CREATE TABLE blocks (
    id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    block_index      BIGINT UNSIGNED,
    block_time       BIGINT UNSIGNED,
    ledger_hash_id   BIGINT UNSIGNED,  -- id of record in index_transactions table (sha256 hash of credits/debits/escrow/balances data)
    actions_hash_id  BIGINT UNSIGNED,  -- id of record in index_transactions table (sha256 hash of actions data)
    contract_hash_id BIGINT UNSIGNED,  -- id of record in index_transactions table (sha256 hash of VM contract-state data)
    state_hash_id    BIGINT UNSIGNED   -- id of record in index_transactions table (sha256 of in-place mutations + backdated credits; replication-integrity only, see stateHash.js)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE INDEX block_index      ON blocks (block_index);
CREATE INDEX ledger_hash_id   ON blocks (ledger_hash_id);
CREATE INDEX actions_hash_id  ON blocks (actions_hash_id);
CREATE INDEX contract_hash_id ON blocks (contract_hash_id);
CREATE INDEX state_hash_id    ON blocks (state_hash_id);

-- Table used to track individual transactions

DROP TABLE IF EXISTS transactions;
CREATE TABLE transactions (
  tx_index    BIGINT UNSIGNED NOT NULL,
  block_index BIGINT UNSIGNED NOT NULL,
  tx_hash_id  BIGINT UNSIGNED NOT NULL, -- id of record in index_transactions table
  source_id   BIGINT UNSIGNED,          -- id of record in the index_addresses
  fee         BIGINT,                   -- miners fee in satoshis (copied from decoder)
  data        MEDIUMTEXT                -- decoded action string (copied from decoder)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX tx_index    on transactions (tx_index);
CREATE        INDEX block_index on transactions (block_index);
CREATE        INDEX tx_hash_id  on transactions (tx_hash_id);
CREATE        INDEX source_id   on transactions (source_id);

-- Table used to track individual actions within a transaction

DROP TABLE IF EXISTS actions;
CREATE TABLE actions (
  action_index  BIGINT UNSIGNED NOT NULL, -- Unique index for every action
  block_index   BIGINT UNSIGNED NOT NULL, -- block_index from the blocks table
  tx_index      BIGINT UNSIGNED,          -- tx_index from the transactions table
  tx_vout       BIGINT UNSIGNED,          -- transaction output index
  action_id     BIGINT UNSIGNED NOT NULL, -- id of record in index_actions table
  action_format TINYINT UNSIGNED,         -- FORMAT of action data (0-255)
  source_id     BIGINT UNSIGNED           -- id of record in index_addresses: the action's TRUE source (NULL for system/synthetic actions)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index    on actions (action_index);
CREATE        INDEX block_index     on actions (block_index);
CREATE        INDEX tx_index        on actions (tx_index);
CREATE        INDEX action_id       on actions (action_id);
CREATE        INDEX action_format   on actions (action_format);
CREATE        INDEX source_id       on actions (source_id);

-- ============================================================
-- 3. Data tables
-- ============================================================

DROP TABLE IF EXISTS tokens;
CREATE TABLE tokens (
    id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tick_id            BIGINT UNSIGNED,                      -- id of record in index_ticks table
    action_index       BIGINT UNSIGNED,                      -- action_index of first ISSUE transaction (used in rollbacks)
    last_action_index  BIGINT UNSIGNED,                      -- action index of last  ISSUE transaction
    supply             VARCHAR(250),                         -- Current supply
    max_supply         VARCHAR(250),                         -- Maximum Supply
    max_mint           VARCHAR(250),                         -- Supply minted
    decimals           TINYINT(2),                           -- 0=non-divisible, 1-18=divisible
    description        VARCHAR(250),                         -- URL to icon
    lock_max_supply    TINYINT(1) NOT NULL DEFAULT 0,        -- Locks MAX_SUPPLY
    lock_mint          TINYINT(1) NOT NULL DEFAULT 0,        -- Locks MINT
    lock_mint_supply   TINYINT(1) NOT NULL DEFAULT 0,        -- Locks MINT_SUPPLY
    lock_max_mint      TINYINT(1) NOT NULL DEFAULT 0,        -- Locks MAX_MINT
    lock_description   TINYINT(1) NOT NULL DEFAULT 0,        -- Locks DESCRIPTION
    lock_sleep         TINYINT(1) NOT NULL DEFAULT 0,        -- Locks SLEEP
    lock_callback      TINYINT(1) NOT NULL DEFAULT 0,        -- Locks CALLBACK_BLOCK/TICK/AMOUNT
    callback_block     BIGINT UNSIGNED,                     -- block_index after which CALLBACK cand be used
    callback_tick_id   BIGINT UNSIGNED,                     -- id of record in index_tickers table
    callback_amount    VARCHAR(250),                         -- AMOUNT users get if CALLBACK
    allow_list         BIGINT UNSIGNED,                     -- action_index of list in lists table
    block_list         BIGINT UNSIGNED,                     -- action_index of list in lists table
    mint_address_max   VARCHAR(250),                         -- Maximum amount of supply an address can MINT
    mint_start_block   BIGINT UNSIGNED,                     -- block_index when MINT transactions are allowed (begin mint)
    mint_stop_block    BIGINT UNSIGNED,                     -- BLOCK_INDEX when MINT transactions are NOT allowed (end mint)
    owner_id           BIGINT UNSIGNED,                     -- id of record in index_addresses table
    coin_price         VARCHAR(250) NOT NULL default 0,     -- last  price of 1 token in native coin (BTC, LTC, DOGE, etc)
    coin_floor         VARCHAR(250) NOT NULL default 0,     -- floor price of 1 token in native coin (BTC, LTC, DOGE, etc)
    escrow_action_index BIGINT UNSIGNED DEFAULT NULL        -- action_index of ORDER/SWAP/DISPENSER holding ownership in escrow (NULL = ownership not escrowed)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE        INDEX tick_id          ON tokens (tick_id);
CREATE        INDEX owner_id         ON tokens (owner_id);
CREATE        INDEX lock_max_supply  ON tokens (lock_max_supply);
CREATE        INDEX escrow_action_index ON tokens (escrow_action_index);
CREATE        INDEX lock_mint        ON tokens (lock_mint);
CREATE        INDEX lock_max_mint    ON tokens (lock_max_mint);
CREATE        INDEX lock_mint_supply ON tokens (lock_mint_supply);
CREATE        INDEX lock_description ON tokens (lock_description);
CREATE        INDEX lock_sleep       ON tokens (lock_sleep);
CREATE        INDEX lock_callback    ON tokens (lock_callback);
CREATE        INDEX callback_tick_id ON tokens (callback_tick_id);
CREATE        INDEX allow_list       ON tokens (allow_list);
CREATE        INDEX block_list       ON tokens (block_list);

DROP TABLE IF EXISTS balances;
CREATE TABLE balances (
    id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    address_id BIGINT UNSIGNED, -- id of record in index_addresses
    tick_id    BIGINT UNSIGNED, -- id of record in index_tickers
    amount     VARCHAR(250)      -- AMOUNT of balance
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE INDEX address_id ON balances (address_id);
CREATE INDEX tick_id    ON balances (tick_id);

DROP TABLE IF EXISTS credits;
CREATE TABLE credits (
    action_index BIGINT UNSIGNED NOT NULL, -- Unique action index
    address_id   BIGINT UNSIGNED,          -- id of record in index_addresses table
    tick_id      BIGINT UNSIGNED,          -- id of record in index_tickers table
    amount       VARCHAR(250)               -- AMOUNT of credit
) ENGINE=InnoDB DEFAULT  CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE INDEX action_index ON credits (action_index);
CREATE INDEX address_id   ON credits (address_id);
CREATE INDEX tick_id      ON credits (tick_id);

DROP TABLE IF EXISTS debits;
CREATE TABLE debits (
    action_index BIGINT UNSIGNED NOT NULL, -- Unique action index
    address_id   BIGINT UNSIGNED,          -- id of record in index_addresses table
    tick_id      BIGINT UNSIGNED,          -- id of record in index_tickers table
    amount       VARCHAR(250)               -- AMOUNT of debit
) ENGINE=InnoDB DEFAULT  CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE INDEX action_index ON debits (action_index);
CREATE INDEX address_id   ON debits (address_id);
CREATE INDEX tick_id      ON debits (tick_id);

DROP TABLE IF EXISTS escrows;
CREATE TABLE escrows (
    action_index BIGINT UNSIGNED NOT NULL, -- Unique action index
    address_id   BIGINT UNSIGNED,          -- id of record in index_addresses table
    tick_id      BIGINT UNSIGNED,          -- id of record in index_tickers table
    amount       VARCHAR(250)               -- AMOUNT of credit
) ENGINE=InnoDB DEFAULT  CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE INDEX action_index ON escrows (action_index);
CREATE INDEX address_id   ON escrows (address_id);
CREATE INDEX tick_id      ON escrows (tick_id);

-- ============================================================
-- 4. Action tables
-- ============================================================

DROP TABLE IF EXISTS addresses;
CREATE TABLE IF NOT EXISTS addresses (
    action_index   BIGINT UNSIGNED NOT NULL, -- Unique action index
    fee_preference BIGINT UNSIGNED,
    require_memo   BIGINT UNSIGNED,
    dispenser_preference BIGINT UNSIGNED,     -- 1=owner only, 2=anyone may open a dispenser
    memo_id        BIGINT UNSIGNED,          -- id of record in index_memos table
    status_id      BIGINT UNSIGNED           -- id of record in index_statuses table
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index   ON addresses (action_index);
CREATE        INDEX memo_id        ON addresses (memo_id);
CREATE        INDEX status_id      ON addresses (status_id);

DROP TABLE IF EXISTS airdrops;
CREATE TABLE airdrops (
    action_index      BIGINT UNSIGNED NOT NULL, -- Unique action index
    tick_id           BIGINT UNSIGNED,          -- id of record in index_ticks
    list_action_index BIGINT UNSIGNED,          -- list action_index
    amount            VARCHAR(250),              -- Amount of token in airdrop
    memo_id           BIGINT UNSIGNED,          -- id of record in index_memos table
    status_id         BIGINT UNSIGNED           -- id of record in index_statuses table
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE        INDEX action_index      ON airdrops (action_index);
CREATE        INDEX tick_id           ON airdrops (tick_id);
CREATE        INDEX list_action_index ON airdrops (list_action_index);
CREATE        INDEX memo_id           ON airdrops (memo_id);
CREATE        INDEX status_id         ON airdrops (status_id);

DROP TABLE IF EXISTS batches;
CREATE TABLE batches (
    action_index BIGINT UNSIGNED NOT NULL, -- Unique action index
    status_id    BIGINT UNSIGNED           -- id of record in index_statuses table
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index   ON batches (action_index);
CREATE        INDEX status_id      ON batches (status_id);

DROP TABLE IF EXISTS broadcasts;
CREATE TABLE broadcasts (
    action_index           BIGINT UNSIGNED NOT NULL, -- Unique action index
    message                VARCHAR(250),             -- Message, oracle info, or feed info
    `value`                VARCHAR(25),              -- Numerical value of the broadcast
    fee                    VARCHAR(11),              -- Oracle / Feed usage  fee
    memo_id                BIGINT UNSIGNED,          -- id of record in index_memos table
    broadcast_action_index BIGINT UNSIGNED,          -- broadcast action_index
    status_id              BIGINT UNSIGNED           -- id of record in index_statuses table

) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index           ON broadcasts (action_index);
CREATE        INDEX broadcast_action_index ON broadcasts (broadcast_action_index);
CREATE        INDEX memo_id                ON broadcasts (memo_id);
CREATE        INDEX status_id              ON broadcasts (status_id);

DROP TABLE IF EXISTS callbacks;
CREATE TABLE callbacks (
    action_index     BIGINT UNSIGNED NOT NULL, -- Unique action index
    tick_id          BIGINT UNSIGNED,          -- id of record in index_tickers
    callback_tick_id BIGINT UNSIGNED,          -- id of record in index_tickers
    callback_amount  VARCHAR(250),              -- Amount of token per unit
    memo_id          BIGINT UNSIGNED,          -- id of record in index_memos table
    status_id        BIGINT UNSIGNED           -- id of record in index_statuses table
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index     ON callbacks (action_index);
CREATE        INDEX tick_id          ON callbacks (tick_id);
CREATE        INDEX callback_tick_id ON callbacks (callback_tick_id);
CREATE        INDEX memo_id          ON callbacks (memo_id);
CREATE        INDEX status_id        ON callbacks (status_id);

DROP TABLE IF EXISTS destroys;
CREATE TABLE destroys (
    action_index BIGINT UNSIGNED NOT NULL, -- Unique action index
    tick_id      BIGINT UNSIGNED,          -- id of record in index_ticks table
    amount       VARCHAR(250),              -- Amount of token to destroy
    memo_id      BIGINT UNSIGNED,          -- id of record in index_memos table
    status_id    BIGINT UNSIGNED           -- id of record in index_statuses table
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index   ON destroys (action_index);
CREATE        INDEX tick_id        ON destroys (tick_id);
CREATE        INDEX memo_id        ON destroys (memo_id);
CREATE        INDEX status_id      ON destroys (status_id);

DROP TABLE IF EXISTS dispensers;
CREATE TABLE dispensers (
    action_index       BIGINT UNSIGNED NOT NULL, -- Unique action index
    give_coin_id       BIGINT UNSIGNED,          -- id of record in index_coins table
    give_tick_id       BIGINT UNSIGNED,          -- id of record in index_tickers table
    give_amount        VARCHAR(250),             -- Amount of GIVE_TICK to dispense when triggered
    give_escrow        VARCHAR(250),             -- Amount of GIVE_TICK to escrow in dispenser
    give_ownership     TINYINT(1) NOT NULL DEFAULT 0, -- 1 = dispenser sells GIVE_TICK ownership (single-shot, GIVE_AMOUNT / GIVE_ESCROW must be empty)
    get_coin_id        BIGINT UNSIGNED,          -- id of record in index_coins table
    get_tick_id        BIGINT UNSIGNED,          -- id of record in index_tickers table
    get_amount         VARCHAR(250),             -- Amount required to trigger dispenser
    get_address_id     BIGINT UNSIGNED,          -- id of record in index_addresses table (dispenser address)
    fiat_id            BIGINT UNSIGNED,          -- id of record in index_fiats table
    fiat_amount        VARCHAR(250),             -- amount of FIAT required to trigger a dispense (ignored when oracle_address_id is set)
    oracle_address_id  BIGINT UNSIGNED,          -- id of record in index_addresses (user oracle SOURCE address - PRICE v1)
    expiration         BIGINT UNSIGNED,          -- unix timestamp of dispenser expiration date/time
    allow_list         BIGINT UNSIGNED,          -- action_index of a list from the lists table
    block_list         BIGINT UNSIGNED,          -- action_index of a list from the lists table
    memo_id            BIGINT UNSIGNED,          -- id of record in index_memos table
    status_id          BIGINT UNSIGNED           -- id of record in index_statuses table (status of open dispenser tx)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;


CREATE UNIQUE INDEX action_index   ON dispensers (action_index);
CREATE        INDEX give_coin_id   ON dispensers (give_coin_id);
CREATE        INDEX give_tick_id   ON dispensers (give_tick_id);
CREATE        INDEX get_coin_id    ON dispensers (get_coin_id);
CREATE        INDEX get_tick_id    ON dispensers (get_tick_id);
CREATE        INDEX get_address_id ON dispensers (get_address_id);
CREATE        INDEX fiat_id           ON dispensers (fiat_id);
CREATE        INDEX oracle_address_id ON dispensers (oracle_address_id);
CREATE        INDEX allow_list     ON dispensers (allow_list);
CREATE        INDEX block_list     ON dispensers (block_list);
CREATE        INDEX memo_id        ON dispensers (memo_id);
CREATE        INDEX status_id      ON dispensers (status_id);
CREATE        INDEX give_ownership ON dispensers (give_ownership);

DROP TABLE IF EXISTS dispenses;
CREATE TABLE dispenses (
    action_index             BIGINT UNSIGNED NOT NULL, -- Unique action index
    dispenser_action_index   BIGINT UNSIGNED,          -- action_index of dispenser
    give_coin_id             BIGINT UNSIGNED,          -- id of record in index_coins table
    give_tick_id             BIGINT UNSIGNED,          -- id of record in index_tickers table
    give_amount              VARCHAR(250),             -- Amount dispensed (GIVE_TICK)
    get_coin_id              BIGINT UNSIGNED,          -- id of record in index_coins table
    get_tick_id              BIGINT UNSIGNED,          -- id of record in index_tickers table
    get_amount               VARCHAR(250),             -- Amount paid (GET_COIN or GET_TICK)
    destination_id           BIGINT UNSIGNED,          -- id of record in index_addresses table
    status_id                BIGINT UNSIGNED           -- id of record in index_statuses table
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index           ON dispenses (action_index);
CREATE        INDEX dispenser_action_index ON dispenses (dispenser_action_index);
CREATE        INDEX destination_id         ON dispenses (destination_id);
CREATE        INDEX get_coin_id            ON dispenses (get_coin_id);
CREATE        INDEX get_tick_id            ON dispenses (get_tick_id);
CREATE        INDEX give_coin_id           ON dispenses (give_coin_id);
CREATE        INDEX give_tick_id           ON dispenses (give_tick_id);
CREATE        INDEX status_id              ON dispenses (status_id);

DROP TABLE IF EXISTS dispenser_cancels;
CREATE TABLE dispenser_cancels (
    action_index           BIGINT UNSIGNED NOT NULL, -- Unique action index
    dispenser_action_index BIGINT UNSIGNED NOT NULL, -- Unique action index from dispensers table
    memo_id                BIGINT UNSIGNED,          -- id of record in index_memos table
    status_id              BIGINT UNSIGNED           -- id of record in index_statuses table (valid / invalid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index           ON dispenser_cancels (action_index);
CREATE        INDEX dispenser_action_index ON dispenser_cancels (dispenser_action_index);
CREATE        INDEX memo_id                ON dispenser_cancels (memo_id);
CREATE        INDEX status_id              ON dispenser_cancels (status_id);

DROP TABLE IF EXISTS dispenser_closes;
CREATE TABLE dispenser_closes (
    action_index           BIGINT UNSIGNED NOT NULL, -- Unique action index
    dispenser_action_index BIGINT UNSIGNED NOT NULL, -- Unique action index from dispensers table
    status_id              BIGINT UNSIGNED           -- id of record in index_statuses table (valid / invalid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index           ON dispenser_closes (action_index);
CREATE        INDEX dispenser_action_index ON dispenser_closes (dispenser_action_index);
CREATE        INDEX status_id              ON dispenser_closes (status_id);

DROP TABLE IF EXISTS dispenser_edits;
CREATE TABLE dispenser_edits (
    action_index       BIGINT UNSIGNED NOT NULL,     -- Unique action index
    dispenser_action_index BIGINT UNSIGNED NOT NULL, -- Unique action index from dispensers table
    give_escrow        VARCHAR(250),                 -- Amount of GIVE_TICK to add to escrow
    expiration         BIGINT UNSIGNED,              -- unix timestamp of dispenser expiration date/time
    allow_list         BIGINT UNSIGNED,              -- action_index of a list from the lists table
    block_list         BIGINT UNSIGNED,              -- action_index of a list from the lists table
    memo_id            BIGINT UNSIGNED,              -- id of record in index_memos table
    status_id          BIGINT UNSIGNED               -- id of record in index_statuses table (valid / invalid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index           ON dispenser_edits (action_index);
CREATE        INDEX dispenser_action_index ON dispenser_edits (dispenser_action_index);
CREATE        INDEX allow_list             ON dispenser_edits (allow_list);
CREATE        INDEX block_list             ON dispenser_edits (block_list);
CREATE        INDEX memo_id                ON dispenser_edits (memo_id);
CREATE        INDEX status_id              ON dispenser_edits (status_id);

DROP TABLE IF EXISTS dispenser_expires;
CREATE TABLE dispenser_expires (
    action_index           BIGINT UNSIGNED NOT NULL, -- Unique action index
    dispenser_action_index BIGINT UNSIGNED NOT NULL, -- Unique action index from dispensers table
    status_id              BIGINT UNSIGNED           -- id of record in index_statuses table (valid / invalid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index           ON dispenser_expires (action_index);
CREATE        INDEX dispenser_action_index ON dispenser_expires (dispenser_action_index);
CREATE        INDEX status_id              ON dispenser_expires (status_id);

DROP TABLE IF EXISTS dispenser_statuses;
CREATE TABLE dispenser_statuses (
    action_index           BIGINT UNSIGNED NOT NULL, -- Unique action index
    dispenser_action_index BIGINT UNSIGNED NOT NULL, -- Unique action index from dispensers table
    cancelled_by_id        BIGINT UNSIGNED,          -- id of record in index_addresses table (address that triggered the cancel - NULL for non-cancel statuses or auto-expire)
    status_id              BIGINT UNSIGNED           -- id of record in index_statuses table (status of order tx open/invalid/complete/cancelled/expired)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE        INDEX action_index           ON dispenser_statuses (action_index);
CREATE        INDEX dispenser_action_index ON dispenser_statuses (dispenser_action_index);
CREATE        INDEX cancelled_by_id        ON dispenser_statuses (cancelled_by_id);
CREATE        INDEX status_id              ON dispenser_statuses (status_id);

DROP TABLE IF EXISTS dividends;
CREATE TABLE dividends (
    action_index     BIGINT UNSIGNED NOT NULL, -- Unique action index
    tick_id          BIGINT UNSIGNED,          -- id of record in index_ticks
    dividend_tick_id BIGINT UNSIGNED,          -- id of record in index_ticks
    amount           VARCHAR(250),              -- Amount of token per unit
    memo_id          BIGINT UNSIGNED,          -- id of record in index_memos table
    status_id        BIGINT UNSIGNED           -- id of record in index_statuses table
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index     ON dividends (action_index);
CREATE        INDEX tick_id          ON dividends (tick_id);
CREATE        INDEX dividend_tick_id ON dividends (dividend_tick_id);
CREATE        INDEX memo_id          ON dividends (memo_id);
CREATE        INDEX status_id        ON dividends (status_id);

DROP TABLE IF EXISTS fees;
CREATE TABLE fees (
    action_index        BIGINT UNSIGNED NOT NULL,
    tick_id             BIGINT UNSIGNED,                    -- FK to index_tickers (kept for future flexibility)
    amount              VARCHAR(250),                       -- Legacy: amount of TICK
    method              BIGINT UNSIGNED NOT NULL,           -- Legacy: FEE Payment Method (1=Destroy, 2=Donate)
    destination_id      BIGINT UNSIGNED,                    -- FK to index_addresses
    gas_cost            BIGINT UNSIGNED DEFAULT 0,          -- raw gas units (unified)
    gas_price           VARCHAR(250) DEFAULT '0',           -- GAS_PRICE at time of action (unified)
    xchain_amount       VARCHAR(250) DEFAULT '0',           -- gas * GAS_PRICE (unified)
    payment_mode        TINYINT UNSIGNED NOT NULL DEFAULT 2,-- 1=native_coin, 2=xchain_balance
    native_coin_amount  VARCHAR(250),                       -- null for XCHAIN balance payments (Track B)
    native_coin         VARCHAR(10),                        -- 'BTC', 'LTC', 'DOGE', or null (Track B)
    oracle_round        BIGINT UNSIGNED,                    -- price_snapshot round used, or null (Track B)
    fee_preference      TINYINT UNSIGNED NOT NULL DEFAULT 2,-- 1=burn, 2=protocol, 3=community, 4=buyback
    status_id           BIGINT UNSIGNED,
    fee_version         TINYINT UNSIGNED NOT NULL DEFAULT 1 -- 1=legacy, 2=unified gas
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index   ON fees (action_index);
CREATE        INDEX tick_id        ON fees (tick_id);
CREATE        INDEX destination_id ON fees (destination_id);

DROP TABLE IF EXISTS files;
CREATE TABLE files (
    action_index        BIGINT UNSIGNED NOT NULL, -- Unique action index
    name                VARCHAR(250),             -- File Name (filename.ext)
    title               VARCHAR(250),             -- File Title (My Spreadsheet)
    type_id             BIGINT UNSIGNED,          -- id of record in index_mime_types table
    memo_id             BIGINT UNSIGNED,          -- id of record in index_memos table
    status_id           BIGINT UNSIGNED           -- id of record in index_statuses table
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index ON files (action_index);
CREATE        INDEX type_id      ON files (type_id);
CREATE        INDEX memo_id      ON files (memo_id);
CREATE        INDEX status_id    ON files (status_id);

DROP TABLE IF EXISTS issues;
CREATE TABLE issues (
    action_index        BIGINT UNSIGNED NOT NULL, -- Unique action index
    tick_id             BIGINT UNSIGNED,          -- id of record in index_tickers table
    max_supply          VARCHAR(250),             -- Maximum token supply (1000000000000000000000.000000000000000000 = 40 Characters)
    max_mint            VARCHAR(250),             -- Maximum amount of supply a MINT transaction can issue
    decimals            VARCHAR(2),               -- Number of decimal places token should have (max: 18, default: 0)
    description         VARCHAR(250),             -- URL to a an icon to use for this token (48x48 standard size)
    mint_supply         VARCHAR(250),             -- Maximum amount of supply a MINT transaction can issue
    transfer_id         BIGINT UNSIGNED,          -- id of record in index_addresses table
    transfer_supply_id  BIGINT UNSIGNED,          -- id of record in index_addresses table
    lock_max_supply     VARCHAR(1),               -- Locks MAX_SUPPLY
    lock_mint           VARCHAR(1),               -- Locks MINT
    lock_mint_supply    VARCHAR(1),               -- Locks MINT_SUPPLY
    lock_max_mint       VARCHAR(1),               -- Locks MAX_MINT
    lock_description    VARCHAR(1),               -- Locks DESCRIPTION
    lock_sleep          VARCHAR(1),               -- Locks SLEEP
    lock_callback       VARCHAR(1),               -- Locks CALLBACK_BLOCK/TICK/AMOUNT
    callback_block      VARCHAR(15),              -- block_index after which CALLBACK cand be used
    callback_tick_id    BIGINT UNSIGNED,          -- id of record in index_tickers table
    callback_amount     VARCHAR(250),             -- AMOUNT users get if CALLBACK
    allow_list          BIGINT UNSIGNED,          -- action_index of a list from the lists table
    block_list          BIGINT UNSIGNED,          -- action_index of a list from the lists table
    mint_address_max    VARCHAR(250),             -- Maximum amount of supply an address can MINT
    mint_start_block    VARCHAR(15),              -- block_index when MINT transactions are allowed (begin mint)
    mint_stop_block     VARCHAR(15),              -- BLOCK_INDEX when MINT transactions are NOT allowed (end mint)
    memo_id             BIGINT UNSIGNED,          -- id of record in index_memos table
    status_id           BIGINT UNSIGNED           -- id of record in index_statuses table
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index       ON issues (action_index);
CREATE        INDEX tick_id            ON issues (tick_id);
CREATE        INDEX transfer_id        ON issues (transfer_id);
CREATE        INDEX transfer_supply_id ON issues (transfer_supply_id);
CREATE        INDEX status_id          ON issues (status_id);
CREATE        INDEX callback_tick_id   ON issues (callback_tick_id);
CREATE        INDEX allow_list         ON issues (allow_list);
CREATE        INDEX block_list         ON issues (block_list);
CREATE        INDEX memo_id            ON issues (memo_id);

DROP TABLE IF EXISTS links;
CREATE TABLE links (
    action_index        BIGINT UNSIGNED NOT NULL, -- Unique action index
    coin1_id            BIGINT UNSIGNED,          -- id of record in index_coins table
    coin1_action_index  BIGINT UNSIGNED,          -- action_index on coin1 network
    coin2_id            BIGINT UNSIGNED,          -- id of record in index_coins table
    coin2_action_index  BIGINT UNSIGNED,          -- action_index on coin2 network
    memo_id             BIGINT UNSIGNED,          -- id of record in index_memos table
    status_id           BIGINT UNSIGNED           -- id of record in index_statuses table
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index       ON links (action_index);
CREATE        INDEX coin1_id           ON links (coin1_id);
CREATE        INDEX coin1_action_index ON links (coin1_action_index);
CREATE        INDEX coin2_id           ON links (coin2_id);
CREATE        INDEX coin2_action_index ON links (coin2_action_index);
CREATE        INDEX memo_id            ON links (memo_id);
CREATE        INDEX status_id          ON links (status_id);

-- TODO : Convert type and edit fields to INTEGER UNSIGNED and force value to 0-9 (0=null)
DROP TABLE IF EXISTS lists;
CREATE TABLE lists (
    action_index        BIGINT UNSIGNED NOT NULL, -- Unique action index
    type                VARCHAR(1),                -- List type (1=TICK, 2=ASSET, 3=ADDRESS)
    edit                VARCHAR(1),                -- Edit action (1=ADD, 2=REMOVE)
    list_action_index   BIGINT UNSIGNED,          -- list action_index
    memo_id             BIGINT UNSIGNED,          -- id of record in index_memos table
    status_id           BIGINT UNSIGNED           -- id of record in index_statuses table
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index      ON lists (action_index);
CREATE        INDEX type              ON lists (type);
CREATE        INDEX edit              ON lists (edit);
CREATE        INDEX list_action_index ON lists (list_action_index);
CREATE        INDEX memo_id           ON lists (memo_id);
CREATE        INDEX status_id         ON lists (status_id);

DROP TABLE IF EXISTS list_items;
CREATE TABLE list_items (
    action_index BIGINT UNSIGNED NOT NULL, -- Unique action index
    item_id      BIGINT UNSIGNED           -- id of record (tick_id, address_id) tables
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE        INDEX action_index ON list_items (action_index);
CREATE        INDEX item_id      ON list_items (item_id);

DROP TABLE IF EXISTS list_edits;
CREATE TABLE list_edits (
    action_index BIGINT UNSIGNED NOT NULL,  -- Unique action index
    item_id      BIGINT UNSIGNED,           -- id of record (tick_id, asset_id, address_id) tables
    status_id    BIGINT UNSIGNED            -- id of record in index_statuses table
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE        INDEX action_index ON list_edits (action_index);
CREATE        INDEX item_id      ON list_edits (item_id);
CREATE        INDEX status_id    ON list_edits (status_id);

DROP TABLE IF EXISTS list_items_invalid;
CREATE TABLE list_items_invalid (
    action_index BIGINT UNSIGNED NOT NULL, -- Unique action index
    item_id      BIGINT UNSIGNED,           -- id of record (tick_id, address_id) tables
    status_id    BIGINT UNSIGNED           -- id of record in index_statuses table
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE        INDEX action_index ON list_items_invalid (action_index);
CREATE        INDEX item_id      ON list_items_invalid (item_id);
CREATE        INDEX status_id    ON list_items_invalid (status_id);

-- TODO : Convert encryption_method field to INTEGER UNSIGNED and force value to 0-9 (0=null)
DROP TABLE IF EXISTS messages;
CREATE TABLE messages (
    action_index        BIGINT UNSIGNED NOT NULL, -- Unique action index
    coin                VARCHAR(4),               -- Destination coin network (BTC, LTC, DOGE)
    destination_id      BIGINT UNSIGNED,          -- id of record in index_addresses table
    encryption_method   VARCHAR(1),               -- Encryption Method (1=ECDH, 2=AES)
    encryption_key      MEDIUMTEXT,               -- Public key to be used to exchange messages
    encrypted_message   MEDIUMTEXT,               -- Encrypted Message
    plaintext_message   MEDIUMTEXT,               -- Plaintext Message
    status_id           BIGINT UNSIGNED           -- id of record in index_statuses table
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index      ON messages (action_index);
CREATE        INDEX encryption_method ON messages (encryption_method);
CREATE        INDEX destination_id    ON messages (destination_id);
CREATE        INDEX status_id         ON messages (status_id);

DROP TABLE IF EXISTS mints;
CREATE TABLE mints (
    action_index   BIGINT UNSIGNED NOT NULL, -- Unique action index
    tick_id        BIGINT UNSIGNED,          -- id of record in index_ticks table
    amount         VARCHAR(250),              -- Amount of token to mint
    destination_id BIGINT UNSIGNED,          -- id of record in index_addresses table (optional, mint and transfer)
    memo_id        BIGINT UNSIGNED,          -- id of record in index_memos table
    status_id      BIGINT UNSIGNED           -- id of record in index_statuses table
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index   ON mints (action_index);
CREATE        INDEX tick_id        ON mints (tick_id);
CREATE        INDEX destination_id ON mints (destination_id);
CREATE        INDEX memo_id        ON mints (memo_id);
CREATE        INDEX status_id      ON mints (status_id);

DROP TABLE IF EXISTS orders;
CREATE TABLE orders (
    action_index     BIGINT UNSIGNED NOT NULL, -- Unique action index
    give_coin_id     BIGINT UNSIGNED,          -- id of record in index_coins table
    give_tick_id     BIGINT UNSIGNED,          -- id of record in index_tickers table
    give_amount      VARCHAR(250),             -- Amount of GIVE_TICK in order
    get_coin_id      BIGINT UNSIGNED,          -- id of record in index_coins table
    get_tick_id      BIGINT UNSIGNED,          -- id of record in index_tickers table
    get_amount       VARCHAR(250),             -- Amount of GET_TICK in order
    give_ownership   TINYINT(1) NOT NULL DEFAULT 0, -- 1 = order escrows GIVE_TICK ownership instead of a balance amount
    get_ownership    TINYINT(1) NOT NULL DEFAULT 0, -- 1 = order requires matcher to currently own GET_TICK and transfer it
    get_address_id   BIGINT UNSIGNED,          -- id of record in index_addresses table
    expiration       BIGINT UNSIGNED,          -- unix timestamp of order expiration date/time
    allow_list       BIGINT UNSIGNED,          -- action_index of a list from the lists table
    block_list       BIGINT UNSIGNED,          -- action_index of a list from the lists table
    memo_id          BIGINT UNSIGNED,          -- id of record in index_memos table
    status_id        BIGINT UNSIGNED,          -- id of record in index_statuses table (status of open order tx)
    payout_legs      TEXT                      -- programmable policy: JSON [{to,bps}] royalty/fee split of seller proceeds, applied at match (NULL = none)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index   ON orders (action_index);
CREATE        INDEX give_ownership ON orders (give_ownership);
CREATE        INDEX get_ownership  ON orders (get_ownership);
CREATE        INDEX give_coin_id   ON orders (give_coin_id);
CREATE        INDEX give_tick_id   ON orders (give_tick_id);
CREATE        INDEX get_coin_id    ON orders (get_coin_id);
CREATE        INDEX get_tick_id    ON orders (get_tick_id);
CREATE        INDEX allow_list     ON orders (allow_list);
CREATE        INDEX block_list     ON orders (block_list);
CREATE        INDEX get_address_id ON orders (get_address_id);
CREATE        INDEX memo_id        ON orders (memo_id);
CREATE        INDEX status_id      ON orders (status_id);

DROP TABLE IF EXISTS order_cancels;
CREATE TABLE order_cancels (
    action_index      BIGINT UNSIGNED NOT NULL,  -- Unique action index
    order_action_index BIGINT UNSIGNED NOT NULL, -- Unique action index from orders table
    memo_id           BIGINT UNSIGNED,           -- id of record in index_memos table
    status_id         BIGINT UNSIGNED            -- id of record in index_statuses table (valid / invalid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index       ON order_cancels (action_index);
CREATE        INDEX order_action_index ON order_cancels (order_action_index);
CREATE        INDEX memo_id            ON order_cancels (memo_id);
CREATE        INDEX status_id          ON order_cancels (status_id);

DROP TABLE IF EXISTS order_edits;
CREATE TABLE order_edits (
    action_index       BIGINT UNSIGNED NOT NULL, -- Unique action index
    order_action_index BIGINT UNSIGNED NOT NULL, -- Unique action index from orders table
    expiration         BIGINT UNSIGNED,          -- unix timestamp of swap expiration date/time
    allow_list         BIGINT UNSIGNED,          -- action_index of a list from the lists table
    block_list         BIGINT UNSIGNED,          -- action_index of a list from the lists table
    memo_id            BIGINT UNSIGNED,          -- id of record in index_memos table
    status_id          BIGINT UNSIGNED           -- id of record in index_statuses table (valid / invalid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index       ON order_edits (action_index);
CREATE        INDEX order_action_index ON order_edits (order_action_index);
CREATE        INDEX allow_list         ON order_edits (allow_list);
CREATE        INDEX block_list         ON order_edits (block_list);
CREATE        INDEX memo_id            ON order_edits (memo_id);
CREATE        INDEX status_id          ON order_edits (status_id);

DROP TABLE IF EXISTS order_expires;
CREATE TABLE order_expires (
    action_index       BIGINT UNSIGNED NOT NULL, -- Unique action index
    order_action_index BIGINT UNSIGNED NOT NULL, -- Unique action index from order table
    status_id          BIGINT UNSIGNED           -- id of record in index_statuses table (valid / invalid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index       ON order_expires (action_index);
CREATE        INDEX order_action_index ON order_expires (order_action_index);
CREATE        INDEX status_id          ON order_expires (status_id);

DROP TABLE IF EXISTS order_matches;
CREATE TABLE order_matches (
    action_index      BIGINT UNSIGNED NOT NULL, -- Unique action index
    give_action_index BIGINT UNSIGNED NOT NULL, -- Unique action index on GIVE_COIN network of the order request
    give_coin_id      BIGINT UNSIGNED NOT NULL, -- id of record in index_coins table
    give_tick_id      BIGINT UNSIGNED NOT NULL, -- id of record in index_tickers table
    give_amount       VARCHAR(250),             -- Amount of GIVE_TICK
    get_action_index  BIGINT UNSIGNED NOT NULL, -- Unique action index on GET_COIN network of the order request
    get_coin_id       BIGINT UNSIGNED NOT NULL, -- id of record in index_coins table
    get_tick_id       BIGINT UNSIGNED NOT NULL, -- id of record in index_coins table
    get_amount        VARCHAR(250),             -- Amount of GET_TICK
    settlement_type   ENUM('instant','coinpay') DEFAULT 'instant', -- Settlement type (instant for token-token, coinpay for native coin pairs)
    status_id         BIGINT UNSIGNED           -- id of record in index_statuses table (valid / invalid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index      ON order_matches (action_index);
CREATE        INDEX give_coin_id      ON order_matches (give_coin_id);
CREATE        INDEX give_tick_id      ON order_matches (give_tick_id);
CREATE        INDEX give_action_index ON order_matches (give_action_index);
CREATE        INDEX get_coin_id       ON order_matches (get_coin_id);
CREATE        INDEX get_tick_id       ON order_matches (get_tick_id);
CREATE        INDEX get_action_index  ON order_matches (get_action_index);
CREATE        INDEX status_id         ON order_matches (status_id);

DROP TABLE IF EXISTS order_statuses;
CREATE TABLE order_statuses (
    action_index       BIGINT UNSIGNED NOT NULL, -- Unique action index
    order_action_index BIGINT UNSIGNED NOT NULL, -- Unique action index from orders table
    status_id          BIGINT UNSIGNED           -- id of record in index_statuses table (status of order tx open/invalid/complete/cancelled/expired)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE        INDEX action_index       ON order_statuses (action_index);
CREATE        INDEX order_action_index ON order_statuses (order_action_index);
CREATE        INDEX status_id          ON order_statuses (status_id);

DROP TABLE IF EXISTS sends;
CREATE TABLE sends (
    action_index   BIGINT UNSIGNED NOT NULL, -- Unique action index
    tick_id        BIGINT UNSIGNED,          -- id of record in index_ticks table
    destination_id BIGINT UNSIGNED,          -- id of record in index_addresses table
    amount         VARCHAR(250),              -- Amount of token in send
    memo_id        BIGINT UNSIGNED,          -- id of record in index_memos table
    status_id      BIGINT UNSIGNED           -- id of record in index_statuses table
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE        INDEX action_index   ON sends (action_index);
CREATE        INDEX tick_id        ON sends (tick_id);
CREATE        INDEX destination_id ON sends (destination_id);
CREATE        INDEX status_id      ON sends (status_id);

DROP TABLE IF EXISTS `sleeps`;
CREATE TABLE sleeps (
    action_index     BIGINT UNSIGNED NOT NULL, -- Unique action index
    type             BIGINT UNSIGNED,          -- 1=Address, 2=Ticker
    tick_id          BIGINT UNSIGNED,          -- id of record in index_tickers table
    resume_block     VARCHAR(25),              -- Block index of the resume block
    memo_id          BIGINT UNSIGNED,          -- id of record in index_memos table
    status_id        BIGINT UNSIGNED           -- id of record in index_statuses table
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index   ON sleeps (action_index);
CREATE        INDEX type           ON sleeps (type);
CREATE        INDEX tick_id        ON sleeps (tick_id);
CREATE        INDEX memo_id        ON sleeps (memo_id);
CREATE        INDEX status_id      ON sleeps (status_id);

DROP TABLE IF EXISTS swaps;
CREATE TABLE swaps (
    action_index     BIGINT UNSIGNED NOT NULL, -- Unique action index
    give_coin_id     BIGINT UNSIGNED,          -- id of record in index_coins table
    give_tick_id     BIGINT UNSIGNED,          -- id of record in index_tickers table
    give_amount      VARCHAR(250),             -- Amount of GIVE_TICK in swap
    get_coin_id      BIGINT UNSIGNED,          -- id of record in index_coins table
    get_tick_id      BIGINT UNSIGNED,          -- id of record in index_tickers table
    get_amount       VARCHAR(250),             -- Amount of GET_TICK in swap
    give_ownership   TINYINT(1) NOT NULL DEFAULT 0, -- 1 = swap escrows GIVE_TICK ownership instead of a balance amount
    get_ownership    TINYINT(1) NOT NULL DEFAULT 0, -- 1 = swap requires matcher to currently own GET_TICK and transfer it
    get_address_id   BIGINT UNSIGNED,          -- id of record in index_addresses table
    expiration       BIGINT UNSIGNED,          -- unix timestamp of swap expiration date/time
    allow_list       BIGINT UNSIGNED,          -- action_index of a list from the lists table
    block_list       BIGINT UNSIGNED,          -- action_index of a list from the lists table
    memo_id          BIGINT UNSIGNED,          -- id of record in index_memos table
    status_id        BIGINT UNSIGNED,          -- id of record in index_statuses table (status of open swap tx)
    payout_legs      TEXT                      -- programmable policy: JSON [{to,bps}] royalty/fee split of seller proceeds, applied at match (NULL = none)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index   ON swaps (action_index);
CREATE        INDEX give_ownership ON swaps (give_ownership);
CREATE        INDEX get_ownership  ON swaps (get_ownership);
CREATE        INDEX give_coin_id   ON swaps (give_coin_id);
CREATE        INDEX give_tick_id   ON swaps (give_tick_id);
CREATE        INDEX get_coin_id    ON swaps (get_coin_id);
CREATE        INDEX get_tick_id    ON swaps (get_tick_id);
CREATE        INDEX allow_list     ON swaps (allow_list);
CREATE        INDEX block_list     ON swaps (block_list);
CREATE        INDEX get_address_id ON swaps (get_address_id);
CREATE        INDEX memo_id        ON swaps (memo_id);
CREATE        INDEX status_id      ON swaps (status_id);

DROP TABLE IF EXISTS swap_cancels;
CREATE TABLE swap_cancels (
    action_index      BIGINT UNSIGNED NOT NULL, -- Unique action index
    swap_action_index BIGINT UNSIGNED NOT NULL, -- Unique action index from swaps table
    memo_id           BIGINT UNSIGNED,          -- id of record in index_memos table
    status_id         BIGINT UNSIGNED           -- id of record in index_statuses table (valid / invalid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index      ON swap_cancels (action_index);
CREATE        INDEX swap_action_index ON swap_cancels (swap_action_index);
CREATE        INDEX memo_id           ON swap_cancels (memo_id);
CREATE        INDEX status_id         ON swap_cancels (status_id);

DROP TABLE IF EXISTS swap_edits;
CREATE TABLE swap_edits (
    action_index      BIGINT UNSIGNED NOT NULL, -- Unique action index
    swap_action_index BIGINT UNSIGNED NOT NULL, -- Unique action index from swaps table
    expiration        BIGINT UNSIGNED,          -- unix timestamp of swap expiration date/time
    allow_list        BIGINT UNSIGNED,          -- action_index of a list from the lists table
    block_list        BIGINT UNSIGNED,          -- action_index of a list from the lists table
    memo_id           BIGINT UNSIGNED,          -- id of record in index_memos table
    status_id         BIGINT UNSIGNED           -- id of record in index_statuses table (valid / invalid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index      ON swap_edits (action_index);
CREATE        INDEX swap_action_index ON swap_edits (swap_action_index);
CREATE        INDEX allow_list        ON swap_edits (allow_list);
CREATE        INDEX block_list        ON swap_edits (block_list);
CREATE        INDEX memo_id           ON swap_edits (memo_id);
CREATE        INDEX status_id         ON swap_edits (status_id);

DROP TABLE IF EXISTS swap_expires;
CREATE TABLE swap_expires (
    action_index      BIGINT UNSIGNED NOT NULL, -- Unique action index
    swap_action_index BIGINT UNSIGNED NOT NULL, -- Unique action index from swaps table
    status_id         BIGINT UNSIGNED           -- id of record in index_statuses table (valid / invalid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index      ON swap_expires (action_index);
CREATE        INDEX swap_action_index ON swap_expires (swap_action_index);
CREATE        INDEX status_id         ON swap_expires (status_id);

DROP TABLE IF EXISTS swap_matches;
CREATE TABLE swap_matches (
    action_index      BIGINT UNSIGNED NOT NULL, -- Unique action index
    give_action_index BIGINT UNSIGNED NOT NULL, -- Unique action index on GIVE_COIN network of the swap request
    give_coin_id      BIGINT UNSIGNED NOT NULL, -- id of record in index_coins table
    give_tick_id      BIGINT UNSIGNED NOT NULL, -- id of record in index_tickers table
    give_amount       VARCHAR(250),             -- Amount of GIVE_TICK
    get_action_index  BIGINT UNSIGNED NOT NULL, -- Unique action index on GET_COIN network of the swap request
    get_coin_id       BIGINT UNSIGNED NOT NULL, -- id of record in index_coins table
    get_tick_id       BIGINT UNSIGNED NOT NULL, -- id of record in index_coins table
    get_amount        VARCHAR(250),             -- Amount of GET_TICK
    status_id         BIGINT UNSIGNED           -- id of record in index_statuses table (valid / invalid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index      ON swap_matches (action_index);
CREATE        INDEX give_coin_id      ON swap_matches (give_coin_id);
CREATE        INDEX give_tick_id      ON swap_matches (give_tick_id);
CREATE        INDEX give_action_index ON swap_matches (give_action_index);
CREATE        INDEX get_coin_id       ON swap_matches (get_coin_id);
CREATE        INDEX get_tick_id       ON swap_matches (get_tick_id);
CREATE        INDEX get_action_index  ON swap_matches (get_action_index);
CREATE        INDEX status_id         ON swap_matches (status_id);

DROP TABLE IF EXISTS swap_statuses;
CREATE TABLE swap_statuses (
    action_index      BIGINT UNSIGNED NOT NULL, -- Unique action index
    swap_action_index BIGINT UNSIGNED NOT NULL, -- Unique action index from swaps table
    status_id         BIGINT UNSIGNED           -- id of record in index_statuses table (status of swap tx open/invalid/complete/cancelled/expired)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE        INDEX action_index      ON swap_statuses (action_index);
CREATE        INDEX swap_action_index ON swap_statuses (swap_action_index);
CREATE        INDEX status_id         ON swap_statuses (status_id);

DROP TABLE IF EXISTS sweeps;
CREATE TABLE sweeps (
    action_index     BIGINT UNSIGNED NOT NULL, -- Unique action index
    balances         BIGINT UNSIGNED,          -- Indicates if token balances should be swept
    ownerships       BIGINT UNSIGNED,          -- Indicates if token ownerships should be swept
    orders           BIGINT UNSIGNED,          -- Indicates if open ORDERs should be cancelled and escrow credited to DESTINATION
    swaps            BIGINT UNSIGNED,          -- Indicates if open SWAPs should be cancelled and escrow credited to DESTINATION
    dispensers       BIGINT UNSIGNED,          -- Indicates if open DISPENSERs should be closed and escrow credited to DESTINATION
    destination_id   BIGINT UNSIGNED,          -- id of record in index_addresses table
    memo_id          BIGINT UNSIGNED,          -- id of record in index_memos table
    status_id        BIGINT UNSIGNED           -- id of record in index_statuses table
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index   ON sweeps (action_index);
CREATE        INDEX destination_id ON sweeps (destination_id);
CREATE        INDEX memo_id        ON sweeps (memo_id);
CREATE        INDEX status_id      ON sweeps (status_id);

-- ============================================================
-- 5. Other tables
-- ============================================================

DROP TABLE IF EXISTS markets;
CREATE TABLE markets (
    id                 INTEGER UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tick1_id           BIGINT UNSIGNED,                 -- tick1 - id of record in index_tickers table
    tick1_price        VARCHAR(250) NOT NULL default 0, -- tick1 - last trade price
    tick1_bid          VARCHAR(250) NOT NULL default 0, -- tick1 - highest price buyers are paying
    tick1_ask          VARCHAR(250) NOT NULL default 0, -- tick1 - highest price sellers are accepting
    tick1_24hr_price   VARCHAR(250) NOT NULL default 0, -- tick1 - Price exactly 24 hours ago
    tick1_24hr_high    VARCHAR(250) NOT NULL default 0, -- tick1 - 24-hour high price
    tick1_24hr_low     VARCHAR(250) NOT NULL default 0, -- tick1 - 24-hour low price
    tick1_24hr_change  VARCHAR(250) NOT NULL default 0, -- tick1 - 24-hour percentage change
    tick1_24hr_volume  VARCHAR(250) NOT NULL default 0, -- tick1 - 24-hour volume
    tick2_id           BIGINT UNSIGNED,                 -- tick2 - id of record in index_tickers table
    tick2_price        VARCHAR(250) NOT NULL default 0, -- tick2 - last trade price
    tick2_bid          VARCHAR(250) NOT NULL default 0, -- tick2 - highest price buyers are paying
    tick2_ask          VARCHAR(250) NOT NULL default 0, -- tick2 - highest price sellers are accepting
    tick2_24hr_price   VARCHAR(250) NOT NULL default 0, -- tick2 - Price exactly 24 hours ago
    tick2_24hr_high    VARCHAR(250) NOT NULL default 0, -- tick2 - 24-hour high price
    tick2_24hr_low     VARCHAR(250) NOT NULL default 0, -- tick2 - 24-hour low price
    tick2_24hr_change  VARCHAR(250) NOT NULL default 0, -- tick2 - 24-hour percentage change
    tick2_24hr_volume  VARCHAR(250) NOT NULL default 0, -- tick2 - 24-hour volume
    last_updated  BIGINT UNSIGNED                       -- Last updated
) ENGINE=InnoDB CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE INDEX tick1_id on markets (tick1_id);
CREATE INDEX tick2_id on markets (tick2_id);

-- Table used to map action_indexes
-- Note : Used to pull a list of action_indexes related to an address or tick

DROP TABLE IF EXISTS mappings_actions;
CREATE TABLE mappings_actions (
    action_index  BIGINT  UNSIGNED NOT NULL, -- Action index
    type_id       TINYINT UNSIGNED,          -- Integer value for mapping type
                                             -- 1 = tick    (id=tick_id)
                                             -- 2 = address (id=address_id)
    id            BIGINT UNSIGNED NOT NULL   -- id of record
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE        INDEX action_index      ON mappings_actions (action_index);
CREATE        INDEX type_id           ON mappings_actions (type_id);
CREATE        INDEX id                ON mappings_actions (id);

-- Table used to map files to tickers
-- Note : Used to pull a list of action_indexes where a file is linked to a tick

DROP TABLE IF EXISTS mappings_files;
CREATE TABLE mappings_files (
    action_index  BIGINT  UNSIGNED NOT NULL, -- Action index
    type_id       TINYINT UNSIGNED,          -- Integer value for mapping type
                                             -- 1 = tick (id=tick_id)
    id            BIGINT UNSIGNED NOT NULL   -- id of record
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE        INDEX action_index      ON mappings_files (action_index);
CREATE        INDEX type_id           ON mappings_files (type_id);
CREATE        INDEX id                ON mappings_files (id);

DROP TABLE IF EXISTS events;
CREATE TABLE events (
    id   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    time DATETIME,
    code VARCHAR(50),
    data VARCHAR(250),
    witness_time DATETIME,           -- REORG marker witness: decoder event's time; NULL on legacy/non-REORG rows
    witness_hash CHAR(64)            -- REORG marker witness: sha256 of the decoder event's data; NULL on legacy/non-REORG rows
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- ============================================================
-- Smart contracts + Phase F controller / permissions surfaces
-- (auto-generated from xchain-indexer/src/sql/*.sql)
-- ============================================================

DROP TABLE IF EXISTS contracts;
CREATE TABLE contracts (
    action_index          BIGINT UNSIGNED NOT NULL,
    source_id             BIGINT UNSIGNED NOT NULL,
    code                  MEDIUMTEXT NOT NULL,
    code_hash             CHAR(64) NOT NULL,
    api_version           INT UNSIGNED NOT NULL DEFAULT 1,
    status_id             BIGINT UNSIGNED,
    block_index           BIGINT UNSIGNED NOT NULL,
    cooldown_blocks       INT UNSIGNED,
    slash_destination_id  BIGINT UNSIGNED
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index         ON contracts (action_index);
CREATE        INDEX source_id            ON contracts (source_id);
CREATE        INDEX code_hash            ON contracts (code_hash);
CREATE        INDEX status_id            ON contracts (status_id);
CREATE        INDEX slash_destination_id ON contracts (slash_destination_id);

DROP TABLE IF EXISTS contract_permissions;
CREATE TABLE contract_permissions (
    action_index    BIGINT UNSIGNED NOT NULL,
    contract_index  BIGINT UNSIGNED NOT NULL,
    permissions     TEXT,
    max_take_bps    INT UNSIGNED,
    block_index     BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index   ON contract_permissions (action_index);
CREATE        INDEX contract_index ON contract_permissions (contract_index);
CREATE        INDEX block_index    ON contract_permissions (block_index);

DROP TABLE IF EXISTS token_controllers;
CREATE TABLE token_controllers (
    id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    action_index        BIGINT UNSIGNED NOT NULL,
    tick_id             BIGINT UNSIGNED NOT NULL,
    action_class        VARCHAR(16) NOT NULL,
    contract_index      BIGINT UNSIGNED NOT NULL,
    bound_by_id         BIGINT UNSIGNED NOT NULL,
    is_unbind           TINYINT(1) NOT NULL DEFAULT 0,
    cooldown_blocks     INT UNSIGNED NOT NULL DEFAULT 0,
    cooldown_end_block  BIGINT UNSIGNED,
    block_index         BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index   ON token_controllers (action_index);
CREATE        INDEX tick_id        ON token_controllers (tick_id);
CREATE        INDEX contract_index ON token_controllers (contract_index);
CREATE        INDEX tick_class     ON token_controllers (tick_id, action_class);
CREATE        INDEX block_index    ON token_controllers (block_index);

DROP TABLE IF EXISTS address_controllers;
CREATE TABLE address_controllers (
    id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    action_index        BIGINT UNSIGNED NOT NULL,
    address_id          BIGINT UNSIGNED NOT NULL,
    action_class        VARCHAR(16) NOT NULL,
    contract_index      BIGINT UNSIGNED NOT NULL,
    is_unbind           TINYINT(1) NOT NULL DEFAULT 0,
    cooldown_blocks     INT UNSIGNED NOT NULL DEFAULT 0,
    cooldown_end_block  BIGINT UNSIGNED,
    block_index         BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index   ON address_controllers (action_index);
CREATE        INDEX address_id     ON address_controllers (address_id);
CREATE        INDEX contract_index ON address_controllers (contract_index);
CREATE        INDEX address_class  ON address_controllers (address_id, action_class);
CREATE        INDEX block_index    ON address_controllers (block_index);

-- ============================================================
-- Cross-chain calls (XCALL): source-chain lifecycle tables
-- ============================================================

DROP TABLE IF EXISTS xcalls;
CREATE TABLE xcalls (
    action_index          BIGINT UNSIGNED NOT NULL,
    version               INT             NOT NULL,
    call_id               VARCHAR(80)     NOT NULL,
    contract_index        BIGINT UNSIGNED,
    target_chain          VARCHAR(10),
    target_contract_index BIGINT UNSIGNED,
    method                VARCHAR(64),
    params_json           TEXT,
    gas_limit             BIGINT UNSIGNED,
    cross_hops            INT,
    callback_method       VARCHAR(64),
    callback_params_json  TEXT,
    deadline_block        BIGINT UNSIGNED,
    request_status        VARCHAR(20),
    result_status         VARCHAR(20),
    result_payload        TEXT,
    resolved_block        BIGINT UNSIGNED,
    callback_action_index BIGINT UNSIGNED,
    block_index           BIGINT UNSIGNED NOT NULL,
    status_id             INT             NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index   ON xcalls (action_index);
CREATE        INDEX call_id        ON xcalls (call_id);
CREATE        INDEX request_status ON xcalls (request_status, deadline_block);
CREATE        INDEX block_index    ON xcalls (block_index);
CREATE        INDEX contract_index ON xcalls (contract_index);

DROP TABLE IF EXISTS cross_chain_call_executions;
CREATE TABLE cross_chain_call_executions (
    action_index       BIGINT UNSIGNED NOT NULL,
    call_id            VARCHAR(80)     NOT NULL,
    execute_action_index BIGINT UNSIGNED,
    result_status      VARCHAR(20)     NOT NULL,
    return_payload_b64 TEXT,
    gas_used           BIGINT UNSIGNED NOT NULL DEFAULT 0,
    block_index        BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX call_id      ON cross_chain_call_executions (call_id);
CREATE        INDEX action_index ON cross_chain_call_executions (action_index);
CREATE        INDEX block_index  ON cross_chain_call_executions (block_index);

DROP TABLE IF EXISTS cross_chain_call_callbacks;
CREATE TABLE cross_chain_call_callbacks (
    action_index          BIGINT UNSIGNED NOT NULL,
    call_id               VARCHAR(80)     NOT NULL,
    result_status         VARCHAR(20)     NOT NULL,
    block_index           BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX call_id      ON cross_chain_call_callbacks (call_id);
CREATE        INDEX action_index ON cross_chain_call_callbacks (action_index);
CREATE        INDEX block_index  ON cross_chain_call_callbacks (block_index);

-- ============================================================
-- Contract execution surfaces for the contract page + read-only
-- simulation endpoint (auto-generated from xchain-indexer/src/sql/*.sql)
-- ============================================================

DROP TABLE IF EXISTS contract_state;
CREATE TABLE contract_state (
    id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    contract_index      BIGINT UNSIGNED NOT NULL,
    state_key           VARCHAR(256) NOT NULL,
    -- Binary-collation shadow of state_key (see xchain-indexer contract_state.sql)
    state_key_bin       VARCHAR(256) CHARACTER SET utf8 COLLATE utf8_bin
                        GENERATED ALWAYS AS (state_key) VIRTUAL,
    state_value         MEDIUMTEXT,
    block_index         BIGINT UNSIGNED NOT NULL,
    action_index        BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE INDEX idx_latest ON contract_state (contract_index, state_key, id DESC);
CREATE INDEX idx_block  ON contract_state (block_index);

DROP TABLE IF EXISTS contract_executions;
CREATE TABLE contract_executions (
    action_index        BIGINT UNSIGNED NOT NULL,
    contract_index      BIGINT UNSIGNED,
    caller_id           BIGINT UNSIGNED NOT NULL,
    method_name         VARCHAR(250),
    input_params        TEXT,
    gas_used            BIGINT UNSIGNED NOT NULL,
    gas_limit           BIGINT UNSIGNED NOT NULL,
    status_id           BIGINT UNSIGNED NOT NULL,
    error_message       TEXT,
    emitted_count       INT UNSIGNED NOT NULL DEFAULT 0,
    block_index         BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index   ON contract_executions (action_index);
CREATE        INDEX contract_index ON contract_executions (contract_index);
CREATE        INDEX caller_id      ON contract_executions (caller_id);
CREATE        INDEX block_index    ON contract_executions (block_index);

-- The actions a contract call emitted. Every action detail reads this to learn whether
-- it was emitted rather than broadcast, so a schema without it fails the whole page and
-- not just the EXECUTE view that already queried it. Mirrors
-- xchain-indexer/src/sql/contract_emissions.sql.
DROP TABLE IF EXISTS contract_emissions;
CREATE TABLE contract_emissions (
    id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    execution_index     BIGINT UNSIGNED NOT NULL,
    emitted_action      VARCHAR(20) NOT NULL,
    action_index        BIGINT UNSIGNED NULL,
    position            INT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE INDEX execution_index ON contract_emissions (execution_index);
CREATE INDEX action_index    ON contract_emissions (action_index);

-- Gated FILE v1 metadata. Every surface that lists a token's files LEFT JOINs this to
-- say whether the bytes are gated, so its absence 500s the token page and the files
-- feed alike. Mirrors xchain-indexer/src/sql/gated_files.sql.
DROP TABLE IF EXISTS gated_files;
CREATE TABLE gated_files (
    action_index        BIGINT UNSIGNED NOT NULL,
    gate_ticker         VARCHAR(250) NOT NULL,
    encryption_method   TINYINT UNSIGNED NOT NULL,
    key_hash            CHAR(64) NOT NULL,
    publisher_address   VARCHAR(255) NOT NULL DEFAULT '',
    gate_min_amount     VARCHAR(40) NULL,
    status_id           BIGINT UNSIGNED,
    raw_data            MEDIUMBLOB
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index          ON gated_files (action_index);
CREATE        INDEX gate_ticker_key_hash  ON gated_files (gate_ticker, key_hash);
CREATE        INDEX gate_ticker_status_id ON gated_files (gate_ticker, status_id);

-- ============================================================
-- Action tables required by getBlocks' per-block UNION count
-- (this.actionTables). Mirror the xchain-indexer source-of-truth
-- (src/sql/*.sql). The perf seed does not populate them, so they
-- count 0 per block; they must exist or the blocks query fails.
-- ============================================================

DROP TABLE IF EXISTS anchor_actions;
CREATE TABLE anchor_actions (
    action_index         BIGINT UNSIGNED NOT NULL,        -- FK to actions (the ANCHOR action that wrote this row)
    section_index        TINYINT UNSIGNED NOT NULL DEFAULT 0, -- 0-based section of a v7 bundle (one row per checkpointed chain); 0 on every single-checkpoint and archive version
    version              TINYINT UNSIGNED NOT NULL,       -- 0=checkpoint, 1=checkpoint+archive, 2=continuation, 7=per-network bundle section
    chain                VARCHAR(10),                     -- checkpointed chain (v0/v1)
    network              VARCHAR(20),                     -- checkpointed network (v0/v1)
    block_index          BIGINT UNSIGNED,                 -- checkpointed height on `chain` (v0/v1)
    block_hash           VARCHAR(64),                     -- chain block hash at block_index
    ledger_hash          VARCHAR(64),                     -- indexer blocks.ledger_hash at block_index
    actions_hash         VARCHAR(64),                     -- indexer blocks.actions_hash
    contract_hash        VARCHAR(64),                     -- indexer blocks.contract_hash
    checkpoint_seq       BIGINT UNSIGNED,                 -- monotonic per (chain, network); replay guard
    snapshot_block       BIGINT UNSIGNED,                 -- BTC block selecting the oracle_publish set
    state_root           CHAR(64),                        -- SPV light-client state_root carried by ANCHOR v3; NULL for v0/v1/v2
    state_root_version   TINYINT UNSIGNED,                -- merkle.js STATE_ROOT_VERSION (v3 only)
    block_merkle_root    CHAR(64),                        -- SPV per-block content Merkle root carried by ANCHOR v3; NULL otherwise
    block_merkle_version TINYINT UNSIGNED,                -- merkle.js BLOCK_MERKLE_VERSION (v3 only)
    match_batch_seq      BIGINT UNSIGNED,                 -- archive batch id (v1/v2)
    match_count          INT UNSIGNED,                    -- match records in the batch (v1)
    batch_crc32          VARCHAR(8),                      -- CRC32 of the UNCOMPRESSED archive JSON (v1)
    total_chunks         INT UNSIGNED,                    -- chunks in the batch (v1/v2)
    chunk_index          INT UNSIGNED,                    -- 1-based continuation index (v2 only; v1 carries chunk 0)
    archive_b64          MEDIUMTEXT,                      -- base64url gzip archive chunk (v1 chunk 0 / v2 continuation)
    validator_signatures MEDIUMTEXT,                      -- JSON [{pubkey,sig}] over the canonical (v0/v1)
    publisher            VARCHAR(64),                     -- elected PUBLISHER pubkey carried by the v4/v5/v6 tail; NULL for v0-v3
    publisher_attestations MEDIUMTEXT,                    -- JSON [{pubkey,sig}] RAW wire XANCPUB tail (v4/v5/v6); NULL for v0-v3
    status_id            BIGINT UNSIGNED,                 -- FK to index_statuses
    block_index_doge     BIGINT UNSIGNED NOT NULL,        -- DOGE block the ANCHOR action landed in (rollback anchor)
    PRIMARY KEY (action_index, section_index)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE INDEX idx_anchor_batch      ON anchor_actions (match_batch_seq, version, chunk_index);
CREATE INDEX idx_anchor_checkpoint ON anchor_actions (chain, network, checkpoint_seq);

DROP TABLE IF EXISTS coinpays;
CREATE TABLE coinpays (
    action_index            BIGINT UNSIGNED NOT NULL, -- Unique action index of this COINPAY action
    obligation_action_index BIGINT UNSIGNED NOT NULL, -- FK to coinpay_obligations (ORDER_MATCH action_index)
    coin_amount             VARCHAR(250) NOT NULL,    -- Native coin amount actually paid
    txid                    VARCHAR(64) NOT NULL,     -- Blockchain transaction ID of the payment
    vout                    INT UNSIGNED NOT NULL,    -- Output index in the payment transaction
    status_id               BIGINT UNSIGNED,          -- id of record in index_statuses table (valid/invalid)
    block_index             BIGINT UNSIGNED NOT NULL  -- Block height when COINPAY was processed
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index            ON coinpays (action_index);
CREATE        INDEX obligation_action_index ON coinpays (obligation_action_index);
CREATE        INDEX status_id               ON coinpays (status_id);

DROP TABLE IF EXISTS coinpay_expires;
CREATE TABLE coinpay_expires (
    action_index            BIGINT UNSIGNED NOT NULL, -- Unique action index of this COINPAY_EXPIRE action
    obligation_action_index BIGINT UNSIGNED NOT NULL, -- FK to coinpay_obligations (ORDER_MATCH action_index)
    status_id               BIGINT UNSIGNED           -- id of record in index_statuses table (valid/invalid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index            ON coinpay_expires (action_index);
CREATE        INDEX obligation_action_index ON coinpay_expires (obligation_action_index);
CREATE        INDEX status_id               ON coinpay_expires (status_id);

DROP TABLE IF EXISTS coinpay_obligations;
CREATE TABLE coinpay_obligations (
    action_index     BIGINT UNSIGNED NOT NULL, -- ORDER_MATCH action_index that created this obligation
    payer_address_id BIGINT UNSIGNED NOT NULL, -- id of record in index_addresses table (coin-offering party)
    payee_address_id BIGINT UNSIGNED NOT NULL, -- id of record in index_addresses table (token-selling party GET_ADDRESS)
    coin_id          BIGINT UNSIGNED NOT NULL, -- id of record in index_coins table (BTC/LTC/DOGE)
    coin_amount      VARCHAR(250) NOT NULL,    -- Native coin amount owed
    expiration       BIGINT UNSIGNED NOT NULL, -- Unix timestamp at which obligation expires
    block_index      BIGINT UNSIGNED NOT NULL  -- Block height when obligation was created
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index     ON coinpay_obligations (action_index);
CREATE        INDEX payer_address_id ON coinpay_obligations (payer_address_id);
CREATE        INDEX payee_address_id ON coinpay_obligations (payee_address_id);
CREATE        INDEX coin_id          ON coinpay_obligations (coin_id);

DROP TABLE IF EXISTS full_node_verifications;
CREATE TABLE full_node_verifications (
    id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    action_index        BIGINT UNSIGNED NOT NULL,    -- FK to actions (the NODEPROOF verdict that recorded this)
    challenge_id        CHAR(64) NOT NULL,           -- derived id of the challenge epoch
    epoch_height        BIGINT UNSIGNED NOT NULL,    -- challenge epoch block (multiple of CHALLENGE_INTERVAL_BLOCKS)
    target_height       BIGINT UNSIGNED NOT NULL,    -- buried block the possession query targeted (epoch - CONFIRM_DEPTH)
    signing_pubkey_id   BIGINT UNSIGNED NOT NULL,    -- FK to index_pubkeys (the verified full node)
    source_id           BIGINT UNSIGNED NOT NULL,    -- FK to index_addresses (staking source; per-source dedup for the equal split)
    passed              TINYINT(1) NOT NULL DEFAULT 1,
    block_index         BIGINT UNSIGNED NOT NULL     -- verdict's block (reward-window key + reorg-rollback key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX uq_epoch_pubkey ON full_node_verifications (epoch_height, signing_pubkey_id);

-- ROLLCALL presence signatures, DOGE side. Mirrors xchain-indexer/src/sql/rollcall_signers.sql.
-- NOTE: no `id` column; the primary key is the composite (epoch_height, pubkey), which is what
-- makes this a first-seen index (INSERT IGNORE, so the first valid signature for a key in an
-- epoch is the one served). Several ROLLCALL actions per epoch are expected and union together.
DROP TABLE IF EXISTS rollcall_signers;
CREATE TABLE rollcall_signers (
    epoch_height  BIGINT UNSIGNED NOT NULL,        -- BTC height of the roll-call epoch
    pubkey        CHAR(64)        NOT NULL,        -- present validator's Ed25519 signing key, lowercase hex
    sig           CHAR(128)       NOT NULL,        -- signature over the EQUIV-wrapped canonical, lowercase hex
    ledger_hash   CHAR(64)        NOT NULL,        -- BTC ledger_hash at epoch_height AS CARRIED
    publisher     CHAR(64)        NOT NULL,        -- publishing validator's signing key; the publish reward attaches to it
    action_index  BIGINT UNSIGNED NOT NULL,        -- the ROLLCALL action this signature landed in
    block_index   BIGINT UNSIGNED NOT NULL,        -- DOGE block the action landed in
    PRIMARY KEY (epoch_height, pubkey),
    KEY idx_rollcall_signers_action (action_index),
    KEY idx_rollcall_signers_block (block_index),
    KEY idx_rollcall_signers_epoch_pub (epoch_height, publisher)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;
CREATE        INDEX pubkey_block    ON full_node_verifications (signing_pubkey_id, block_index);
CREATE        INDEX source_id       ON full_node_verifications (source_id);
CREATE        INDEX block_index     ON full_node_verifications (block_index);
CREATE        INDEX action_index    ON full_node_verifications (action_index);
CREATE        INDEX challenge_id    ON full_node_verifications (challenge_id);

DROP TABLE IF EXISTS prices;
CREATE TABLE prices (
    action_index        BIGINT UNSIGNED NOT NULL,         -- FK to actions table
    version             TINYINT UNSIGNED NOT NULL,        -- 0=validator snapshot, 1=user oracle
    source_id           BIGINT UNSIGNED NOT NULL,         -- FK to index_addresses (tx source)
    round_number        BIGINT UNSIGNED,                  -- BTC block height of round
    round_timestamp     BIGINT UNSIGNED,                  -- block_time of triggering BTC block
    pair_count          SMALLINT UNSIGNED,                -- number of COIN/FIAT pairs
    pairs_json          TEXT,                             -- JSON array [{pair, price}, ...]
    sig_count           SMALLINT UNSIGNED,                -- number of PBFT signatures (NULL on a v2 row; see rounds_json)
    sigs_json           TEXT,                             -- JSON array [{pubkey, sig}, ...]; carries the BATCH signature set on a v2 row
    -- v2 fields (validator BATCH snapshot: one signed action carrying an hourly
    -- window of full round bodies). NULL on a v0/v1 row.
    batch_first_round   BIGINT UNSIGNED,                  -- FIRST_ROUND of the batch window (v2 only; NULL on a v0/v1 row)
    batch_last_round    BIGINT UNSIGNED,                  -- LAST_ROUND of the batch window (v2 only; NULL on a v0/v1 row)
    round_count         SMALLINT UNSIGNED,                -- number of rounds carried by this batch (v2 only)
    rounds_json         TEXT,                             -- JSON array of the batch per-round bodies [{round, timestamp, btc_block_height, pairs}, ...] (v2 only)
    coin_id             BIGINT UNSIGNED,                  -- FK to index_coins (which chain's token)
    tick_id             BIGINT UNSIGNED,                  -- FK to index_tickers (token name)
    fiat_id             BIGINT UNSIGNED,                  -- FK to index_fiats (currency code)
    value               VARCHAR(250),                     -- price as decimal string
    fee                 VARCHAR(250),                     -- oracle usage fee as decimal
    memo_id             BIGINT UNSIGNED,                  -- FK to index_memos
    validation_status   VARCHAR(20) NOT NULL DEFAULT 'pending',  -- valid/invalid/pending (PBFT signature validation result for v0)
    status_id           BIGINT UNSIGNED                   -- FK to index_statuses (action status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index      ON prices (action_index);
CREATE        INDEX version           ON prices (version);
CREATE        INDEX source_id         ON prices (source_id);
CREATE        INDEX round_number      ON prices (round_number);
CREATE        INDEX tick_id           ON prices (tick_id);
CREATE        INDEX fiat_id           ON prices (fiat_id);
CREATE        INDEX validation_status ON prices (validation_status);

-- Governance polls (VOTE v0). getToken surfaces open polls for a tick via
-- getTokenOpenPolls; mirror the xchain-indexer source-of-truth (src/sql/polls.sql).
DROP TABLE IF EXISTS polls;
CREATE TABLE polls (
    action_index            BIGINT UNSIGNED NOT NULL,   -- FK to actions (the VOTE v0 that created the poll); also the poll id
    block_index             BIGINT UNSIGNED NOT NULL,   -- creation block (rollback key)
    tick_id                 BIGINT UNSIGNED,            -- FK to index_tickers: electorate + weight token
    end_block               BIGINT UNSIGNED,            -- latest close block (voting accepted while cast_block <= end_block)
    options                 MEDIUMTEXT,                 -- JSON array of option labels, index-addressed by ballots
    max_selections          SMALLINT UNSIGNED,          -- max distinct options one ballot may list (1 = single-choice)
    tally_mode              ENUM('approval','split'),   -- approval = full weight per option; split = weight divided by per-option shares
    weight_mode             ENUM('balance','stake','flat','quadratic','time_weighted'), -- balance = close holdings; flat = one-address-one-vote; quadratic = sqrt(close); time_weighted = windowed avg; stake reserved
    quorum                  VARCHAR(60),                -- optional weight gate: min (counted weight / close supply) fraction, e.g. '0.2'
    min_voters              BIGINT UNSIGNED,            -- optional participation gate: min distinct qualifying voters
    min_vote_balance        VARCHAR(60),                -- dust floor: a voter counts toward min_voters only if close balance >= this
    decide_threshold        VARCHAR(60),                -- optional early-decide arm: fraction of supply an option must reach (Phase 2)
    question                MEDIUMTEXT,                 -- inline question text or a FILE reference
    poll_status             ENUM('open','finalized','failed_quorum') NOT NULL DEFAULT 'open', -- poll state (distinct from status_id)
    winning_option          SMALLINT UNSIGNED,          -- option index with highest weight (lowest index on tie); null if no winner
    total_weight            VARCHAR(60),                -- total counted weight at close
    total_voters            BIGINT UNSIGNED,            -- distinct qualifying voters at close
    quorum_met              TINYINT UNSIGNED,           -- 1 if weight quorum satisfied
    min_voters_met          TINYINT UNSIGNED,           -- 1 if participation gate satisfied
    fail_reason             ENUM('quorum','min_voters','both'), -- why a poll terminated failed_quorum (null when passed)
    decided_early           TINYINT UNSIGNED,           -- 1 if closed by decide_threshold before end_block
    effective_close_block   BIGINT UNSIGNED,            -- block weights were measured at (end_block, or early-decide crossing block)
    finalized_action_index  BIGINT UNSIGNED,            -- action_index of the VOTE v2 that finalized this poll
    resolved_block          BIGINT UNSIGNED,            -- block finalization went terminal; reorg-rollback reset key
    deposit_amount          VARCHAR(60),                -- XCHAIN amount escrowed at creation (null/0 = none)
    deposit_address_id      BIGINT UNSIGNED,            -- FK to index_addresses: the creator who paid the deposit (refund target)
    deposit_resolved        ENUM('refunded','forfeited'), -- set by v2 finalization once the deposit is released
    callback_contract_index BIGINT UNSIGNED,            -- FK to contracts: the contract v2 invokes on finalization
    callback_method         VARCHAR(64),                -- method name on that contract
    callback_params         MEDIUMTEXT,                 -- JSON array of developer params echoed to the callback
    callback_on             ENUM('pass','always'),      -- pass = only on a finalized win; always = every finalization
    gas_escrow              VARCHAR(60),                -- XCHAIN escrowed at v0 to back the callback EXECUTE (refunded at finalize)
    callback_execute_action_index BIGINT UNSIGNED,      -- action_index of the EXECUTE v2 injected (set when fired)
    callback_delay_blocks   BIGINT UNSIGNED,            -- v0 CALLBACK_DELAY_BLOCKS timelock (null/0 = fire at finalize)
    callback_due_block      BIGINT UNSIGNED,            -- block the deferred callback fires (resolved_block + delay, null = immediate)
    status_id               BIGINT UNSIGNED             -- FK to index_statuses (validation status of the create action)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index ON polls (action_index);
CREATE        INDEX tick_id      ON polls (tick_id);
CREATE        INDEX end_block    ON polls (end_block);
CREATE        INDEX poll_status  ON polls (poll_status, end_block);
CREATE        INDEX block_index  ON polls (block_index);

-- ============================================================
-- Staking / attestation / VM custody tables for the
-- attestation-, staking-, and vm-endpoints integration tests
-- (mirrored from xchain-indexer/src/sql/*.sql)
-- ============================================================

DROP TABLE IF EXISTS index_pubkeys;
CREATE TABLE index_pubkeys (
    id      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    pubkey  CHAR(64) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX pubkey ON index_pubkeys (pubkey);

DROP TABLE IF EXISTS stakes;
CREATE TABLE stakes (
    action_index        BIGINT UNSIGNED NOT NULL,        -- FK to actions table (each STAKE action gets its own row)
    source_id           BIGINT UNSIGNED NOT NULL,        -- FK to index_addresses (staking address)
    version             TINYINT UNSIGNED NOT NULL DEFAULT 1,  -- STAKE format: 1=new stake, 2=top-up of existing stake
    signing_pubkey_id   BIGINT UNSIGNED NOT NULL,        -- FK to index_pubkeys (Ed25519 hot key)
    amount              VARCHAR(250) NOT NULL,           -- XCHAIN added by this action
    status_id           BIGINT UNSIGNED,
    block_index         BIGINT UNSIGNED NOT NULL,
    activation_block    BIGINT UNSIGNED NOT NULL DEFAULT 0,
    deactivation_block  BIGINT UNSIGNED
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index       ON stakes (action_index);
CREATE        INDEX source_id          ON stakes (source_id);
CREATE        INDEX signing_pubkey_id  ON stakes (signing_pubkey_id);

-- Capability UNSTAKE v0 (`unstakes`; see db.js getUnstakes). Every row keys one
-- UNSTAKE action_index. A user-broadcast unstake writes one behind a real
-- transaction; a ROLLCALL eviction (xchain-indexer rollcall_close.js
-- evictSource()) writes one with STATUS 'valid' and no transaction at all - the
-- matching `actions` row carries tx_index NULL, source_id NULL, action_format 3.
-- source_id / signing_pubkey_id / block_index are always set by the indexer on
-- both paths (an eviction still names the evicted validator and its epoch-close
-- block), so they stay NOT NULL here same as `stakes`.
DROP TABLE IF EXISTS unstakes;
CREATE TABLE unstakes (
    action_index        BIGINT UNSIGNED NOT NULL,        -- FK to actions table (each UNSTAKE action gets its own row)
    source_id           BIGINT UNSIGNED NOT NULL,        -- FK to index_addresses (staking address; the evicted validator's, for a ROLLCALL eviction)
    signing_pubkey_id   BIGINT UNSIGNED NOT NULL,        -- FK to index_pubkeys (Ed25519 hot key)
    amount              VARCHAR(250) NOT NULL,           -- XCHAIN removed by this action
    cooldown_end_block  BIGINT UNSIGNED,
    status_id           BIGINT UNSIGNED,
    block_index         BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index       ON unstakes (action_index);
CREATE        INDEX source_id          ON unstakes (source_id);
CREATE        INDEX signing_pubkey_id  ON unstakes (signing_pubkey_id);

-- Contract-targeted UNSTAKE v1 (`contract_unstakes`; see db.js getContractUnstakes
-- and staking.js UNSTAKE, which LEFT JOINs it for every UNSTAKE lookup regardless
-- of variant). ROLLCALL evictions never write this table (they are capability-only,
-- see `unstakes` above); present here only so that join resolves instead of failing
-- on a missing table.
DROP TABLE IF EXISTS contract_unstakes;
CREATE TABLE contract_unstakes (
    action_index          BIGINT UNSIGNED NOT NULL,
    source_id             BIGINT UNSIGNED,
    signing_pubkey_id     BIGINT UNSIGNED,
    target_contract_index BIGINT UNSIGNED,
    tick_id                BIGINT UNSIGNED,
    amount                 VARCHAR(250),
    cooldown_end_block     BIGINT UNSIGNED,
    status_id              BIGINT UNSIGNED,
    block_index             BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index       ON contract_unstakes (action_index);
CREATE        INDEX source_id          ON contract_unstakes (source_id);
CREATE        INDEX signing_pubkey_id  ON contract_unstakes (signing_pubkey_id);

DROP TABLE IF EXISTS delegations;
CREATE TABLE delegations (
    action_index        BIGINT UNSIGNED NOT NULL,
    source_id           BIGINT UNSIGNED NOT NULL,        -- staking address
    signing_pubkey_id   BIGINT UNSIGNED NOT NULL,        -- FK to index_pubkeys
    status_id           BIGINT UNSIGNED,                 -- active/revoked
    block_index         BIGINT UNSIGNED NOT NULL,
    activation_block    BIGINT UNSIGNED NOT NULL DEFAULT 0,
    deactivation_block  BIGINT UNSIGNED
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index       ON delegations (action_index);
CREATE        INDEX source_id          ON delegations (source_id);

DROP TABLE IF EXISTS validator_rewards;
CREATE TABLE validator_rewards (
    id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    source_id           BIGINT UNSIGNED NOT NULL,        -- staking address
    signing_pubkey_id   BIGINT UNSIGNED NOT NULL,        -- FK to index_pubkeys
    reward_type         VARCHAR(20) NOT NULL,            -- 'oracle_base', 'attest_fee', 'anchor_<chain>', ...
    round_reference     BIGINT UNSIGNED,                 -- round number or attestation ref
    round_qualifier     BIGINT UNSIGNED NOT NULL DEFAULT 0, -- snapshot_block for 'anchor_archive', 0 otherwise; part of the reward's UNIQUE identity
    amount              VARCHAR(250) NOT NULL,
    block_index         BIGINT UNSIGNED NOT NULL,
    derive_block_index  BIGINT UNSIGNED DEFAULT NULL     -- creating block of a derived anchor/archive reward; rollback's second scoping key
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- round_qualifier belongs in the key, not only in the table: without it a reissued
-- MATCH_BATCH_SEQ round_reference collides across two snapshots, which is the exact
-- dedup failure the indexer migration exists to close. A fixture that dedups more
-- loosely than production hides that class of bug rather than reproducing it.
CREATE UNIQUE INDEX reward_unique     ON validator_rewards (source_id, signing_pubkey_id, reward_type, round_reference, round_qualifier);
CREATE        INDEX source_id         ON validator_rewards (source_id);

DROP TABLE IF EXISTS attests;
CREATE TABLE attests (
    action_index                  BIGINT UNSIGNED NOT NULL,   -- FK to actions (the ATTEST action that wrote this row)
    version                       TINYINT UNSIGNED NOT NULL,  -- 0=request, 1=response
    request_id                    CHAR(64) NOT NULL,          -- correlation key across v0/v1
    provider_id                   VARCHAR(32) NOT NULL,       -- e.g. 'http_get'
    contract_index                BIGINT UNSIGNED,            -- FK to contracts (which contract emitted the request)
    fee_payer_id                  BIGINT UNSIGNED,            -- FK to index_addresses
    payload                       MEDIUMTEXT,                 -- inlined request payload
    callback_method               VARCHAR(64),
    callback_params_json          TEXT,
    redundancy                    TINYINT UNSIGNED,
    deadline_block                BIGINT UNSIGNED,
    gas_escrow                    VARCHAR(60),
    fee_tick_id                   BIGINT UNSIGNED,
    fee_amount                    VARCHAR(60),
    request_status                ENUM('pending','fulfilled','expired','errored','rejected'),
    resolved_block                BIGINT UNSIGNED,
    responsible_set_json          MEDIUMTEXT,
    origin_chain                  VARCHAR(8),                 -- cross-chain relay: origin chain of a materialized/relay-eligible request
    origin_action_index           BIGINT UNSIGNED,            -- cross-chain relay: the origin chain's v0 action_index
    response_hash                 CHAR(64),
    response_payload              MEDIUMTEXT,
    response_status               ENUM('ok','timeout','no_quorum','provider_error','expired'),
    meta                          VARCHAR(256),
    validator_signatures          MEDIUMTEXT,                 -- JSON array of verified federation sigs
    callback_execute_action_index BIGINT UNSIGNED,
    batch_action_index            BIGINT UNSIGNED,            -- ATTEST v5/v6 batch that carried this response's body on chain; NULL until it lands, and NULL forever for a legacy-era response that was its own on-chain v1
    status_id                     BIGINT UNSIGNED,
    block_index                   BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index      ON attests (action_index);
CREATE        INDEX request_id_version ON attests (request_id, version);

DROP TABLE IF EXISTS deposits;
CREATE TABLE deposits (
    action_index        BIGINT UNSIGNED NOT NULL,
    contract_index      BIGINT UNSIGNED,
    source_id           BIGINT UNSIGNED NOT NULL,
    tick_id             BIGINT UNSIGNED,
    amount              VARCHAR(250) NOT NULL,
    status_id           BIGINT UNSIGNED,
    block_index         BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index   ON deposits (action_index);
CREATE        INDEX contract_index ON deposits (contract_index);

DROP TABLE IF EXISTS withdrawals;
CREATE TABLE withdrawals (
    action_index        BIGINT UNSIGNED NOT NULL,
    contract_index      BIGINT UNSIGNED,
    source_id           BIGINT UNSIGNED NOT NULL,
    tick_id             BIGINT UNSIGNED,
    amount              VARCHAR(250) NOT NULL,
    status_id           BIGINT UNSIGNED,
    block_index         BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index   ON withdrawals (action_index);
CREATE        INDEX contract_index ON withdrawals (contract_index);
