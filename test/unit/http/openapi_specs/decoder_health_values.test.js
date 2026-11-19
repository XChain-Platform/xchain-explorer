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
 * Every decoder_health value the status reader itself sets must be named in
 * the published spec, so a consumer switching on the documented set is not
 * handed a value the spec never listed.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const STATUS_SRC = fs.readFileSync(path.join(ROOT, 'src/db/readers/entities/status.js'), 'utf8');
const SPECS = {
    'docs/openapi.json': JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/openapi.json'), 'utf8')),
    'src/content/json/xchain-platform-api.json':
        JSON.parse(fs.readFileSync(path.join(ROOT, 'src/content/json/xchain-platform-api.json'), 'utf8'))
};

function producedValues() {
    const lines = STATUS_SRC.split('\n').filter(line =>
        /decoder_health\[code\]\s*=/.test(line) || /return 'reorg-halt/.test(line));
    const values = new Set();
    for(const line of lines)
        for(const match of line.matchAll(/'([a-z]+(?:-[a-z]+)*)'/g)) values.add(match[1]);
    return [...values];
}

function findDescription(node) {
    if(!node || typeof node !== 'object') return null;
    if(node.decoder_health && typeof node.decoder_health.description === 'string')
        return node.decoder_health.description;
    for(const child of Object.values(node)) {
        const found = findDescription(child);
        if(found) return found;
    }
    return null;
}

describe('decoder_health values in the published specs', function () {
    it('finds the values the status reader sets, so the check below cannot pass on an empty set', function () {
        const values = producedValues();
        expect(values).to.include.members(['unconfigured', 'unreachable', 'rate-limited', 'node-stale',
            'reorg-halt-parked', 'reorg-halted', 'reorg-halt-unverified']);
    });

    for(const [name, spec] of Object.entries(SPECS)) {
        it('names every produced value in the ' + name + ' decoder_health description', function () {
            const description = findDescription(spec);
            expect(description, 'decoder_health description present').to.be.a('string');
            const missing = producedValues().filter(value => !description.includes("'" + value + "'"));
            expect(missing).to.deep.equal([]);
        });
    }
});
