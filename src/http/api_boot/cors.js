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
 *
 * XChain Explorer - cross-origin policy
 *
 * One boot step of src/api.js, mounted after the security headers and before
 * the shedding guards, so a refused origin never costs a rate-limit slot.
 *
 ********************************************************************/

'use strict';

const cors = require('cors');

/**
 * Mount the CORS policy.
 *
 * Public read API: cross-origin GETs are the norm (docs examples, wallets,
 * third-party dashboards), so with nothing configured every origin is
 * admitted. Deployments that need to fence the API set EXPLORER_CORS_ORIGIN
 * to a comma-separated allowlist of exact origins.
 *
 * @param {object} app the express app
 * @param {object} configInfo src/config.js, for its live env view
 */
function applyCors(app, configInfo){
    const corsAllowlist = String(configInfo.env.EXPLORER_CORS_ORIGIN || '')
        .split(',').map(s => s.trim()).filter(s => s.length && s !== '*');
    app.use(cors({
        // Callback form rather than a static wildcard: an allowlisted deployment
        // reflects only listed origins, an open one reflects the caller's origin,
        // and requests without an Origin header (curl, same-origin) always pass.
        origin: (origin, cb) => {
            if (!origin || corsAllowlist.length === 0 || corsAllowlist.includes(origin)) return cb(null, true);
            return cb(null, false);
        },
        methods: ['GET', 'POST'],
    }));
}

module.exports = { applyCors };
