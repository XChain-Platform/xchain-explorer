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
 * XChain Explorer - relay egress
 *
 * GET /{COIN}/relay: the one outbound fetch the explorer makes on a page's behalf,
 * with the SSRF guard that decides what it may connect to.
 *
 * Authored as a class body and installed onto XChainExplorer.prototype by
 * explorer/install.js, so `this` is the explorer instance at call time.
 *
 ********************************************************************/

'use strict';

const path      = require('path');
const net       = require('net');
const ssrfGuard = require('../http/ssrf_guard.js');

// The entry file's own `axios` and `dns`, handed over at install time rather than
// required here. The SSRF suites build the explorer through proxyquire with both
// replaced in XChainExplorer.js's require map; a second require in this file would
// resolve the real modules and let a guard test fetch the live network.
let axios = null;
let dns   = null;

function useHostBindings(host){
    axios = host.axios;
    dns   = host.dns;
}

class RelayEgress {

    // SSRF guard helper: classify a resolved IP literal as a private, loopback,
    // link-local, CGNAT, unique-local or cloud-metadata address that the /relay
    // endpoint must refuse to connect to. Delegates to the canonical classifier
    // in http/ssrf_guard.js so the /relay and IconDownloader egress paths share one
    // range list instead of drifting apart.
    isPrivateAddress(ip){
        return ssrfGuard.isPrivateAddress(ip);
    }

    // SSRF guard: a dns.lookup-compatible shim handed to axios so the address it
    // is about to connect to is checked against isPrivateAddress. Rejecting here
    // (rather than re-resolving separately) means there is no gap between the
    // check and the connection, closing the DNS-name / DNS-rebinding bypass of
    // the literal hostname blocklist.
    ssrfSafeLookup(hostname, options, callback){
        if(typeof options === 'function'){ callback = options; options = {}; }
        dns.lookup(hostname, options, (err, address, family) => {
            if(err) return callback(err);
            let entries = Array.isArray(address) ? address : [{ address, family }];
            for(let e of entries){
                if(this.isPrivateAddress(e.address)){
                    let denied = new Error('Destination resolves to a non-permitted address');
                    denied.code = 'RELAY_DENIED';
                    return callback(denied);
                }
            }
            callback(null, address, family);
        });
    }

    // RELAY request handler: fetches remote token content a page cannot fetch
    // itself, because relaying keeps it on the explorer's own https and most .json
    // hosts send no Access-Control-Allow-Origin, without which a browser refuses.
    async processRelayRequest(req, res){
        // Nothing to relay without a url parameter.
        if(!this.util.isNull(req.query.url)){
            try {
                // Parse and validate the requested URL.
                const parsed = new URL(req.query.url);

                // Every destination check in one place, in its original order, so a
                // refusal keeps the status and code it always had.
                const refusal = this.relayDestinationRefusal(parsed);
                if(refusal)
                    return res.status(refusal.status).json(refusal.body);

                // Answered only for the content kinds a page can actually use; anything
                // else falls through to the 503 below, exactly as before.
                if(await this.relayContent(parsed, res))
                    return;
            } catch(e) {
                return res.status(400).json({ error: 'Invalid or unreachable URL', code: 'RELAY_FETCH_FAILED' });
            }
        }
        // Last resort for anything not relayed above: service unavailable.
        res.status(503).json({ error: 'service not available', code: 'SERVICE_UNAVAILABLE' });
    }

    /**
     * The destination gate for /relay: protocol, address range and port.
     *
     * @returns {{status:number, body:object}|null} the refusal to send, or null
     *          when the URL may be fetched
     */
    relayDestinationRefusal(parsed){
        // Only http and https may be relayed.
        if(!['http:', 'https:'].includes(parsed.protocol))
            return { status: 400, body: { error: 'Invalid protocol', code: 'RELAY_INVALID_PROTOCOL' } };

        // Block private, loopback and metadata IP ranges, which is what keeps
        // this endpoint from reaching the server's own network.
        // Node's URL parser wraps IPv6 in brackets (e.g. [::1]); strip them for matching
        const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
        // Literal-IP hosts never reach the dns.lookup shim below (Node's
        // net.connect skips a custom `lookup` for IP literals), so a private
        // literal would otherwise sail past the shim entirely. Check literals
        // here against the canonical range classifier, which covers IPv6 ULA
        // (fc00::/7 incl. fd00:ec2::254), CGNAT (100.64/10), and the full
        // link-local range that the drifted inline list below missed.
        if(net.isIP(hostname) && this.isPrivateAddress(hostname))
            return { status: 403, body: { error: 'Destination not permitted', code: 'RELAY_DENIED' } };
        const blocked = [
            /^localhost$/i,
            /^127\./,
            /^0\./,
            /^10\./,
            /^172\.(1[6-9]|2[0-9]|3[01])\./,
            /^192\.168\./,
            /^169\.254\./,
            /^::1$/,
            /^fc00:/,
            /^::ffff:/i,
            /^fe80:/i,
            /^\d+$/,
        ];
        if(blocked.some(r => r.test(hostname)))
            return { status: 403, body: { error: 'Destination not permitted', code: 'RELAY_DENIED' } };

        // Web ports only. Token metadata lives on ordinary web servers, so
        // nothing legitimate needs a non-web port, while an unrestricted port
        // turns this endpoint into a probe for services (databases, admin
        // panels) that happen to sit on a public address and therefore pass
        // the private-range checks above.
        const port = parsed.port === '' ? (parsed.protocol === 'https:' ? '443' : '80') : parsed.port;
        if(!['80', '443'].includes(port))
            return { status: 403, body: { error: 'Destination not permitted', code: 'RELAY_DENIED' } };

        // Nothing refused it.
        return null;
    }

    /**
     * Fetch and send the one destination the page asked for, when its content kind
     * is one the explorer relays.
     *
     * @returns {boolean} true when the response has been sent, false when the URL
     *          named no kind this endpoint relays
     */
    async relayContent(parsed, res){
        const ext  = String(path.extname(parsed.pathname)).replace('.','').toLowerCase();
        // The literal-hostname blocklist only catches IPs in the URL; a domain whose
        // DNS record points at a private address (or rebinds) would sail past it.
        // ssrfSafeLookup validates the address axios actually connects to, closing
        // the TOCTOU window between a separate re-resolution check and the connection.
        const opts = { timeout: 5000, maxContentLength: 5 * 1024 * 1024, maxRedirects: 0,
                       lookup: this.ssrfSafeLookup.bind(this) };

        // JSON files, and arweave.net gateway URLs, which carry no .json extension.
        const isArweave = /^arweave\.net$/i.test(parsed.hostname);
        if(ext=='json' || isArweave){
            let response = await axios.get(parsed.href, opts);
            if(!this.util.isNull(response.data)){
                res.type('json').send(this.util.jsonStringify(response.data));
                return true;
            }
        }

        // PNG images, handed back base64-encoded for the page to embed.
        if(ext=='png'){
            let response    = await axios.get(parsed.href, { ...opts, responseType: 'arraybuffer' });
            let base64Image = btoa(new Uint8Array(response.data).reduce((data, byte) => data + String.fromCharCode(byte), ''));
            res.send(base64Image);
            return true;
        }

        // No kind this endpoint relays.
        return false;
    }
}

module.exports = { methods: RelayEgress.prototype, useHostBindings };
