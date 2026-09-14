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

const netmod = require('net');

// Expand an IPv6 literal to its eight 16-bit groups, so every spelling of one
// address classifies alike. Returns null when the text cannot be read as IPv6,
// which the caller treats as a refusal rather than a pass.
function expandIpv6(text) {
    let rest = text;
    // A trailing dotted quad carries the low 32 bits; rewrite it as two hex
    // groups so the rest of the parse is uniform.
    const dotted = /(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(rest);
    if (dotted) {
        const o = dotted[1].split('.').map(Number);
        if (o.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
        rest = rest.slice(0, rest.length - dotted[1].length)
            + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
    }
    const halves = rest.split('::');
    if (halves.length > 2) return null;
    const pieces = (s) => {
        if (s === '') return [];
        const out = [];
        for (const p of s.split(':')) {
            if (!/^[0-9a-f]{1,4}$/i.test(p)) return null;
            out.push(parseInt(p, 16));
        }
        return out;
    };
    const head = pieces(halves[0]);
    const tail = (halves.length === 2) ? pieces(halves[1]) : [];
    if (head === null || tail === null) return null;
    if (halves.length === 1) return (head.length === 8) ? head : null;
    const gap = 8 - head.length - tail.length;
    if (gap < 1) return null;
    return head.concat(new Array(gap).fill(0), tail);
}

// Classify a resolved IP literal as a private, loopback, link-local, CGNAT,
// unique-local or cloud-metadata address that an outbound fetch must refuse to
// connect to. An IPv6 zone id (fe80::1%eth0) is stripped and an IPv6 literal is
// expanded to its groups first, so no spelling can smuggle a private target past
// the check.
function isPrivateAddress(ip) {
    let addr = String(ip).trim()
        .replace(/^\[|\]$/g, '')       // strip [ ] brackets around IPv6 literals
        .replace(/%.*$/, '');          // strip IPv6 zone id (fe80::1%eth0)

    if (netmod.isIP(addr) === 6) {
        const g = expandIpv6(addr);
        // Fail closed: an IPv6 literal Node accepts but this parser cannot read
        // is refused, never passed through unclassified.
        if (!g) return true;
        if ((g[0] & 0xfe00) === 0xfc00) return true;   // fc00::/7 unique-local
        if ((g[0] & 0xffc0) === 0xfe80) return true;   // fe80::/10 link-local
        // The low 32 bits are an IPv4 destination under the mapped (::ffff:0:0/96),
        // translated (::ffff:0:0:0/96) and compatible (::/96) prefixes, so classify
        // all three on the v4 list below. The URL parser emits the mapped form in
        // hex pieces (::ffff:7f00:1), which a "::ffff:" prefix strip left as
        // unmatchable residue.
        const mapped = (g[0] | g[1] | g[2] | g[3]) === 0
            && ((g[4] === 0 && (g[5] === 0xffff || g[5] === 0)) || (g[4] === 0xffff && g[5] === 0));
        if (mapped)
            addr = [g[6] >>> 8, g[6] & 0xff, g[7] >>> 8, g[7] & 0xff].join('.');
    } else {
        addr = addr.replace(/^::ffff:/i, '');   // mapped text net.isIP rejects
    }

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
