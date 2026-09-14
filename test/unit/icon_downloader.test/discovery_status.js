'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const {
    ACTION_REF_PATTERN, expect, execCmdText, iconSuite, loadIconDownloader,
    makeExecStub, makeExplorer, makeMockConn, makeMockPool, makeStubs, path,
    setClock, sinon, tickClock,
} = require('./helpers.js');

// #5290: the one-shot re-stale has to be ONE-shot. It selects rows in the
// terminal ok-with-no-icon state, which is exactly the state processToken
// writes for a description that resolves to no source at all - so a predicate
// any wider than the resolver's own grammar re-stales those same rows on every
// cycle for as long as the token exists: a permanent write loop on the
// indexer-owned icons table, plus permanent occupancy of the batch queue,
// mintable by anyone who can issue a token described `action:` plus anything.
{

    // Probed against the live resolver: each is PREFIXED with `action:` and
    // resolves to null, so none of them may ever be selected for a re-stale.
    // The U+0130 spellings are the attacker-mintable ones this suite once
    // waved through; see the model's own caveat below.
    const UNRESOLVABLE = [
        'action:foo', 'action:BTC:', 'action:', 'action:12a',
        'action:XYZ:5', 'action:0x10', 'action: 12', 'Action:hello',
        'ACTİON:12', 'ACTİON:BTC:5', 'actİon:12', 'actıon:12',
    ];
    const RESOLVABLE = ['action:12', 'action:BTC:5', 'ACTION:DOGE:9', '  action:7  '];

    const realResolve = require('../../../src/icons/resolver.js').resolveDescriptionToSource;

    /**
     * Read the re-stale predicate out of the SQL the module actually emits and
     * evaluate it the way the server would, so these assertions bind to the
     * shipped statement rather than to a copy of it.
     *
     * THIS IS A MODEL OF MariaDB, NOT MariaDB, and the distinction is not
     * academic: the previous model evaluated the predicate as
     * `re.test(desc.trim().toLowerCase())` to stand in for LOWER(TRIM(...)),
     * and JavaScript's toLowerCase() is not MariaDB's LOWER(). MariaDB folds
     * U+0130 to plain 'i'; toLowerCase() expands it to 'i' plus a COMBINING DOT
     * ABOVE, which does not match the grammar. So the model reported "not
     * selected" for `ACTİON:12` while the database selected it, and #5290 passed
     * this suite twice while still looping in production.
     *
     * What makes the model sound now is that the shipped predicate no longer
     * asks either engine to fold case: ACTION_REF_PATTERN spells both cases out
     * and the SQL matches under CONVERT(... USING binary), so the only remaining
     * gaps between this function and the server are the two below, both of which
     * make the model select AT LEAST what the database does - the safe direction
     * for a "must never select" assertion:
     *
     *   - SQL TRIM() strips only spaces where String#trim() strips all
     *     whitespace, so the model trims to ASCII spaces to match.
     *   - MariaDB's PCRE `$` also matches before one trailing newline, which JS
     *     `$` does not, so the model tries that spelling too.
     *
     * The engine itself answers this question in
     * test/conformance/icon-restale-predicate.test.js, which runs the shipped
     * statement against a real MariaDB over every Unicode scalar value. When the
     * two tiers ever disagree, the conformance tier is right.
     */
    async function restalePredicate() {
        const stubs = makeStubs();
        const IconDownloader = loadIconDownloader(stubs);
        const d = new IconDownloader(makeExplorer());
        const conn = makeMockConn([[], [], []]);
        await d.discover(conn);
        const sql = conn.query.thirdCall.args[0];
        const m = /CONVERT\(TRIM\(t\.description\) USING binary\)\s+REGEXP\s+'([^']+)'/.exec(sql);
        expect(m, 'the re-stale must test the WHOLE description against a regexp, ' +
            'under a binary collation so no case folding can widen it:\n' + sql)
            .to.not.equal(null);
        expect(sql, 'LOWER() is not /i; emulating one with the other is what #5290 was')
            .to.not.match(/LOWER\s*\(/i);
        const re = new RegExp(m[1]);
        const sqlTrim = s => String(s).replace(/^ +/, '').replace(/ +$/, '');
        return desc => {
            const t = sqlTrim(desc);
            return re.test(t) || re.test(t.replace(/\n$/, ''));
        };
    }

    iconSuite('_discover(): the action: re-stale is one-shot', function () {
        it('never selects a description the resolver cannot resolve', async function () {
            const selects = await restalePredicate();
            for (const desc of UNRESOLVABLE) {
                expect(realResolve(desc), `${desc} must resolve to no source`).to.equal(null);
                expect(selects(desc), `${desc} resolves to nothing, so re-staling it loops forever`)
                    .to.equal(false);
            }
        });

        it('still selects every description the resolver does resolve', async function () {
            const selects = await restalePredicate();
            for (const desc of RESOLVABLE) {
                expect(realResolve(desc).scheme, `${desc} must resolve`).to.equal('action');
                expect(selects(desc), `${desc} resolves, so the fix must reach its row`)
                    .to.equal(true);
            }
        });

    });

    iconSuite('_discover(): the action: re-stale is one-shot', function () {
        it('leaves an unresolvable action:-prefixed row un-staled on every cycle', async function () {
            const selects = await restalePredicate();

            // One icons row per probe, in the terminal state the pipeline leaves them
            // in before this round's fix: status ok, icon_hash NULL.
            const table = UNRESOLVABLE.map((description, i) => ({
                icon_id: i + 1, description, status: 'ok', icon_hash: null,
            }));
            const runRestale = () => {
                for (const row of table) {
                    if (row.status === 'ok' && row.icon_hash === null && selects(row.description)) {
                        row.status = 'stale';
                    }
                }
                return table.filter(r => r.status === 'stale').map(r => r.description);
            };

            // Cycle 1.
            expect(runRestale()).to.deep.equal([]);

            // And these rows really do sit in the state the statement selects on:
            // drive each one through processToken and watch it take the terminal
            // ok-with-null-icon_hash path. That is the loop's other half.
            const stubs = makeStubs({ resolveDescriptionToSource: sinon.stub().callsFake(realResolve) });
            const IconDownloader = loadIconDownloader(stubs);
            const d = new IconDownloader(makeExplorer());
            for (const row of table) {
                const conn = { query: sinon.stub().resolves([]), release: sinon.stub().resolves() };
                await d.processToken(conn, { coin: 'BTC', network: 'mainnet', poolKey: 'BTC' },
                    { icon_id: row.icon_id, attempts: 0, description: row.description, tick: 'TOK' + row.icon_id });
                expect(conn.query.callCount).to.equal(1);
                const [sql, params] = conn.query.firstCall.args;
                expect(sql).to.include("status='ok'");
                expect(params[2], 'icon_hash stays NULL: the state the re-stale selects').to.equal(null);
            }

            // Cycle 2: the rows are back in that state, and are still not selected.
            expect(runRestale()).to.deep.equal([]);
        });
    });
}

