/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * The query-plan allowlist: today's known offenders, one per line.
 *
 * Line shape: `<method> <filter> <kind> <table> <finding> | <reason>`. Blank
 * lines and `#` comments are ignored. The list only shrinks: an offender
 * missing from it fails the guard, and so does an entry that no longer
 * offends, so a fixed plan has to take its line out with it.
 *
 ********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');

const ALLOWLIST_PATH = path.join(__dirname, '..', 'plan_allowlist.txt');

const HEADER = [
    '# Query-plan guard allowlist: plans that read a production-large table whole.',
    '# Line shape: <method> <filter> <kind> <table> <finding> | <reason>',
    '# Findings: scan, dependent-count; error and unjudged mark probes the guard could not judge.',
    '# Fix a plan and its line must go; add a line only with a reason the plan cannot be indexed.',
    '# PLAN_GUARD_WRITE=1 npm run test:conformance rewrites this file from the current run.'
];

/** Parses allowlist text into entries; malformed and duplicate lines are errors. */
function parseAllowlist(text) {
    const entries = new Map();
    const errors  = [];
    String(text).split('\n').forEach((raw, i) => {
        const line = raw.trim();
        if (!line || line.startsWith('#')) return;
        const bar = line.indexOf('|');
        const key = (bar === -1 ? line : line.slice(0, bar)).trim().split(/\s+/).join(' ');
        const reason = bar === -1 ? '' : line.slice(bar + 1).trim();
        if (key.split(' ').length !== 5 || !reason)
            errors.push('line ' + (i + 1) + ' needs five fields and a reason: ' + line);
        else if (entries.has(key))
            errors.push('line ' + (i + 1) + ' repeats ' + key);
        else
            entries.set(key, reason);
    });
    return { entries, errors };
}

/**
 * Compares the observed offenders with the allowlist.
 *
 * @param {Map<string,string>} entries   allowlisted key to reason
 * @param {Map<string,string>} observed  offending key to a derived reason
 * @returns {{offenders: string[], stale: string[]}} allowlist lines to add and to remove
 */
function reconcile(entries, observed) {
    const offenders = [...observed.keys()].filter((k) => !entries.has(k)).sort()
        .map((k) => k + ' | ' + observed.get(k));
    const stale = [...entries.keys()].filter((k) => !observed.has(k)).sort()
        .map((k) => k + ' | ' + entries.get(k));
    return { offenders, stale };
}

/** Renders the allowlist for the observed offenders, keeping existing reasons. */
function renderAllowlist(entries, observed) {
    const lines = [...observed.keys()].sort()
        .map((k) => k + ' | ' + (entries.get(k) || observed.get(k)));
    return HEADER.concat(lines).join('\n') + '\n';
}

function readAllowlist(file) {
    const target = file || ALLOWLIST_PATH;
    return parseAllowlist(fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '');
}

function writeAllowlist(entries, observed, file) {
    fs.writeFileSync(file || ALLOWLIST_PATH, renderAllowlist(entries, observed));
}

module.exports = { ALLOWLIST_PATH, parseAllowlist, reconcile, renderAllowlist, readAllowlist, writeAllowlist };
