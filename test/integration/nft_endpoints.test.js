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
 * Integration tests: NFT display surfaces (protocol/NFT_Standard.md)
 *
 * Covers:
 *   - /{COIN}/api/tokens/null/nft + /{COIN}/explorer/tokens/null/nft:
 *     the NFT-pattern filter (DECIMALS=0 AND LOCK_MAX_SUPPLY=1)
 *   - /{COIN}/api/token/{tick}: decimals exposure for client classification
 *   - /{COIN}/api/file/{idx}/raw: non-gated FILE bytes resolved from the
 *     colocated decoder DB (TIS data_ref target), inline MIME whitelist,
 *     gated ciphertext passthrough, and the /{COIN}/nfts HTML page
 *
 * Boots a real Express app against a test MariaDB on port 3307.
 *
 * Run: npm run test:integration  (or: mocha --timeout 0 test/integration/nft-endpoints.test.js)
 */

'use strict';

const { expect }    = require('chai');
const supertest     = require('supertest');
const db            = require('./helpers/db-setup');
const { createApp } = require('./helpers/app-setup');

let request;

// PNG magic bytes (enough to assert byte-exact passthrough)
const PNG_BYTES  = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const HTML_BYTES = Buffer.from('<html><script>alert(1)</script></html>');
const CIPHERTEXT = Buffer.from('aabbccddeeff', 'hex');

const DECODER_DB = 'XChain_BTC_Regtest_Decoder';

before(async function () {
    this.timeout(30000);
    await db.setupDatabase();

    // --- NFT-pattern token seeds (on top of the baseline fixture) ----------
    // Baseline tokens are all divisible (decimals 8/4), so the nft filter
    // must return exactly the rows added here.
    await db.query(`INSERT IGNORE INTO index_tickers (id, tick) VALUES
        (90,'PEPEUNIQUE'), (91,'PEPEEDITION'), (92,'PEPESET'), (93,'PEPESET.ONE')`);
    await db.query(`INSERT IGNORE INTO index_mime_types (id, type) VALUES (2,'text/html')`);
    // actions rows ride on baseline transactions (tx 1-7 span blocks 1-4)
    await db.query(`INSERT IGNORE INTO actions (action_index, block_index, tx_index, tx_vout, action_id, action_format) VALUES
        (90,1,1,0,2,0), (91,1,2,0,2,0), (92,2,3,0,2,0), (93,2,4,0,2,0),
        (95,3,5,0,8,0), (97,4,7,0,8,0)`);
    await db.query(`INSERT IGNORE INTO tokens (id, tick_id, action_index, last_action_index, supply, max_supply, max_mint, decimals, description,
        lock_max_supply, lock_mint, lock_mint_supply, lock_max_mint, lock_description, lock_sleep, lock_callback, owner_id, coin_price, coin_floor) VALUES
        (90, 90, 90, 90, '1',   '1',   NULL, 0, 'ipfs:QmTestUnique',  1,0,0,0,1,0,0, 1, '0', '0'),
        (91, 91, 91, 91, '100', '100', NULL, 0, 'Edition of 100',     1,0,0,0,0,0,0, 1, '0', '0'),
        (92, 92, 92, 92, '1',   '1',   NULL, 0, 'Collection parent',  1,0,0,0,0,0,0, 1, '0', '0'),
        (93, 93, 93, 93, '1',   '1',   NULL, 0, 'Collection item',    1,0,0,0,0,0,0, 1, '0', '0')`);

    // --- FILE seeds ---------------------------------------------------------
    // action 95 = non-gated PNG (tx 5, hash id 5); action 97 = non-gated HTML
    // (tx 7, hash id 7). action 97 must NOT be served inline; action 96 = gated file.
    await db.query(`INSERT IGNORE INTO files (action_index, name, title, type_id, memo_id, status_id) VALUES
        (95, 'pepe.png',  'Pepe Artwork', 1, NULL, 1),
        (97, 'page.html', 'Sketchy HTML', 2, NULL, 1)`);
    await db.query(`CREATE TABLE IF NOT EXISTS gated_files (
        action_index        BIGINT UNSIGNED NOT NULL,
        gate_ticker         VARCHAR(250) NOT NULL,
        encryption_method   TINYINT UNSIGNED NOT NULL,
        key_hash            CHAR(64) NOT NULL,
        status_id           BIGINT UNSIGNED,
        raw_data            MEDIUMBLOB,
        UNIQUE INDEX action_index (action_index)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci`);
    await db.query(`INSERT IGNORE INTO gated_files (action_index, gate_ticker, encryption_method, key_hash, status_id, raw_data) VALUES
        (96, 'PEPEUNIQUE', 1, '${'a'.repeat(64)}', 1, ?)`, [CIPHERTEXT]);

    // --- Decoder DB (colocated, same creds; matches src/config behavior) ---
    // The decoder numbers tx_index independently of the indexer, so the seeds
    // deliberately use DIFFERENT tx_index values (505/507). The explorer must
    // match rows by tx HASH, never by id.
    await db.query(`CREATE DATABASE IF NOT EXISTS ${DECODER_DB}`);
    await db.query(`CREATE TABLE IF NOT EXISTS ${DECODER_DB}.index_transactions (
        id   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        hash VARCHAR(250)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci`);
    await db.query(`CREATE TABLE IF NOT EXISTS ${DECODER_DB}.transactions (
        tx_index       BIGINT UNSIGNED PRIMARY KEY,
        tx_hash_id     BIGINT UNSIGNED,
        block_index    BIGINT UNSIGNED,
        source_id      BIGINT UNSIGNED,
        destination_id BIGINT UNSIGNED,
        amount         BIGINT,
        fee            BIGINT,
        data           MEDIUMTEXT,
        raw_data       MEDIUMBLOB
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci`);
    await db.query(`INSERT IGNORE INTO ${DECODER_DB}.index_transactions (id, hash) VALUES
        (505, 'eee5555555555555555555555555555555555555555555555555555555555555'),
        (507, 'ggg7777777777777777777777777777777777777777777777777777777777777')`);
    await db.query(`INSERT IGNORE INTO ${DECODER_DB}.transactions (tx_index, tx_hash_id, block_index, data, raw_data) VALUES
        (505, 505, 3, 'FILE|0|pepe.png', ?),
        (507, 507, 4, 'FILE|0|page.html', ?)`, [PNG_BYTES, HTML_BYTES]);

    const { app } = await createApp();
    request = supertest(app);
});

