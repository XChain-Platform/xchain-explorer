'use strict';

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
 * Security tests: the CSP and the comments that describe it
 *
 * The served Content-Security-Policy allows inline script on purpose (the
 * per-page $(document).ready() blocks need it), so renderer-side escaping is
 * the only defense against stored text. A comment claiming the policy forbids
 * inline script would mislead a reviewer into trusting a defense that is not
 * there, so the comment in the component runtime must not contradict the
 * policy the server actually sends.
 *
 *********************************************************************/

const fs         = require('fs');
const path       = require('path');
const { expect } = require('chai');
const { applySecurityHeaders } = require('../../src/http/api_boot/security_headers.js');

// Runs the real header middleware over a fake response and returns the CSP it sets
function servedCsp() {
    let mw;
    applySecurityHeaders({ use: (fn) => { mw = fn; } }, { env: {} });
    const headers = {};
    const res = {
        setHeader: (k, v) => { headers[String(k).toLowerCase()] = v; },
        getHeader: (k) => headers[String(k).toLowerCase()],
        removeHeader: (k) => { delete headers[String(k).toLowerCase()]; }
    };
    mw({ headers: {} }, res, () => {});
    return headers['content-security-policy'];
}

describe('Security: CSP inline-script allowance matches its documentation', function () {

    it('the served policy allows inline script in script-src', function () {
        const csp = servedCsp();
        const scriptSrc = csp.split(';').find((d) => d.startsWith('script-src '));
        expect(scriptSrc).to.include("'unsafe-inline'");
    });

    it('components.js does not claim the policy forbids inline script', function () {
        const src = fs.readFileSync(path.join(__dirname, '../../src/content/js/components.js'), 'utf8');
        expect(src).to.not.match(/CSP[^.]*forbids inline script/);
        expect(src).to.not.match(/already forbids inline script/);
        expect(src).to.not.match(/Content-Security-Policy that already forbids/);
        expect(src).to.include('application/json');
    });
});
