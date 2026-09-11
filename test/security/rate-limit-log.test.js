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
 * Security tests: Rate limiter counter line
 *
 * A silent limiter is an outage nobody can attribute: the wallet sees
 * timeouts and the service log says nothing about a ceiling, so the first
 * diagnosis is always the wrong subsystem. src/rateLimitLog.js turns each
 * limiter into one that names the knob and the volume it refused.
 *
 * Two failure modes are worth more than the feature itself, and both are
 * silent in review: logging every refusal (a throttled client retries hard,
 * so the log becomes its own outage), and forgetting to reset the counter
 * (every later line reports a running total, so an operator sizing a knob
 * reads a number that grew from traffic already reported). The window and
 * reset tests below exist for exactly those two.
 *
 * A custom handler replaces express-rate-limit's default body, so this also
 * pins that the refusal still answers 429 with the same JSON body, and drives
 * the real library once to prove the draft-6 headers survive the swap.
 *
 * The clock and the log sink are injected, so nothing here waits on a timer
 * and the module can hold none.
 *
 * Run: mocha test/security/rate-limit-log.test.js --timeout 5000 --exit
 */

'use strict';

const { expect }  = require('chai');
const fs          = require('fs');
const path        = require('path');
const express     = require('express');
const rateLimit   = require('express-rate-limit');
const request     = require('supertest');

const { limitedHandler } = require('../../src/rateLimitLog.js');

const WINDOW_MS = 60 * 1000;

// Minimal express res stand-in: records the status and the body the handler
// chose, which is the whole contract a custom handler owns.
function fakeRes() {
    const sent = { status: null, body: null };
    return {
        sent,
        status(code) { sent.status = code; return this; },
        json(body)   { sent.body = body;   return this; }
    };
}

// A handler wired to a movable clock and a capturing log, so a window can be
// crossed without waiting one.
function harness(overrides = {}) {
    const lines = [];
    const clock = { t: 1000 };
    const handler = limitedHandler(Object.assign({
        service:  'Explorer',
        name:     'app-wide',
        envVar:   'EXPLORER_RATE_LIMIT_RPM',
        limit:    1080,
        windowMs: WINDOW_MS,
        message:  { error: 'Too many requests', code: 'RATE_LIMITED' },
        log:      (line) => lines.push(line),
        now:      () => clock.t
    }, overrides));
    const refuse = () => {
        const res = fakeRes();
        handler({}, res, () => {}, {});
        return res.sent;
    };
    return { lines, clock, refuse };
}

describe('Security: Rate limit counter line: the refusal itself (row 18)', function () {

    it('answers 429 with the exact JSON body the limiter would have sent', function () {
        const { refuse } = harness();
        const sent = refuse();
        expect(sent.status).to.equal(429);
        expect(sent.body).to.deep.equal({ error: 'Too many requests', code: 'RATE_LIMITED' });
    });

    it('sends the per-route body, not a shared one, when a route limiter refuses', function () {
        const { refuse } = harness({
            name:    'vm-query',
            envVar:  'EXPLORER_VM_QUERY_RATE_LIMIT_RPM',
            limit:   20,
            message: { error: 'Too many simulation requests', code: 'RATE_LIMITED' }
        });
        expect(refuse().body).to.deep.equal({ error: 'Too many simulation requests', code: 'RATE_LIMITED' });
    });

    it('answers every refusal, including the ones it deliberately does not log', function () {
        const { refuse, lines } = harness();
        const statuses = [refuse().status, refuse().status, refuse().status];
        expect(statuses).to.deep.equal([429, 429, 429]);
        expect(lines).to.have.lengthOf(1);
    });
});

describe('Security: Rate limit counter line: what it prints (row 18)', function () {

    it('logs one line at the first refusal, naming the count, the ceiling and the knob', function () {
        const { refuse, lines } = harness();
        refuse();
        expect(lines).to.deep.equal([
            'Explorer rate limit [app-wide]: 1 request refused in the last 60 s ' +
            '(limit 1080/60 s); raise EXPLORER_RATE_LIMIT_RPM if this is legitimate traffic'
        ]);
    });

    it('carries the route limiter own name, ceiling and knob', function () {
        const { refuse, lines } = harness({
            name:    'action-proof',
            envVar:  'EXPLORER_ACTION_PROOF_RATE_LIMIT_RPM',
            limit:   90,
            message: { error: 'Too many proof requests', code: 'RATE_LIMITED' }
        });
        refuse();
        expect(lines[0]).to.equal(
            'Explorer rate limit [action-proof]: 1 request refused in the last 60 s ' +
            '(limit 90/60 s); raise EXPLORER_ACTION_PROOF_RATE_LIMIT_RPM if this is legitimate traffic'
        );
    });

    it('pluralises the count, so a multi-refusal line does not read as one request', function () {
        const { refuse, lines, clock } = harness();
        refuse();
        refuse();
        refuse();
        clock.t += WINDOW_MS;
        refuse();
        expect(lines[1]).to.contain('3 requests refused');
    });
});

