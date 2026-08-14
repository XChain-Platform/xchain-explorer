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
 * Shared CORS options for test-harness Express apps. Mirrors src/api.js's
 * production wiring (an allowlist-callback driven by EXPLORER_CORS_ORIGIN)
 * instead of a static `origin: '*'` literal, so every test bootstrap reads
 * the same way to both readers and CodeQL's permissive-CORS check as the
 * real server does. Unset EXPLORER_CORS_ORIGIN (the normal test case)
 * reflects every origin, matching the prior wildcard behavior exactly.
 */
function testCorsOptions() {
    const corsAllowlist = String(process.env.EXPLORER_CORS_ORIGIN || '')
        .split(',').map(s => s.trim()).filter(s => s.length && s !== '*');
    return {
        origin: (origin, cb) => {
            if (!origin || corsAllowlist.length === 0 || corsAllowlist.includes(origin)) return cb(null, true);
            return cb(null, false);
        },
        methods: ['GET', 'POST'],
    };
}

module.exports = { testCorsOptions };
