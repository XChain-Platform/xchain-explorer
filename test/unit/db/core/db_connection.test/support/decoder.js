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
 * Unit tests for Database connection management functions in src/db/index.js
 * Covers: constructor, setupConnectionPools, getConnection, releaseConnection
 */

'use strict';

const {
    sinon, expect, createConfigInfoStub, getFullConfig, Database, mockMariadb, setMockMariadb,
    createMockConnection, createMockPool, buildExplorer, freshDatabase, hubShapeConfig,
} = require('./helpers.js');


// The decoder JSON-RPC endpoint /api/status polls for chain_tip /
// chain_lag_blocks / decoder_health. Deriving it from the config the explorer
// already loads is what stops every coin reading 'unconfigured' on a
// deployment that never exported one DECODER_API_URL_<COIN>_<NETWORK> per
// chain.
function decoderTestsOne() {
    it('derives the endpoint from the hub-config host/port pair', async function () {
        const db = freshDatabase(null, hubShapeConfig());
        await db.setupConnectionPools();
        expect(db.decoderApiUrl['BTC']).to.equal('http://xchain-decoder-btc-mainnet:3002');
    });

    it('does NOT read a config.json decoder DB (host/port, no db_host) as an endpoint', async function () {
        // In config.json, host/port ARE the database, so treating them as an API
        // endpoint would point the health poll at MariaDB. Absent beats wrong:
        // the coin reports 'unconfigured' rather than a permanent 'unreachable'.
        const config = getFullConfig();
        config.BTC.mainnet.database.decoder = {
            host: '127.0.0.1', port: 3306, user: 'root', pass: 'pass',
            name: 'XChain_BTC_Mainnet_Decoder'
        };
        const db = freshDatabase(null, config);
        await db.setupConnectionPools();
        expect(db.decoderApiUrl).to.not.have.property('BTC');
    });

    it('honors an explicit api_url over the host/port pair', async function () {
        const config = hubShapeConfig();
        config.BTC.mainnet.database.decoder.api_url = 'http://decoder.internal:4002/';
        const db = freshDatabase(null, config);
        await db.setupConnectionPools();
        // Trailing slash trimmed: the connector POSTs to the URL as given.
        expect(db.decoderApiUrl['BTC']).to.equal('http://decoder.internal:4002');
    });

    it('honors an explicit api_host + api_port in the config.json shape', async function () {
        // The one-line way a config.json deployment (no hub) can wire the
        // endpoint beside the DB instead of exporting an env var per chain.
        const config = getFullConfig();
        config.BTC.mainnet.database.decoder = {
            host: '127.0.0.1', port: 3306, user: 'root', pass: 'pass',
            name: 'XChain_BTC_Mainnet_Decoder',
            api_host: '10.0.0.7', api_port: 3002
        };
        const db = freshDatabase(null, config);
        await db.setupConnectionPools();
        expect(db.decoderApiUrl['BTC']).to.equal('http://10.0.0.7:3002');
    });

    it('does not double-prefix a host that already carries a scheme', async function () {
        const config = hubShapeConfig();
        config.BTC.mainnet.database.decoder.host = 'https://decoder.example.com';
        const db = freshDatabase(null, config);
        await db.setupConnectionPools();
        expect(db.decoderApiUrl['BTC']).to.equal('https://decoder.example.com:3002');
    });

}


function decoderTestsTwo() {
    it('records no endpoint for a coin whose decoder entry carries none', async function () {
        // getFullConfig's decoder entries are DB-only (db_host/db_port, no
        // host/port), which is the pre-existing 'unconfigured' case.
        const db = freshDatabase();
        await db.setupConnectionPools();
        expect(db.decoderApiUrl).to.deep.equal({});
    });

    it('resets the endpoint map on each call so a removed endpoint stops being polled', async function () {
        const db = freshDatabase(null, hubShapeConfig());
        await db.setupConnectionPools();
        expect(db.decoderApiUrl['BTC']).to.be.a('string');
        // Re-enter with a config that no longer names an endpoint.
        db.configInfo = createConfigInfoStub(getFullConfig());
        await db.setupConnectionPools();
        expect(db.decoderApiUrl).to.not.have.property('BTC');
    });


}

module.exports = { decoderTestsOne, decoderTestsTwo };