{

    iconSuite('_markOk()', function () {
        it('issues UPDATE icons SET status=ok with correct args', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            const conn = makeMockConn([[]]);
            await d.markOk(conn, 99, 'https://example.com/a.png', 'srchash', 'iconhash', 'deschash');

            expect(conn.query.callCount).to.equal(1);
            const [sql, args] = conn.query.firstCall.args;
            expect(sql).to.include("status='ok'");
            expect(sql).to.include('WHERE id=?');
            expect(args).to.deep.equal(['https://example.com/a.png', 'srchash', 'iconhash', 'deschash', 99]);
        });

        it('accepts nulls for url/sourceHash/iconHash', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            const conn = makeMockConn([[]]);
            await d.markOk(conn, 7, null, null, null, 'dh');

            const [, args] = conn.query.firstCall.args;
            expect(args[0]).to.equal(null);
            expect(args[1]).to.equal(null);
            expect(args[2]).to.equal(null);
            expect(args[3]).to.equal('dh');
            expect(args[4]).to.equal(7);
        });
    });
}

{

    iconSuite('_markFailure()', function () {
        it('uses terminal path (no next_retry_at) when attempts >= maxAttempts', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);
            d.cfg.maxAttempts = 4;

            const conn = makeMockConn([[]]);
            await d.markFailure(conn, 5, 4, 'too many');

            const [sql, args] = conn.query.firstCall.args;
            expect(sql).to.include("status='failed'");
            expect(sql).to.not.include('INTERVAL');
            expect(args).to.deep.equal([4, 'too many', 5]);
        });

        it('uses retry path (DATE_ADD INTERVAL) when attempts < maxAttempts', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);
            d.cfg.maxAttempts = 4;

            const conn = makeMockConn([[]]);
            await d.markFailure(conn, 5, 1, 'first fail');

            const [sql, args] = conn.query.firstCall.args;
            expect(sql).to.include('INTERVAL');
            expect(sql).to.include('SECOND');
            // args: [attempts, errMsg, sec, iconId]
            expect(args[0]).to.equal(1);
            expect(args[1]).to.equal('first fail');
            expect(args[2]).to.equal(3600);  // backoff for attempt 1 = 1h
            expect(args[3]).to.equal(5);
        });

        it('backoff is 86400 for attempt 2', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);
            d.cfg.maxAttempts = 4;

            const conn = makeMockConn([[]]);
            await d.markFailure(conn, 5, 2, 'second fail');

            const [, args] = conn.query.firstCall.args;
            expect(args[2]).to.equal(86400);
        });

    });

    iconSuite('_markFailure()', function () {
        it('backoff is 7*86400 for attempt 3', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);
            d.cfg.maxAttempts = 4;

            const conn = makeMockConn([[]]);
            await d.markFailure(conn, 5, 3, 'third fail');

            const [, args] = conn.query.firstCall.args;
            expect(args[2]).to.equal(7 * 86400);
        });
    });
}
