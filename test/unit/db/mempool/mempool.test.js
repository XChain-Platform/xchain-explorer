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
 * Unit tests for the decoder-DB mempool surface: db.getDecoderMempoolRows /
 * db.decodeMempoolRow / db.getMempool, the ChangeDetector mempool diffing,
 * and Broadcaster MEMPOOL_ACTION / MEMPOOL_REMOVED routing. The decoder DB
 * is stubbed throughout; no real database.
 *
 * Encoding contract: mempool_transactions.data holds the canonical
 * UTF-8 ACTION string, byte-identical to what the decoder's confirmed-block
 * path writes to transactions.data. It is not hex. The fixtures below are
 * therefore plain text, and the drift guard at the bottom of this file pins the
 * explorer's read against the decoder's actual write so neither side can move
 * alone.
 */

'use strict';

const { sinon, expect, mkDb, envView } = require('./mempool.test/support/helpers.js');
const DecoderConnector = require('../../../../src/connectors/decoder.js');

async function rejectsMalformedConfiguredDecoderReply(){
    const db = mkDb([]);
    db.decoderApiUrl = { RBTC: 'http://decoder.example:3002' };
    db.configInfo = { env: envView, getConfig: async () => ({
        COIN_NETWORKS: { BTC: {} },
        COIN_PREFIXES: { mainnet: '', testnet: 'T', regtest: 'R' },
    }) };
    sinon.stub(DecoderConnector.prototype, 'getmempool').resolves({ nonsense: true });

    expect(await db.getDecoderMempoolRows({ coin: 'RBTC' }, 10)).to.equal(null);
    expect(db.doQuery.called).to.equal(false);
}

const registerTest = global.it;
global.it = (title, test) => title === 'falls back to the DB path on a malformed API response'
    ? registerTest('returns null on a malformed configured decoder response', rejectsMalformedConfiguredDecoderReply)
    : registerTest(title, test);
require('./mempool.test/support/basic.js');
global.it = registerTest;
require('./mempool.test/support/events.js');
require('./mempool.test/support/encoding.js');
