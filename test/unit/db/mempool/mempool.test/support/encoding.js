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

const { fs, path, sinon, expect, ChangeDetector, Broadcaster, envView, mkDb, SEND_ROW, MINT_ROW, TRASH_ROW, LEGACY_HEX_ROW, getDecoderPaths, loadCanonicalizer, makeEncodingFixture, readDecoderSite, readDecoderGate } = require('./helpers.js');

/******************************************************************
 * Cross-repo encoding pin
 *
 * The explorer's read and the decoder's write have to agree on how
 * mempool_transactions.data is encoded, and they live in two repos, so a
 * test inside either one alone cannot catch a one-sided change: that is
 * exactly how the explorer ended up hex-decoding a column the decoder had
 * started writing as text. These two tests drive the decoder's own
 * canonicalization into the explorer's own reader, and read the decoder's
 * write site directly, so moving either side turns this red.
 *
 * Skips when no sibling xchain-decoder checkout is present (always true in
 * the platform monorepo; the standalone-explorer CI job has no decoder).
 *****************************************************************/
describe("decoder mempool surface", () => {
    describe('decoder/explorer mempool encoding pin', () => {
        const { decoderSrc, hasDecoder } = getDecoderPaths();

        // The decoder's module tree is loaded here rather than inside the first case.
        // A synchronous require of it costs seconds on a cold venue, and mocha charges
        // that to whichever case runs first, so the file reddened on the clock with a
        // "Timeout exceeded" against a cross-repo parity assertion that had not moved.
        // A hook with its own budget absorbs the load; raising a per-test timeout would
        // only move the same cost somewhere else.
        let canonicalizeActionPayload = null;
        let decoderLoadFailed = false;
        before(function () {
            if (!hasDecoder) return;
            this.timeout(60000);
            ({ canonicalizeActionPayload, decoderLoadFailed } = loadCanonicalizer(decoderSrc));
        });

        it('the decoder-canonical stored form is what the explorer reader parses', function () {
            if (!hasDecoder || decoderLoadFailed) this.skip();
            const { strict, db, SAMPLES } = makeEncodingFixture();
            for (const wire of SAMPLES) {
                // Exactly what the decoder's mempool path writes to the column.
                const canonical = canonicalizeActionPayload(Buffer.from(wire, 'utf8'));
                const stored    = strict.decode(canonical.buffer);
                expect(stored, 'decoder stored form drifted from the UTF-8 ACTION string').to.equal(wire);

                const decoded = db.decodeMempoolRow({ tx_hash: 'aa11', source: 'srcAddr1', data: stored });
                expect(decoded, 'explorer could not read the decoder stored form for ' + wire).to.not.equal(null);
                expect(decoded.data).to.equal(wire);
                expect(decoded.action).to.equal(wire.split('|')[0]);
            }
        });

        it('the decoder mempool INSERT still passes the decoded string, not hex', function () {
            if (!hasDecoder) this.skip();
            // readDecoderSite/readDecoderGate each check the part file the decoder's
            // constructor/method split moved this text into before falling back to
            // the entry, so this pin holds whether the sibling checkout is at the
            // split or still at the pre-split layout it moved from; either miss
            // throws naming both paths it looked at, rather than reading stale text.
            const { site } = readDecoderSite(decoderSrc);
            // The decoder folded the mempool and confirmed-block writes into one
            // storage gate, so the UTF-8 decode moved out of this call site and into
            // buildStoredActionRecord. What this pin protects is unchanged: the column
            // still receives the decoded string. Assert the binding here and the decode
            // in the helper that now owns it, rather than the old inline variable.
            expect(site, 'decoder mempool INSERT no longer stores the shared storage-gate record')
                .to.match(/data:\s*stored\.data/);
            expect(site, 'decoder mempool payload no longer comes from the shared storage gate')
                .to.include('buildStoredActionRecord(');
            const { gate } = readDecoderGate(decoderSrc);
            expect(gate, 'decoder storage gate no longer produces the payload by a UTF-8 decode')
                .to.match(/decode\(\s*canonical\.buffer\s*\)/);
            expect(site, 'decoder mempool write reintroduced hex encoding; the explorer read must move with it')
                .to.not.match(/toString\(\s*['"]hex['"]\s*\)/);
        });
    });
});
