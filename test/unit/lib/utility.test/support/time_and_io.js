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

const { expect, sinon, proxyquire, Utility, log, makeUtil, makeStablePriceRows, stringifyBigInt, stringifyBigNumber, stringifySimpleValues, stringifyNestedBigNumber, logWithTimerStub } = require('./helpers.js');

describe("Utility", function () {
    describe('millisecondsToTimeString()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('returns empty string for 0 ms', function () {
            expect(u.millisecondsToTimeString(0)).to.equal('');
        });

        it('returns exact string for 5 seconds', function () {
            // 5000ms = 5s, milliseconds component = floor((5000 % 1000) / 100) = 0
            expect(u.millisecondsToTimeString(5000)).to.equal('05.0s');
        });

        it('returns exact string for 5100ms (with sub-second)', function () {
            // milliseconds = floor((5100 % 1000) / 100) = 1
            expect(u.millisecondsToTimeString(5100)).to.equal('05.1s');
        });

        it('returns exact string for 90 seconds', function () {
            // 90000ms = 1m 30s, milliseconds = 0
            expect(u.millisecondsToTimeString(90000)).to.equal('01m 30.0s');
        });

        it('returns exact string for 1h 1m 1s', function () {
            // 3661000ms = 1h 1m 1s
            expect(u.millisecondsToTimeString(3661000)).to.equal('01h 01m 01.0s');
        });

        it('returns exact string for 1d 1h', function () {
            // 86400000 + 3600000 = 1d 1h 0m 0s
            expect(u.millisecondsToTimeString(86400000 + 3600000)).to.equal('1d 01h ');
        });

        it('does not pad hours >= 10', function () {
            // 10 hours = 36000000ms
            const result = u.millisecondsToTimeString(36000000);
            expect(result).to.equal('10h ');
        });

        it('does not pad minutes >= 10', function () {
            // 10 minutes = 600000ms
            const result = u.millisecondsToTimeString(600000);
            expect(result).to.equal('10m ');
        });

        it('does not pad seconds >= 10', function () {
            // 10 seconds = 10000ms
            const result = u.millisecondsToTimeString(10000);
            expect(result).to.equal('10.0s');
        });

        it('pads single-digit seconds with leading zero', function () {
            expect(u.millisecondsToTimeString(1000)).to.equal('01.0s');
        });

    });
});

describe("Utility", function () {
    describe('getWallClockTime()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('returns a value close to Math.floor(Date.now()/1000)', function () {
            const expected = Math.floor(Date.now() / 1000);
            const result   = parseInt(u.getWallClockTime().toString());
            // Allow a 2-second window for slow test environments
            expect(result).to.be.within(expected - 2, expected + 2);
        });

        it('returns a mathjs BigNumber', function () {
            const mathjs = require('mathjs');
            const result = u.getWallClockTime();
            expect(mathjs.isBigNumber(result)).to.be.true;
        });

    });

    describe('startTimer() / getTimer()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('startTimer returns a numeric timestamp', function () {
            const t = u.startTimer();
            expect(t).to.be.a('number');
            expect(t).to.be.closeTo(Date.now(), 50);
        });

        it('getTimer returns elapsed ms >= 0', function () {
            const t  = u.startTimer();
            const ms = u.getTimer(t);
            expect(ms).to.be.a('number');
            expect(ms).to.be.gte(0);
        });

        it('getTimer returns a small value for a recent timer (not now + timer)', function () {
            const t  = u.startTimer();
            const ms = u.getTimer(t);
            // If it were now + timer, result would be ~2 * Date.now() which is huge
            expect(ms).to.be.lessThan(1000);
        });

    });
});

describe("Utility", function () {
    describe('getTimerString()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('returns "0ms" for 0 milliseconds', function () {
            expect(u.getTimerString(0)).to.equal('0ms');
        });

        it('returns the time string (not ms format) for non-zero values', function () {
            // 5000ms = 5 seconds, so should return the human-readable form not "5000ms"
            const result = u.getTimerString(5000);
            expect(result).to.include('s');
            expect(result).to.not.equal('5000ms');
        });

    });
});

describe("Utility", function () {
    describe('logTimer()', function () {

        let u;
        let stub;
        let timerStub;
        before(function () { u = makeUtil(); });
        afterEach(function () {
            if (stub) { stub.restore(); stub = null; }
            if (timerStub) { timerStub.restore(); timerStub = null; }
        });

        it('logs one TIMER event', function () {
            stub = logWithTimerStub(u, 'TestTimer');
            expect(stub.calledOnce).to.be.true;
            expect(stub.firstCall.args[0]).to.equal('TIMER');
        });

        it('uses "Time" label when timeName is null', function () {
            stub = logWithTimerStub(u, null);
            const output = stub.firstCall.args[1].timer;
            expect(output).to.match(/^Time/);
        });

        it('uses provided timeName as label', function () {
            stub = logWithTimerStub(u, 'MyLabel');
            const output = stub.firstCall.args[1].timer;
            expect(output).to.match(/^MyLabel/);
            expect(output).to.not.include('Time');
        });

        it('appends elapsed time with tab, parens, and closing paren', function () {
            // Use a timer from the past to ensure non-zero elapsed time
            stub = logWithTimerStub(u, 'Elapsed', Date.now() - 5000);
            const output = stub.firstCall.args[1].timer;
            expect(output).to.include('\t: (');
            expect(output).to.match(/\)$/);
        });

        it('does not append tab section when getTimer returns 0 (empty timeString)', function () {
            stub = sinon.stub(log, 'info');
            // Stub getTimer itself rather than racing Date.now(): a real clock read
            // can tick past 0ms on a slow run and make the empty-timeString branch
            // untestable, so force it deterministically instead.
            timerStub = sinon.stub(u, 'getTimer').returns(0);
            u.logTimer(0, 'Quick');
            const output = stub.firstCall.args[1].timer;
            // millisecondsToTimeString(0) is '', so logTimer must skip the tab/elapsed
            // suffix entirely: the label alone, nothing appended.
            expect(output).to.equal('Quick');
        });

    });
});

