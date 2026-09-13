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
 * Unit tests for the widened mempool seen-state in ChangeDetector: per coin,
 * `seenHashes` is a Map<tx_hash, {source, action, data}> instead of a Set, so a
 * removal can still name the tx's parties and its action family after its row
 * has left the table (spec wallet-unconfirmed-and-sounds, M1.1 / I-44).
 *
 * The Map stores the RAW action string rather than a party list on purpose:
 * ChangeDetector cannot see subscribers, so the Broadcaster re-runs the
 * shared matcher against current ones at removal time.
 *
 * The subtle bit this file guards is the OUT-OF-WINDOW carry-forward: the
 * source read is ORDER BY tx_hash LIMIT 500, so a seen hash sorting above the
 * largest hash read is unknown, not gone. Widening the container must not
 * lose that, nor the parties of a carried-forward hash.
 */

'use strict';

const sinon          = require('sinon');
const { expect }     = require('chai');
const Database       = require('../../../src/db.js');
const Utility        = require('../../../src/utility.js');
const ChangeDetector = require('../../../src/ws/ChangeDetector.js');

// A db with the real decodeMempoolRow over a scripted window sequence.
function mkDb(windows) {
    const db = Object.create(Database.prototype);
    db.util = new Utility();
    db.getDecoderMempoolRows = sinon.stub();
    windows.forEach((rows, i) => db.getDecoderMempoolRows.onCall(i).resolves(rows));
    db.getDecoderMempoolRows.resolves([]);
    return db;
}

function mkDetector(db) {
    const cd = new ChangeDetector({ db, pollInterval: 999999 });
    cd.mempoolState.RBTC = { seenHashes: new Map(), initialized: false };
    return cd;
}

const SEND_ROW  = { tx_hash: 'aa11', source: 'srcAddr', data: 'SEND|0|TOK|5|^42|memo', first_seen: 1756200000 };
const MINT_ROW  = { tx_hash: 'bb22', source: 'otherAddr', data: 'MINT|0|OTHER|9' };
const TRASH_ROW = { tx_hash: 'cc33', source: 'thirdAddr', data: 'zz-not-an-action-!!' };

describe('ChangeDetector mempool seen-state Map (M1.1)', () => {

    it('starts a coin with a Map, not a Set', () => {
        const cd = new ChangeDetector({ db: mkDb([]), pollInterval: 999999 });
        cd.start(['RBTC']);
        cd.stop();
        expect(cd.mempoolState.RBTC.seenHashes).to.be.instanceOf(Map);
    });

    it('seeds the Map on the first poll WITHOUT emitting', async () => {
        const cd = mkDetector(mkDb([[SEND_ROW]]));
        const seen = [], removed = [];
        cd.on('mempool_action',  (c, r) => seen.push(r));
        cd.on('mempool_removed', (c, r) => removed.push(r));

        await cd._checkMempoolForCoin('RBTC');
        expect(seen).to.deep.equal([]);
        expect(removed).to.deep.equal([]);
        expect(cd.mempoolState.RBTC.seenHashes.get('aa11'))
            .to.deep.equal({ source: 'srcAddr', action: 'SEND', data: 'SEND|0|TOK|5|^42|memo' });
    });

    it('carries source + the action name + the raw action string on mempool_removed', async () => {
        const cd = mkDetector(mkDb([[SEND_ROW, MINT_ROW], [MINT_ROW]]));
        const removed = [];
        cd.on('mempool_removed', (coin, row) => removed.push(row));

        await cd._checkMempoolForCoin('RBTC');                      // seed
        await cd._checkMempoolForCoin('RBTC');                      // SEND_ROW gone
        expect(removed).to.deep.equal([
            { tx_hash: 'aa11', source: 'srcAddr', action: 'SEND', data: 'SEND|0|TOK|5|^42|memo' }
        ]);
    });

    // A garbage row never emits a mempool_action (it does not decode), but its
    // disappearance still emits a removal, and that frame's shape must not
    // depend on decodability.
    it('emits a removal for an undecodable row, with a null action name and string', async () => {
        const cd = mkDetector(mkDb([[TRASH_ROW], []]));
        const seen = [], removed = [];
        cd.on('mempool_action',  (c, r) => seen.push(r));
        cd.on('mempool_removed', (c, r) => removed.push(r));

        await cd._checkMempoolForCoin('RBTC');                      // seed
        await cd._checkMempoolForCoin('RBTC');
        expect(seen).to.deep.equal([]);
        expect(removed).to.deep.equal([{ tx_hash: 'cc33', source: 'thirdAddr', action: null, data: null }]);
    });

    it('does not re-decode or re-announce a row that is still in the window', async () => {
        const db = mkDb([[SEND_ROW], [SEND_ROW, MINT_ROW]]);
        const cd = mkDetector(db);
        sinon.spy(db, 'decodeMempoolRow');
        const seen = [];
        cd.on('mempool_action', (c, r) => seen.push(r.tx_hash));

        await cd._checkMempoolForCoin('RBTC');                      // seed: decodes aa11
        await cd._checkMempoolForCoin('RBTC');                      // aa11 known, bb22 new
        expect(seen).to.deep.equal(['bb22']);
        expect(db.decodeMempoolRow.callCount).to.equal(2);          // not 3
    });

    // Regression guard on the out-of-window logic (unchanged by the widening).
    it('carries an above-window hash forward WITH its parties instead of removing it', async () => {
        const mk = (i) => ({ tx_hash: 'h' + String(i).padStart(4, '0'), source: 's' + i, data: 'MINT|0|TOK|1' });
        const first   = Array.from({ length: 500 }, (_, i) => mk(i * 2));   // h0000..h0998
        const shifted = Array.from({ length: 500 }, (_, i) => mk(i));       // h0000..h0499
        const cd = mkDetector(mkDb([first, shifted, first]));
        const removed = [], seen = [];
        cd.on('mempool_removed', (c, r) => removed.push(r.tx_hash));
        cd.on('mempool_action',  (c, r) => seen.push(r.tx_hash));

        await cd._checkMempoolForCoin('RBTC');                      // seed
        await cd._checkMempoolForCoin('RBTC');                      // window shifted down
        expect(removed).to.deep.equal([]);                          // above the covered bound: unknown, not gone
        expect(seen.length).to.equal(250);
        // The carried-forward entries keep their parties, so a removal announced
        // on a later poll can still name them.
        expect(cd.mempoolState.RBTC.seenHashes.get('h0998'))
            .to.deep.equal({ source: 's998', action: 'MINT', data: 'MINT|0|TOK|1' });

        await cd._checkMempoolForCoin('RBTC');                      // window shifts back over them
        expect(seen.length).to.equal(250);                          // carried forward: not re-announced
        expect(removed.length).to.equal(250);                       // the odd low hashes are now genuinely gone
        expect(removed.every((h) => Number(h.slice(1)) % 2 === 1)).to.equal(true);
    });

    it('emits a removal for every missing hash when the window is short of the cap', async () => {
        const cd = mkDetector(mkDb([[SEND_ROW, MINT_ROW, TRASH_ROW], [SEND_ROW]]));
        const removed = [];
        cd.on('mempool_removed', (c, r) => removed.push(r.tx_hash));

        await cd._checkMempoolForCoin('RBTC');
        await cd._checkMempoolForCoin('RBTC');
        expect(removed.sort()).to.deep.equal(['bb22', 'cc33']);
    });
});