describe('Security: Rate limit counter line: the window (row 18)', function () {

    it('stays silent for every further refusal inside the same window', function () {
        const { refuse, lines, clock } = harness();
        refuse();
        expect(lines).to.have.lengthOf(1);
        for (let i = 0; i < 500; i++) {
            clock.t += 100;                 // 50 s of hammering, still one window
            refuse();
        }
        expect(lines, 'a burst inside one window must not print a second line').to.have.lengthOf(1);
    });

    it('logs again at the first refusal past the window, then resets the count it reports', function () {
        const { refuse, lines, clock } = harness();

        refuse();                            // first refusal: the line says 1
        for (let i = 0; i < 4; i++) {
            clock.t += 1000;
            refuse();                        // 4 more inside the window: silent
        }

        clock.t = 1000 + WINDOW_MS;
        refuse();                            // the 5 accumulated since the last line
        expect(lines).to.have.lengthOf(2);
        expect(lines[1]).to.contain('5 requests refused');

        clock.t += 1;
        refuse();                            // inside the new window: silent
        clock.t = 1000 + (2 * WINDOW_MS);
        refuse();                            // 2 since the previous line, not 7
        expect(lines).to.have.lengthOf(3);
        expect(lines[2], 'the count must reset at each line, not run as a total').to.contain('2 requests refused');
    });

    it('holds no timer, so an idle process is never kept alive by a limiter', function () {
        const before = process._getActiveHandles().length;
        const { refuse } = harness();
        refuse();
        expect(process._getActiveHandles().length).to.equal(before);
    });
});

describe('Security: Rate limit counter line: driven through express-rate-limit 8 (row 18)', function () {

    // The library sets the draft-6 headers and Retry-After BEFORE calling a
    // custom handler, so swapping `message` for `handler` must not cost the
    // client the retry hint. Asserted against the real library, not a stub.
    it('keeps Retry-After and the RateLimit-* headers on the 429 it sends', async function () {
        const lines = [];
        const app = express();
        app.use(rateLimit({
            windowMs:        WINDOW_MS,
            limit:           2,
            standardHeaders: true,
            legacyHeaders:   false,
            handler:         limitedHandler({
                service:  'Explorer',
                name:     'app-wide',
                envVar:   'EXPLORER_RATE_LIMIT_RPM',
                limit:    2,
                windowMs: WINDOW_MS,
                message:  { error: 'Too many requests', code: 'RATE_LIMITED' },
                log:      (line) => lines.push(line)
            })
        }));
        app.get('/ping', (req, res) => res.json({ ok: true }));

        await request(app).get('/ping').expect(200);
        await request(app).get('/ping').expect(200);
        const refused = await request(app).get('/ping').expect(429);

        expect(refused.body).to.deep.equal({ error: 'Too many requests', code: 'RATE_LIMITED' });
        expect(refused.headers['retry-after']).to.exist;
        expect(refused.headers['ratelimit-limit']).to.equal('2');
        expect(lines).to.have.lengthOf(1);
        expect(lines[0]).to.contain('(limit 2/60 s)');
    });
});

describe('Security: Rate limit counter line: every explorer limiter carries it (row 18)', function () {

    const apiSource      = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');
    const explorerSource = fs.readFileSync(path.join(__dirname, '../../src/XChainExplorer.js'), 'utf8');

    // Pull out the balanced argument text of every rateLimit(...) call, so the
    // assertions below read a limiter's own options and not a neighbour's.
    function rateLimitOptionBlocks(source) {
        const blocks = [];
        const marker = 'rateLimit(';
        let from = 0;
        for (;;) {
            const at = source.indexOf(marker, from);
            if (at === -1) return blocks;
            let depth = 0;
            let i = at + marker.length - 1;
            for (; i < source.length; i++) {
                if (source[i] === '(') depth++;
                else if (source[i] === ')' && --depth === 0) break;
            }
            blocks.push(source.slice(at + marker.length, i));
            from = i;
        }
    }

    const blocks = [...rateLimitOptionBlocks(apiSource), ...rateLimitOptionBlocks(explorerSource)];

    it('finds the nine limiter declarations (sanity: the parser matched something)', function () {
        expect(blocks).to.have.lengthOf(9);
    });

    it('gives every limiter a counter-line handler', function () {
        const without = blocks.filter((b) => !b.includes('handler:') || !b.includes('limitedHandler('));
        expect(without, `${without.length} limiter declaration(s) have no limitedHandler`).to.deep.equal([]);
    });

    it('leaves no limiter answering through a bare message option', function () {
        // `message` and a custom `handler` are alternatives in v8: whichever
        // limiter kept `message` would answer without ever logging a line.
        const stillMessaging = blocks.filter((b) => /(^|[^.\w])message\s*:/.test(b));
        expect(stillMessaging, 'a limiter still sends its body through `message`').to.deep.equal([]);
    });

    it('names each of the nine limiters distinctly, so a line points at one knob', function () {
        const names = blocks
            .map((b) => (b.match(/name:\s*'([a-z-]+)'/) || [])[1])
            .filter(Boolean)
            .sort();
        expect(names).to.deep.equal([
            'action-proof', 'app-wide', 'batch', 'checkpoint-list', 'checkpoint-verify',
            'fee-quote', 'preflight-post', 'validator-set-proof', 'vm-query'
        ]);
    });

    it('logs the same ceiling it enforces, resolved once per limiter', function () {
        // A hand-copied number in the handler would report the shipped default
        // long after an operator raised the env knob.
        for (const block of blocks) {
            const enforced = (block.match(/limit:\s*([A-Za-z]\w*)\.limit/) || [])[1];
            expect(enforced, `limiter does not read its ceiling from a policy const: ${block.slice(0, 80)}`).to.be.a('string');
            expect(block).to.contain(`...${enforced}`);
        }
    });
});
