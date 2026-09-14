'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const {
    ACTION_REF_PATTERN, expect, execCmdText, iconSuite, loadIconDownloader,
    makeExecStub, makeExplorer, makeMockConn, makeMockPool, makeStubs, path,
    setClock, sinon, tickClock,
} = require('./helpers.js');

{

    iconSuite('_listFlavors()', function () {
        it('returns [] when pools is null', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer({}, null);
            explorer.db = null;

            const d = new IconDownloader(explorer);
            const result = await d.listFlavors();
            expect(result).to.deep.equal([]);
        });

        it('returns [] when getConfig returns null', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            explorer.configInfo.getConfig.resolves(null);

            const d = new IconDownloader(explorer);
            const result = await d.listFlavors();
            expect(result).to.deep.equal([]);
        });

        it('skips non-object top-level keys', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            explorer.configInfo.getConfig.resolves({
                COIN_NETWORKS: ['BTC'],
                API: 'something',
                null_val: null,
            });

            const d = new IconDownloader(explorer);
            const result = await d.listFlavors();
            expect(result).to.deep.equal([]);
        });

    });

    iconSuite('_listFlavors()', function () {
        it('returns mainnet flavor with bare poolKey (no prefix)', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const pool = makeMockPool(makeMockConn([]));
            const explorer = makeExplorer({
                BTC: { mainnet: { database: { indexer: 'xchain_btc' } } },
            }, { BTC: { pool } });

            const d = new IconDownloader(explorer);
            const result = await d.listFlavors();

            expect(result).to.have.length(1);
            expect(result[0].coin).to.equal('BTC');
            expect(result[0].network).to.equal('mainnet');
            expect(result[0].poolKey).to.equal('BTC');
            expect(result[0].pool).to.equal(pool);
        });

        it('prefixes testnet poolKey with T', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const pool = makeMockPool(makeMockConn([]));
            const explorer = makeExplorer({
                BTC: { testnet: { database: { indexer: 'xchain_tbtc' } } },
            }, { TBTC: { pool } });

            const d = new IconDownloader(explorer);
            const result = await d.listFlavors();

            expect(result).to.have.length(1);
            expect(result[0].poolKey).to.equal('TBTC');
        });

        it('prefixes regtest poolKey with R', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const pool = makeMockPool(makeMockConn([]));
            const explorer = makeExplorer({
                BTC: { regtest: { database: { indexer: 'xchain_rbtc' } } },
            }, { RBTC: { pool } });

            const d = new IconDownloader(explorer);
            const result = await d.listFlavors();

            expect(result[0].poolKey).to.equal('RBTC');
        });

    });

    iconSuite('_listFlavors()', function () {
        it('skips networks missing indexer config', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer({
                BTC: { mainnet: { database: {} } },   // no indexer key
            }, { BTC: { pool: makeMockPool(makeMockConn([])) } });

            const d = new IconDownloader(explorer);
            const result = await d.listFlavors();
            expect(result).to.deep.equal([]);
        });

        it('skips flavors where pool is missing', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer({
                BTC: { mainnet: { database: { indexer: 'xchain_btc' } } },
            }, {
                // BTC pool is absent from pools; pools has LTC instead
                LTC: { pool: makeMockPool(makeMockConn([])) },
            });

            const d = new IconDownloader(explorer);
            const result = await d.listFlavors();
            expect(result).to.deep.equal([]);
        });

        it('returns multiple flavors across coins and networks', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const btcPool  = makeMockPool(makeMockConn([]));
            const ltcPool  = makeMockPool(makeMockConn([]));
            const tbtcPool = makeMockPool(makeMockConn([]));

            const explorer = makeExplorer({
                BTC: { mainnet: { database: { indexer: 'i1' } } },
                LTC: { mainnet: { database: { indexer: 'i2' } } },
            }, {
                BTC:  { pool: btcPool },
                LTC:  { pool: ltcPool },
                TBTC: { pool: tbtcPool },
            });

            const d = new IconDownloader(explorer);
            const result = await d.listFlavors();

            const coins = result.map(f => f.coin);
            expect(coins).to.include('BTC');
            expect(coins).to.include('LTC');
            expect(result).to.have.length(2);
        });
    });
}

{

    iconSuite('_discover()', function () {
        it('runs INSERT IGNORE and UPDATE queries with correct SQL fragments', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            const conn = makeMockConn([[], [], []]);
            await d.discover(conn);

            expect(conn.query.callCount).to.equal(3);
            const firstSql  = conn.query.firstCall.args[0];
            const secondSql = conn.query.secondCall.args[0];
            const thirdSql  = conn.query.thirdCall.args[0];

            expect(firstSql).to.include('INSERT IGNORE INTO icons');
            expect(firstSql).to.include('pending');

            expect(secondSql).to.include('UPDATE icons');
            expect(secondSql).to.include('stale');
            expect(secondSql).to.include('<=>');

            // The one-shot re-stale for tokens marked icon-less before the resolver
            // learned the on-chain `action:` scheme. Description-hash drift (the second
            // statement) never reaches them: an on-chain TIS description is usually
            // description-locked, so without this the fix is invisible on every existing
            // row. Its predicate is the resolver's own grammar rather than an
            // `action:` prefix test, which is what keeps it one-shot (#5290, below).
            expect(thirdSql).to.include('UPDATE icons');
            expect(thirdSql).to.include('stale');
            expect(thirdSql).to.include('icon_hash IS NULL');
            expect(thirdSql).to.include("REGEXP '" + ACTION_REF_PATTERN + "'");
            expect(thirdSql).to.not.include("LIKE 'action:%'");

            // The binary conversion is load-bearing, not cosmetic: under the
            // column's own utf8mb4_general_ci collation, LOWER() folds U+0130 into
            // plain 'i' and widens the predicate past anything the resolver can
            // resolve (#5290). Proven against a real engine in
            // test/conformance/icon-restale-predicate.test.js.
            expect(thirdSql).to.include('CONVERT(TRIM(t.description) USING binary)');
            expect(thirdSql, 'no case folding may sit between the column and the grammar')
                .to.not.match(/LOWER\s*\(/i);
        });
    });
}
