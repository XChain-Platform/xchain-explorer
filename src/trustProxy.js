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
 * XChain Explorer - proxy-hop policy for the HTTP app
 *
 * The topology this number describes: Apache runs on the same host as the
 * explorer and reverse-proxies to it, and mod_proxy APPENDS the connection's
 * peer address to X-Forwarded-For. One trusted hop therefore means "take the
 * entry the fronting proxy appended", which is the only entry in the chain the
 * explorer did not receive from the caller. Everything to its left is
 * client-supplied and is ignored.
 *
 * That appended entry is whichever address opened the connection to the proxy,
 * so behind a CDN it is the CDN's edge address. A proxy configured to resolve
 * the real visitor before it forwards makes the same appended entry the
 * visitor, and every per-IP limiter re-keys onto real clients with NO code
 * change here. The hop count stays 1 either way.
 *
 * Boolean `true` would trust the whole chain and let any caller spoof their
 * address past the per-IP limiters (express-rate-limit's
 * ERR_ERL_PERMISSIVE_TRUST_PROXY), so the value is deliberately the number 1.
 *
 * The WebSocket upgrade is handled on the raw HTTP server, where Express's
 * trust-proxy setting does not apply at all, so src/ws/WebSocketServer.js
 * resolves the same address by hand in _clientIp using WS_TRUST_PROXY_HOPS
 * (default 1). The two must move together: a change here without the matching
 * change there splits HTTP and WebSocket onto different client identities.
 *
 ********************************************************************/

'use strict';

// Trusted proxy hops in front of the Express app. See the header for why 1,
// and why it does not change when the proxy starts resolving real clients.
const HTTP_TRUST_PROXY_HOPS = 1;

// Apply the hop policy to an Express app. Exported as a function rather than
// inlined at the call site so the seam is testable: the app factory lives
// inside startApi(), which cannot be constructed in a unit test.
function applyTrustProxy(app) {
    app.set('trust proxy', HTTP_TRUST_PROXY_HOPS);
    return app;
}

module.exports = { HTTP_TRUST_PROXY_HOPS, applyTrustProxy };
