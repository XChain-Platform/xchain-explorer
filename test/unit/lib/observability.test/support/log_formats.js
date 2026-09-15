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

const { expect } = require('chai');

const {
    createLogShipper, scrubMessage, REDACTED
} = require('../../../../src/observability/logShipper.js');
const { fakeConsole } = require('./helpers.js');

// The fleet runs text mode, so text mode is where the structured record has to
// survive. Before this, _emitLocal's text branch printed the message alone and
// threw the whole record away: LOG_LEVEL and LOG_FORMAT changed nothing an
// operator could see on any box.
describe('observability/logShipper: text-with-fields format', function () {
    it('renders ts, lowercase level, service tag, message, then key=value', function () {
        const sink = fakeConsole();
        const log = createLogShipper({ service: 'xchain-explorer', env: {}, console: sink });
        log.warn('PBFT_DROP', { reason: 'digest_mismatch', phase: 'prepare', round: 42 });
        expect(sink.lines.warn).to.have.lengthOf(1);
        expect(sink.lines.warn[0]).to.match(
            /^\d{4}-\d{2}-\d{2}T[\d:.]+Z warn \[xchain-explorer\] PBFT_DROP reason=digest_mismatch phase=prepare round=42$/
        );
    });

    it('keeps the level token lowercase so the server-monitor ERROR|FATAL grep does not match it', function () {
        const sink = fakeConsole();
        const log = createLogShipper({ service: 'svc', env: {}, console: sink });
        log.error('boom');
        // collect-snapshot.sh counts `grep -cE 'ERROR|FATAL'`. An uppercase
        // token would make every console.error line count and trip the crit
        // threshold fleet-wide on first deploy.
        expect(sink.lines.error[0]).to.not.match(/ERROR|FATAL/);
        expect(sink.lines.error[0]).to.include(' error [svc] boom');
    });

    it('puts the message immediately after the service tag so existing substring greps still match', function () {
        const sink = fakeConsole();
        const log = createLogShipper({ service: 'xchain-explorer', env: {}, console: sink });
        log.info('Oracle: Round 12 finalized');
        expect(sink.lines.log[0]).to.include('Oracle: Round 12 finalized');
    });

    it('quotes a value carrying whitespace, = or a quote, and leaves plain tokens bare', function () {
        const sink = fakeConsole();
        const log = createLogShipper({ service: 'svc', env: {}, console: sink });
        log.info('m', { plain: 'abc', spaced: 'a b', eq: 'k=v', num: 3, flag: true, nil: null });
        const line = sink.lines.log[0];
        expect(line).to.include('plain=abc');
        expect(line).to.include('spaced="a b"');
        expect(line).to.include('eq="k=v"');
        expect(line).to.include('num=3');
        expect(line).to.include('flag=true');
        expect(line).to.include('nil=null');
    });

});

describe('observability/logShipper: text-with-fields format', function () {

    it('redacts a credential-shaped field and an inline credential in the message', function () {
        const sink = fakeConsole();
        const log = createLogShipper({ service: 'svc', env: {}, console: sink });
        log.warn('connect failed password=hunter2', { db_password: 'hunter2', host: 'db1' });
        const line = sink.lines.warn[0];
        expect(line).to.not.include('hunter2');
        expect(line).to.include(REDACTED);
        expect(line).to.include('host=db1');
    });

    it('emits one NDJSON record per line under LOG_FORMAT=json', function () {
        const sink = fakeConsole();
        const log = createLogShipper({ service: 'svc', env: { LOG_FORMAT: 'json' }, console: sink });
        log.info('hello', { a: 1 });
        const parsed = JSON.parse(sink.lines.log[0]);
        expect(parsed).to.include({ level: 'info', service: 'svc', msg: 'hello', a: 1 });
        expect(parsed.ts).to.be.a('string');
    });

    it('silences info under LOG_LEVEL=warn while still emitting warn', function () {
        const sink = fakeConsole();
        const log = createLogShipper({ service: 'svc', env: { LOG_LEVEL: 'warn' }, console: sink });
        log.info('quiet');
        log.warn('loud');
        expect(sink.lines.log).to.have.lengthOf(0);
        expect(sink.lines.warn).to.have.lengthOf(1);
    });
});

describe('observability/logShipper: message redaction', function () {
    // An env-validation failure prints the variable NAME and its value, and the
    // names the services use are all prefixed (HUB_DB_SECRET, INDEXER_DB_PASS,
    // db_password). A `\b`-anchored key never matches those, because `_` is a
    // word character and `\b` does not fire between two word characters. With
    // LOG_SHIP_* configured, an unscrubbed line goes off-box in the clear.
    const leaky = [
        ['prefixed env secret',   'Missing required environment variable: HUB_DB_SECRET=hunter2swordfish'],
        ['prefixed db pass',      'connect failed db_password=hunter2swordfish'],
        ['screaming env pass',    'INDEXER_DB_PASS=hunter2swordfish'],
        ['api key',               'HUB_API_KEY=hunter2swordfish'],
        ['keyed bearer',          'Authorization: Bearer eyJhbGciOi.SECRETPAYLOAD.sig'],
        ['bare bearer',           'sending Bearer eyJhbGciOi.SECRETPAYLOAD.sig upstream'],
        ['quoted mnemonic',       'mnemonic="correct horse battery staple"'],
    ];
    for (const [name, line] of leaky) {
        it(`scrubs a ${name}`, function () {
            const out = scrubMessage(line);
            expect(out).to.not.match(/hunter2swordfish|SECRETPAYLOAD|correct horse/);
            expect(out).to.include(REDACTED);
        });
    }

    it('redacts the token, not the word Bearer', function () {
        // The value group would otherwise capture "Bearer" and stop, leaving the
        // token itself in the clear immediately after a [redacted] marker that
        // makes the line look handled.
        const out = scrubMessage('Authorization: Bearer eyJhbGciOi.SECRETPAYLOAD.sig');
        expect(out).to.not.include('SECRETPAYLOAD');
    });

    it('leaves real operational lines untouched, hex identifiers included', function () {
        // Hub and indexer lines are full of legitimate 64-char hex (txids, block
        // hashes, state roots). A hex sweep here would gut the logs this work
        // exists to make readable.
        const keep = [
            'Oracle: Round 12 finalized with 4 of 5 votes',
            'StateAnchorPublisher: anchored bundle regtest @ 100 (txid a3f9bc21de)',
            'P2P: Invalid signature from xc1qexampleaddr; dropping message',
            'seed block=5 imported',
            'PBFT_DROP reason=digest_mismatch phase=prepare round=42'
        ];
        for (const line of keep) expect(scrubMessage(line)).to.equal(line);
    });
});
