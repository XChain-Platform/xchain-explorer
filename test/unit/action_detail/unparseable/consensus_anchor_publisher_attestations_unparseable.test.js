/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 *********************************************************************/

'use strict';

const { expect } = require('chai');
const { ANCHOR } = require('../../../../src/action-detail/consensus.js');

describe('ANCHOR publisher attestations parsing', () => {
    it('marks malformed JSON as unparseable before normalizing it', () => {
        const data = { publisher_attestations: '{' };

        ANCHOR.afterMain({ action_index: 17 }, data);

        expect(data.publisher_attestations).to.deep.equal([]);
        expect(data.publisher_attestations_unparseable).to.equal(true);
    });

    it('preserves a valid publisher attestation array without a flag', () => {
        const attestations = [{ pubkey: 'publisher-key', sig: 'publisher-signature' }];
        const data = { publisher_attestations: JSON.stringify(attestations) };

        ANCHOR.afterMain({ action_index: 18 }, data);

        expect(data.publisher_attestations).to.deep.equal(attestations);
        expect(data.publisher_attestations_unparseable).to.not.be.ok;
    });

    it('normalizes absent and null attestations without a flag', () => {
        for (const data of [{}, { publisher_attestations: null }]) {
            ANCHOR.afterMain({ action_index: 19 }, data);

            expect(data.publisher_attestations).to.deep.equal([]);
            expect(data.publisher_attestations_unparseable).to.not.be.ok;
        }
    });
});
