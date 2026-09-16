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
 * Security tests: .npmrc hygiene
 *
 * The repo .npmrc is committed, so anything written into it is published to
 * every clone and every CI runner. Two classes of damage can land there by
 * accident, and both have precedent:
 *
 *   1. A registry auth token pasted in during a private-package experiment.
 *      npm itself writes tokens to whichever .npmrc is nearest, so a stray
 *      `npm login --registry=...` in this directory leaks a credential.
 *   2. A TLS downgrade. `strict-ssl=false` arrived here once already, as a
 *      one-line drive-by inside an unrelated feature commit, and sat unnoticed
 *      turning off certificate verification for every dependency install.
 *
 * Both are invisible in review because nobody reads a dotfile in a 19-file
 * diff. This suite reads them instead.
 *
 * Run: mocha test/security/npmrc-hygiene.test.js --timeout 5000
 */

'use strict';

const fs         = require('fs');
const path       = require('path');
const { expect } = require('chai');

const NPMRC_PATH = path.join(__dirname, '..', '..', '.npmrc');

// npm/pnpm credential keys. `_auth`, `_authToken`, `_password` and friends are
// matched wherever they appear, since registry-scoped forms prefix them with a
// bare registry URL (`//registry.npmjs.org/:_authToken=...`).
const CREDENTIAL_KEY_PATTERN = /(^|[:/])_?(auth|authToken|password|username|secret|apikey|api_key|token)\s*=/i;

// Env-var interpolation (`${NPM_TOKEN}`) is the *correct* way to reference a
// secret from a committed .npmrc, so it must not trip the credential check.
const ENV_INTERPOLATION_ONLY = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

/**
 * Parse .npmrc into directive lines, dropping comments and blanks. npm accepts
 * both `#` and `;` as comment markers; a comment explaining a past leak must
 * not itself read as a leak.
 */
function directiveLines(raw) {
    return raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith(';'));
}

function splitDirective(line) {
    const eq = line.indexOf('=');
    if (eq === -1) return { key: line.trim(), value: '' };
    return { key: line.slice(0, eq).trim(), value: line.slice(eq + 1).trim() };
}

/** Credential keys found in raw .npmrc text, values never returned. */
function findCredentialKeys(raw) {
    return directiveLines(raw)
        .map(splitDirective)
        .filter(({ key, value }) => CREDENTIAL_KEY_PATTERN.test(`${key}=`) && !ENV_INTERPOLATION_ONLY.test(value))
        .map(({ key }) => key);
}

/** strict-ssl value in raw .npmrc text, or null when undeclared. */
function strictSslValue(raw) {
    const hit = directiveLines(raw)
        .map(splitDirective)
        .find(({ key }) => key.toLowerCase() === 'strict-ssl');
    return hit ? hit.value.toLowerCase() : null;
}

// A guard that cannot fail is not a guard. These fixtures exercise the
// detectors against the exact shapes that motivated the item, so a future
// refactor of the regexes cannot quietly neuter the checks above.
describe('Security: .npmrc hygiene detectors', () => {
    it('flags a bare auth token', () => {
        expect(findCredentialKeys('_authToken=npm_examplevalue\n')).to.deep.equal(['_authToken']);
    });

    it('flags a registry-scoped auth token', () => {
        const keys = findCredentialKeys('//registry.npmjs.org/:_authToken=npm_examplevalue\n');
        expect(keys).to.have.lengthOf(1);
        expect(keys[0]).to.contain('_authToken');
    });

    it('flags legacy basic-auth credentials', () => {
        expect(findCredentialKeys('_auth=Zm9vOmJhcg==\n')).to.deep.equal(['_auth']);
        expect(findCredentialKeys('_password=Zm9vOmJhcg==\n')).to.deep.equal(['_password']);
    });

    it('accepts an env-var reference, which leaks nothing', () => {
        expect(findCredentialKeys('//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n')).to.deep.equal([]);
    });

    it('ignores credential-shaped words inside comments', () => {
        expect(findCredentialKeys('# never put _authToken=... in this file\nstrict-ssl=true\n')).to.deep.equal([]);
        expect(findCredentialKeys('; _password=... belongs in ~/.npmrc\nstrict-ssl=true\n')).to.deep.equal([]);
    });

    it('detects the TLS downgrade that motivated this suite', () => {
        expect(strictSslValue('strict-ssl=false\n')).to.equal('false');
        expect(strictSslValue('strict-ssl=true\n')).to.equal('true');
        expect(strictSslValue('shamefully-hoist=true\n')).to.equal(null);
    });
});

describe('Security: .npmrc hygiene', () => {
    let raw;
    let directives;

    before(() => {
        expect(fs.existsSync(NPMRC_PATH), '.npmrc missing from repo root').to.equal(true);
        raw        = fs.readFileSync(NPMRC_PATH, 'utf8');
        directives = directiveLines(raw).map(splitDirective);
    });

    it('carries no registry credential', () => {
        // Report offending keys only. Echoing a value would move the leak from
        // the file into the CI log.
        const offenders = findCredentialKeys(raw);

        expect(offenders, `credential-bearing keys in .npmrc: ${offenders.join(', ')}`).to.deep.equal([]);
    });

    it('does not disable TLS certificate verification', () => {
        expect(strictSslValue(raw), 'strict-ssl must be pinned true in the committed .npmrc').to.equal('true');
    });

    it('does not disable integrity or signature checking', () => {
        // Sibling downgrades that defeat the lockfile's supply-chain guarantees
        // the same way strict-ssl=false defeats transport security.
        const forbiddenFalse = ['audit-signatures', 'verify-store-integrity'];
        const forbiddenTrue  = ['ignore-scripts-on-install-only', 'unsafe-perm'];

        for (const { key, value } of directives) {
            const k = key.toLowerCase();
            const v = value.toLowerCase();
            if (forbiddenFalse.includes(k)) {
                expect(v, `${k} must not be disabled in a committed .npmrc`).to.not.equal('false');
            }
            if (forbiddenTrue.includes(k)) {
                expect(v, `${k} must not be enabled in a committed .npmrc`).to.not.equal('true');
            }
        }
    });

    it('does not point installs at an unencrypted registry', () => {
        const registryUrls = directives
            .filter(({ key }) => key.toLowerCase() === 'registry' || key.toLowerCase().endsWith(':registry'))
            .map(({ value }) => value);

        for (const url of registryUrls) {
            expect(url, `registry ${url} is not https`).to.match(/^https:\/\//i);
        }
    });
});
