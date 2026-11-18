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
 ********************************************************************/

'use strict';

// The chaos harnesses boot the explorer without createApp, which a unit test
// cannot load. They must still run behind production's own body steps in
// production's order, never a literal express.json(): that is the ingress the
// load results are meant to describe. The behaviour of the steps themselves is
// pinned in json_body.test.js; this pins that each harness mounts them.

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const TEST_ROOT = path.resolve(__dirname, '..', '..', '..');
const HARNESSES = [
    'chaos/helpers/chaos-setup.js',
    'chaos/api_overload.test.js'
];

describe('chaos harness ingress', function () {
    for(const relative of HARNESSES) {
        describe(relative, function () {
            const source = fs.readFileSync(path.join(TEST_ROOT, relative), 'utf8');
            const at = needle => source.indexOf(needle);

            it('mounts no bare express.json parser', function () {
                expect(source).to.not.match(/express\.json\(/);
            });

            it('mounts CORS, then the production body ceiling, then the explorer, then the refusal handler', function () {
                const order = ['app.use(cors(', 'applyJsonBody(app, XChainExplorer)',
                    'new XChainExplorer(', 'applyBodyErrorHandler(app)'].map(at);
                expect(order.every(index => index >= 0), 'every step is present: ' + order.join(',')).to.equal(true);
                expect(order).to.deep.equal([...order].sort((a, b) => a - b));
            });

            it('mounts the limiter ahead of the body parser, so a throttled body is never read', function () {
                expect(at('rateLimit({'), 'limiter is mounted').to.be.at.least(0);
                expect(at('rateLimit({')).to.be.below(at('applyJsonBody(app, XChainExplorer)'));
            });
        });
    }
});