describe("Utility", function () {
    describe('sleep()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('returns a Promise', function () {
            const p = u.sleep(1);
            expect(p).to.be.instanceof(Promise);
            return p; // let mocha handle resolution
        });

        it('resolves after approximately the given delay', async function () {
            const start = Date.now();
            await u.sleep(20);
            const elapsed = Date.now() - start;
            expect(elapsed).to.be.gte(15);
        });

    });

    describe('throwError()', function () {

        let u;
        let errorStub;
        before(function ()  { u = makeUtil(); });
        beforeEach(function () { errorStub = sinon.stub(log, 'error'); });
        afterEach(function ()  { errorStub.restore(); });

        it('throws an Error with the provided message', function () {
            expect(() => u.throwError('boom')).to.throw(Error, 'boom');
        });

        it('logs an error event before throwing', function () {
            try { u.throwError('oops'); } catch (e) { /* expected */ }
            expect(errorStub.calledOnce).to.be.true;
        });

        it('logs THROW_ERROR with the message as its err field', function () {
            try { u.throwError('test'); } catch (e) { /* expected */ }
            expect(errorStub.firstCall.args).to.deep.equal(['THROW_ERROR', { err: 'test' }]);
        });

    });
});

describe("Utility", function () {
    describe('logError()', function () {

        let u;
        let errorStub;
        before(function ()  { u = makeUtil(); });
        beforeEach(function () { errorStub = sinon.stub(log, 'error'); });
        afterEach(function ()  { errorStub.restore(); });

        it('ultimately throws (delegates to throwError)', function () {
            expect(() => u.logError('fail', {})).to.throw(Error);
        });

        it('logs LOG_ERROR with the message and info before delegating', function () {
            try { u.logError('oops', { ctx: 1 }); } catch (e) { /* expected */ }
            // First call is logError's own event, second is throwError's
            expect(errorStub.firstCall.args).to.deep.equal(['LOG_ERROR', { err: 'oops', info: { ctx: 1 } }]);
            expect(errorStub.secondCall.args[0]).to.equal('THROW_ERROR');
        });

    });

    describe('fileExists()', function () {

        let UtilityWithStub;
        let fsStub;

        beforeEach(function () {
            fsStub = { access: sinon.stub(), readFile: sinon.stub() };
            UtilityWithStub = proxyquire('../../../../../src/lib/utility', { 'fs/promises': fsStub });
        });

        it('returns true when fs.access resolves', async function () {
            fsStub.access.resolves();
            const u = new UtilityWithStub(null);
            const result = await u.fileExists('/some/file.txt');
            expect(result).to.be.true;
        });

        it('returns false when fs.access rejects with ENOENT', async function () {
            const err  = new Error('ENOENT');
            err.code   = 'ENOENT';
            fsStub.access.rejects(err);
            const u = new UtilityWithStub(null);
            const result = await u.fileExists('/missing/file.txt');
            expect(result).to.be.false;
        });

        it('returns false when fs.access rejects with a non-ENOENT error', async function () {
            const err  = new Error('EPERM');
            err.code   = 'EPERM';
            fsStub.access.rejects(err);
            const u = new UtilityWithStub(null);
            const result = await u.fileExists('/no/permission');
            expect(result).to.be.false;
        });

    });
});

describe("Utility", function () {
    describe('fileGetContents()', function () {

        let UtilityWithStub;
        let fsStub;

        beforeEach(function () {
            fsStub = { access: sinon.stub(), readFile: sinon.stub() };
            UtilityWithStub = proxyquire('../../../../../src/lib/utility', { 'fs/promises': fsStub });
        });

        it('returns file contents as a string on success', async function () {
            fsStub.readFile.resolves('file contents here');
            const u = new UtilityWithStub(null);
            const result = await u.fileGetContents('/some/file.txt');
            expect(result).to.equal('file contents here');
        });

        it('passes utf8 encoding to readFile', async function () {
            fsStub.readFile.resolves('');
            const u = new UtilityWithStub(null);
            await u.fileGetContents('/some/file.txt');
            expect(fsStub.readFile.calledWith('/some/file.txt', 'utf8')).to.be.true;
        });

        it('returns false when readFile rejects', async function () {
            fsStub.readFile.rejects(new Error('ENOENT'));
            const u = new UtilityWithStub(null);
            const result = await u.fileGetContents('/missing.txt');
            expect(result).to.be.false;
        });

    });
});