after(async function () {
    this.timeout(10000);
    await db.query(`DROP DATABASE IF EXISTS ${DECODER_DB}`);
    await db.teardownDatabase();
});

// nft search type removed with the NFT UI; the classifier is client-side only
// (sdk.nft.isNft via content/js/xchain.js), so the server rejects type=nft
describe('NFT token filter (type=nft) is not a supported type', function () {

    it('GET /RBTC/api/tokens/null/nft is rejected', async function () {
        const res = await request.get('/RBTC/api/tokens/null/nft');
        expect(res.status).to.equal(404);
    });

});

describe('Token detail decimals exposure', function () {

    it('GET /RBTC/api/token/PEPEUNIQUE exposes info.decimals + supply.decimals', async function () {
        const res = await request.get('/RBTC/api/token/PEPEUNIQUE');
        expect(res.status).to.equal(200);
        expect(res.body.info.decimals).to.equal(0);
        expect(res.body.supply.decimals).to.equal(0);
        expect(res.body.locks.max_supply).to.equal(true);
        expect(res.body.info).to.not.have.property('callback_decimals');
    });

});

describe('Raw FILE endpoint', function () {

    it('serves non-gated image bytes inline with the declared MIME type + nosniff', async function () {
        const res = await request.get('/RBTC/api/file/95/raw').responseType('blob');
        expect(res.status).to.equal(200);
        expect(res.headers['content-type']).to.include('image/png');
        expect(res.headers['x-content-type-options']).to.equal('nosniff');
        expect(res.headers['cache-control']).to.include('immutable');
        expect(Buffer.compare(res.body, PNG_BYTES)).to.equal(0);
    });

    it('forces non-media MIME types (text/html) to download as an opaque attachment', async function () {
        const res = await request.get('/RBTC/api/file/97/raw').responseType('blob');
        expect(res.status).to.equal(200);
        expect(res.headers['content-type']).to.include('application/octet-stream');
        expect(res.headers['content-disposition']).to.equal('attachment');
        expect(res.headers['x-content-type-options']).to.equal('nosniff');
        expect(Buffer.compare(res.body, HTML_BYTES)).to.equal(0);
    });

    it('still serves gated ciphertext as an octet-stream (unchanged contract)', async function () {
        const res = await request.get('/RBTC/api/file/96/raw').responseType('blob');
        expect(res.status).to.equal(200);
        expect(res.headers['content-type']).to.include('application/octet-stream');
        expect(Buffer.compare(res.body, CIPHERTEXT)).to.equal(0);
    });

    it('returns 404 JSON for an unknown FILE action', async function () {
        const res = await request.get('/RBTC/api/file/424242/raw');
        expect(res.status).to.equal(404);
        expect(res.body).to.have.property('error');
    });

    it('returns 400 JSON for a non-numeric action_index', async function () {
        const res = await request.get('/RBTC/api/file/not-a-number/raw');
        expect(res.status).to.equal(400);
        expect(res.body).to.have.property('error');
    });

});
