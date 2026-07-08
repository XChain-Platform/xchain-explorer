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
 * XChain Explorer - SSRF guard
 *
 * Canonical private/internal-address classifier plus a dns.lookup-compatible
 * shim, shared by every outbound-fetch path that follows an attacker-influenced
 * URL (the /relay endpoint and the IconDownloader, which fetches URLs derived
 * from on-chain token descriptions). Single-sourcing the range list here keeps
 * the two egress paths from drifting apart (they previously carried two
 * different, incomplete copies).
 *
 ********************************************************************/

// Classify a resolved IP literal as a private, loopback, link-local, CGNAT,
// unique-local or cloud-metadata address that an outbound fetch must refuse to
// connect to. IPv4-mapped IPv6 (::ffff:a.b.c.d) is unwrapped first, and an IPv6
// zone id (fe80::1%eth0) is stripped, so neither can smuggle a private target
// past the check.
function isPrivateAddress(ip) {
    let addr = String(ip).trim()
        .replace(/^\[|\]$/g, '')       // strip [ ] brackets around IPv6 literals
        .replace(/%.*$/, '')           // strip IPv6 zone id (fe80::1%eth0)
        .replace(/^::ffff:/i, '');     // unwrap IPv4-mapped IPv6

    const v4 = [
        /^0\./,                                            // 0.0.0.0/8 ("this network", incl. 0.0.0.0)
        /^10\./,                                           // 10/8 private
        /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./,  // 100.64/10 carrier-grade NAT (RFC 6598)
        /^127\./,                                          // 127/8 loopback
        /^169\.254\./,                                     // 169.254/16 link-local + cloud metadata
        /^172\.(1[6-9]|2[0-9]|3[01])\./,                   // 172.16/12 private
        /^192\.168\./,                                     // 192.168/16 private
    ];
    const v6 = [
        /^::$/,                    // unspecified (:: connects to loopback on many stacks)
        /^::1$/,                   // loopback
        /^f[cd][0-9a-f]{2}:/i,     // fc00::/7 unique-local (fc00: .. fdff:)
        /^fe[89ab][0-9a-f]:/i,     // fe80::/10 link-local (fe80: .. febf:)
    ];

    return v4.some(r => r.test(addr)) || v6.some(r => r.test(addr));
}

// Build a dns.lookup-compatible shim (hostname, options, callback) that rejects
// with a RELAY_DENIED error when the hostname resolves to a private address.
// Handing this to axios/http as the `lookup` option validates the address the
// client is ABOUT to connect to, with no gap between the check and the
// connection: it closes the DNS-name and DNS-rebinding bypasses of a literal
// hostname blocklist, and (because follow-redirects reuses the request options)
// re-validates every redirect hop, not just the first URL. `dnsModule` is
// injectable for testing; defaults to the real dns module.
function makeSafeLookup(dnsModule) {
    const dns = dnsModule || require('dns');
    return function safeLookup(hostname, options, callback) {
        if (typeof options === 'function') { callback = options; options = {}; }
        dns.lookup(hostname, options, (err, address, family) => {
            if (err) return callback(err);
            const entries = Array.isArray(address) ? address : [{ address, family }];
            for (const e of entries) {
                if (isPrivateAddress(e.address)) {
                    const denied = new Error('Destination resolves to a non-permitted address');
                    denied.code = 'RELAY_DENIED';
                    return callback(denied);
                }
            }
            callback(null, address, family);
        });
    };
}

module.exports = { isPrivateAddress, makeSafeLookup };
