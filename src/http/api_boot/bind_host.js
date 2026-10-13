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
 * XChain Explorer - the interface both API listeners bind
 *
 * Express trusts one proxy hop (src/http/trust_proxy.js), which is only safe
 * when the fronting proxy is the sole thing that can open a connection: any
 * other peer could send its own X-Forwarded-For and pick its rate-limit bucket.
 * Binding loopback by default makes that true on a host install, where Apache
 * on the same box proxies to 127.0.0.1. A container has to listen on every
 * interface for its published port to reach it, so the Dockerfile sets
 * EXPLORER_BIND_HOST=0.0.0.0 for every launch path of the image.
 *
 ********************************************************************/

'use strict';

// The literal address, not "localhost", which can resolve to ::1 while the
// proxy targets 127.0.0.1.
const DEFAULT_BIND_HOST = '127.0.0.1';

/**
 * The host both listeners pass to listen().
 * An empty value counts as unset: listen() reads an empty host as every
 * interface, which would quietly undo the loopback default.
 *
 * @param {object} env the config env view (configInfo.env)
 * @returns {string} the address to bind
 */
function resolveBindHost(env){
    const host = env.EXPLORER_BIND_HOST;
    return typeof host === 'string' && host.trim() !== '' ? host.trim() : DEFAULT_BIND_HOST;
}

module.exports = { DEFAULT_BIND_HOST, resolveBindHost };
