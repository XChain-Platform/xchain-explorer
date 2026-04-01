'use strict';

const { expect } = require('chai');
const sinon      = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Real Utility (no stubbing of fs yet — we stub per-suite where needed)
const Utility = require('../../src/utility');

function makeUtil(configInfo) {
    return new Utility(configInfo || null);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Utility', function () {

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    describe('constructor', function () {

        it('stores configInfo on the instance', function () {
            const cfg = { foo: 'bar' };
            const u   = new Utility(cfg);
            expect(u.configInfo).to.equal(cfg);
        });

        it('accepts null configInfo without throwing', function () {
            expect(() => new Utility(null)).to.not.throw();
        });

    });

    // -----------------------------------------------------------------------
    // isNull
    // -----------------------------------------------------------------------

    describe('isNull()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('returns true for null', function ()      { expect(u.isNull(null)).to.be.true; });
        it('returns true for undefined', function () { expect(u.isNull(undefined)).to.be.true; });
        it('returns true for empty string', function () { expect(u.isNull('')).to.be.true; });

        it('returns false for 0', function ()        { expect(u.isNull(0)).to.be.false; });
        it('returns false for false', function ()    { expect(u.isNull(false)).to.be.false; });
        it('returns false for a non-empty string', function () { expect(u.isNull('hello')).to.be.false; });
        it('returns false for an object', function () { expect(u.isNull({})).to.be.false; });
        it('returns false for an array', function () { expect(u.isNull([])).to.be.false; });

    });

    // -----------------------------------------------------------------------
    // isNumeric
    // -----------------------------------------------------------------------

    describe('isNumeric()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('returns true for an integer',       function () { expect(u.isNumeric(42)).to.be.true; });
        it('returns true for a float',          function () { expect(u.isNumeric(3.14)).to.be.true; });
        it('returns true for a numeric string', function () { expect(u.isNumeric('100')).to.be.true; });
        it('returns true for a float string',   function () { expect(u.isNumeric('3.14')).to.be.true; });
        it('returns true for a bigint',         function () { expect(u.isNumeric(9007199254740993n)).to.be.true; });
        it('returns true for 0',                function () { expect(u.isNumeric(0)).to.be.true; });
        it('returns true for negative number',  function () { expect(u.isNumeric(-5)).to.be.true; });

        it('returns false for a non-numeric string', function () { expect(u.isNumeric('abc')).to.be.false; });
        it('returns false for null',                 function () { expect(u.isNumeric(null)).to.be.false; });
        it('returns false for undefined',            function () { expect(u.isNumeric(undefined)).to.be.false; });
        it('returns false for Infinity',             function () { expect(u.isNumeric(Infinity)).to.be.false; });
        it('returns false for NaN',                  function () { expect(u.isNumeric(NaN)).to.be.false; });
        it('returns false for an empty string',      function () { expect(u.isNumeric('')).to.be.false; });

    });

    // -----------------------------------------------------------------------
    // isFloat
    // -----------------------------------------------------------------------

    describe('isFloat()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('returns true for a JS float',       function () { expect(u.isFloat(1.5)).to.be.true; });
        it('returns true for a negative float', function () { expect(u.isFloat(-0.001)).to.be.true; });

        it('returns false for an integer',      function () { expect(u.isFloat(4)).to.be.false; });
        it('returns false for 0',               function () { expect(u.isFloat(0)).to.be.false; });
        it('returns false for a string',        function () { expect(u.isFloat('1.5')).to.be.false; });
        it('returns false for NaN',             function () { expect(u.isFloat(NaN)).to.be.false; });

    });

    // -----------------------------------------------------------------------
    // isInteger
    // -----------------------------------------------------------------------

    describe('isInteger()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('returns true for a positive integer', function () { expect(u.isInteger(10)).to.be.true; });
        it('returns true for 0',                  function () { expect(u.isInteger(0)).to.be.true; });
        it('returns true for a negative integer', function () { expect(u.isInteger(-3)).to.be.true; });

        it('returns false for a float',  function () { expect(u.isInteger(1.5)).to.be.false; });
        it('returns false for a string', function () { expect(u.isInteger('4')).to.be.false; });
        it('returns false for NaN',      function () { expect(u.isInteger(NaN)).to.be.false; });

    });

    // -----------------------------------------------------------------------
    // bcnum / bcformat
    // -----------------------------------------------------------------------

    describe('bcnum()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('converts an integer string to a bignumber', function () {
            const bn = u.bcnum('12345');
            expect(bn.toString()).to.equal('12345');
        });

        it('converts a JS number to a bignumber', function () {
            const bn = u.bcnum(99);
            expect(bn.toString()).to.equal('99');
        });

        it('preserves precision beyond JS float limit', function () {
            const bn = u.bcnum('99999999999999999999');
            expect(bn.toString()).to.equal('99999999999999999999');
        });

    });

    describe('bcformat()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('formats to 0 decimal places by default (null decimals)', function () {
            expect(u.bcformat('3.7', null)).to.equal('4');
        });

        it('formats to the specified number of decimal places', function () {
            expect(u.bcformat('3.14159', 2)).to.equal('3.14');
        });

        it('pads with zeros when precision exceeds significant digits', function () {
            expect(u.bcformat('1', 4)).to.equal('1.0000');
        });

        it('handles a zero value', function () {
            expect(u.bcformat('0', 2)).to.equal('0.00');
        });

    });

    // -----------------------------------------------------------------------
    // bcsub / bcadd / bcmul / bcdiv
    // -----------------------------------------------------------------------

    describe('bcsub()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('subtracts two integers', function () {
            expect(u.bcsub(10, 3, 0).toString()).to.equal('7');
        });

        it('subtracts with decimal precision', function () {
            expect(u.bcsub('1.500', '0.375', 3).toString()).to.equal('1.125');
        });

        it('treats null numA as 0', function () {
            expect(u.bcsub(null, 3, 0).toString()).to.equal('-3');
        });

        it('treats null numB as 0', function () {
            expect(u.bcsub(5, null, 0).toString()).to.equal('5');
        });

        it('handles large numbers without precision loss', function () {
            expect(u.bcsub('100000000000000000000', '1', 0).toString())
                .to.equal('99999999999999999999');
        });

    });

    describe('bcadd()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('adds two integers', function () {
            expect(u.bcadd(7, 3, 0).toString()).to.equal('10');
        });

        it('adds with decimal precision', function () {
            expect(u.bcadd('0.1', '0.2', 1).toString()).to.equal('0.3');
        });

        it('treats null inputs as 0', function () {
            expect(u.bcadd(null, null, 0).toString()).to.equal('0');
        });

        it('handles large number addition', function () {
            expect(u.bcadd('99999999999999999999', '1', 0).toString())
                .to.equal('100000000000000000000');
        });

    });

    describe('bcmul()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('multiplies two integers', function () {
            expect(u.bcmul(6, 7, 0).toString()).to.equal('42');
        });

        it('multiplies with decimal precision', function () {
            // mathjs trims trailing zeros on exact results; 2.5 * 4 = 10 exactly
            expect(u.bcmul('2.5', '4', 1).toString()).to.equal('10');
        });

        it('returns 0 when one operand is 0', function () {
            expect(u.bcmul(0, '9999', 0).toString()).to.equal('0');
        });

        it('treats null input as 0', function () {
            expect(u.bcmul(null, 5, 0).toString()).to.equal('0');
        });

        it('handles high-precision fractional result', function () {
            expect(u.bcmul('0.1', '0.1', 2).toString()).to.equal('0.01');
        });

    });

    describe('bcdiv()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('divides two integers', function () {
            expect(u.bcdiv(10, 2, 0).toString()).to.equal('5');
        });

        it('divides with decimal precision', function () {
            expect(u.bcdiv(1, 3, 8).toString()).to.equal('0.33333333');
        });

        it('returns 0 for 0 numerator', function () {
            expect(u.bcdiv(0, 5, 0).toString()).to.equal('0');
        });

        it('treats null numerator as 0', function () {
            expect(u.bcdiv(null, 4, 0).toString()).to.equal('0');
        });

        it('handles large number division', function () {
            expect(u.bcdiv('1000000000000000000', '3', 0).toString())
                .to.equal('333333333333333333');
        });

    });

    // -----------------------------------------------------------------------
    // Comparison operators
    // -----------------------------------------------------------------------

    describe('bcgt()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('returns true when numA > numB',  function () { expect(u.bcgt(5, 3)).to.be.true; });
        it('returns false when numA === numB', function () { expect(u.bcgt(3, 3)).to.be.false; });
        it('returns false when numA < numB', function () { expect(u.bcgt(1, 3)).to.be.false; });

    });

    describe('bclt()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('returns true when numA < numB',    function () { expect(u.bclt(1, 3)).to.be.true; });
        it('returns false when numA === numB', function () { expect(u.bclt(3, 3)).to.be.false; });
        it('returns false when numA > numB',  function () { expect(u.bclt(5, 3)).to.be.false; });

    });

    describe('bcgte()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('returns true when numA > numB',   function () { expect(u.bcgte(5, 3)).to.be.true; });
        it('returns true when numA === numB', function () { expect(u.bcgte(3, 3)).to.be.true; });
        it('returns false when numA < numB',  function () { expect(u.bcgte(1, 3)).to.be.false; });

    });

    describe('bclte()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('returns true when numA < numB',   function () { expect(u.bclte(1, 3)).to.be.true; });
        it('returns true when numA === numB', function () { expect(u.bclte(3, 3)).to.be.true; });
        it('returns false when numA > numB',  function () { expect(u.bclte(5, 3)).to.be.false; });

    });

    // -----------------------------------------------------------------------
    // getPrice
    // -----------------------------------------------------------------------

    describe('getPrice()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('returns numerator / denominator at default 64 decimal precision', function () {
            const price = u.getPrice(1, 3);
            // result should have 64 decimal places
            const str = price.toString();
            const decimals = str.split('.')[1];
            expect(decimals).to.have.lengthOf(64);
        });

        it('respects a custom precision parameter', function () {
            const price = u.getPrice(1, 3, 8);
            expect(price.toString()).to.equal('0.33333333');
        });

        it('returns 0 when numerator is 0', function () {
            const price = u.getPrice(0, 100, 4);
            // mathjs trims trailing zeros on exact zero results
            expect(price.toString()).to.equal('0');
        });

        it('handles string inputs', function () {
            const price = u.getPrice('10', '4', 2);
            // 10/4 = 2.5 exactly; mathjs trims trailing zero
            expect(price.toString()).to.equal('2.5');
        });

    });

    // -----------------------------------------------------------------------
    // priceSort
    // -----------------------------------------------------------------------

    describe('priceSort()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('sorts ASC by default', function () {
            const data = [{ price: 3 }, { price: 1 }, { price: 2 }];
            const sorted = u.priceSort(data);
            expect(sorted.map(d => d.price)).to.deep.equal([1, 2, 3]);
        });

        it('sorts ASC when explicitly requested', function () {
            const data = [{ price: 10 }, { price: 5 }, { price: 7 }];
            const sorted = u.priceSort(data, 'ASC');
            expect(sorted.map(d => d.price)).to.deep.equal([5, 7, 10]);
        });

        it('sorts DESC when requested', function () {
            const data = [{ price: 1 }, { price: 5 }, { price: 3 }];
            const sorted = u.priceSort(data, 'DESC');
            expect(sorted.map(d => d.price)).to.deep.equal([5, 3, 1]);
        });

        it('returns the same array reference (in-place sort)', function () {
            const data = [{ price: 2 }, { price: 1 }];
            const result = u.priceSort(data);
            expect(result).to.equal(data);
        });

        it('handles equal prices without throwing', function () {
            const data = [{ price: 2 }, { price: 2 }, { price: 1 }];
            expect(() => u.priceSort(data)).to.not.throw();
        });

    });

    // -----------------------------------------------------------------------
    // jsonStringify
    // -----------------------------------------------------------------------

    describe('jsonStringify()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('serializes a plain object normally', function () {
            const obj = { a: 1, b: 'hello' };
            expect(u.jsonStringify(obj)).to.equal(JSON.stringify(obj));
        });

        it('converts BigInt values to strings', function () {
            const obj = { amount: 9007199254740993n };
            const result = JSON.parse(u.jsonStringify(obj));
            expect(result.amount).to.equal('9007199254740993');
        });

        it('converts a mathjs BigNumber to its value string', function () {
            const mathjs = require('mathjs');
            const bn  = mathjs.bignumber('123456789.987654321');
            const obj = { price: bn };
            const result = JSON.parse(u.jsonStringify(obj));
            expect(result.price).to.equal('123456789.987654321');
        });

        it('handles null values without throwing', function () {
            expect(u.jsonStringify({ x: null })).to.equal('{"x":null}');
        });

    });

    // -----------------------------------------------------------------------
    // ksort
    // -----------------------------------------------------------------------

    describe('ksort()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('returns object with keys in alphabetical order', function () {
            const obj    = { z: 3, a: 1, m: 2 };
            const sorted = u.ksort(obj);
            expect(Object.keys(sorted)).to.deep.equal(['a', 'm', 'z']);
        });

        it('preserves the values', function () {
            const obj    = { b: 'bee', a: 'ay' };
            const sorted = u.ksort(obj);
            expect(sorted.a).to.equal('ay');
            expect(sorted.b).to.equal('bee');
        });

        it('handles an already-sorted object', function () {
            const obj    = { a: 1, b: 2, c: 3 };
            const sorted = u.ksort(obj);
            expect(Object.keys(sorted)).to.deep.equal(['a', 'b', 'c']);
        });

        it('handles a single-key object', function () {
            const sorted = u.ksort({ only: true });
            expect(Object.keys(sorted)).to.deep.equal(['only']);
        });

    });

    // -----------------------------------------------------------------------
    // millisecondsToTimeString
    // -----------------------------------------------------------------------

    describe('millisecondsToTimeString()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('returns empty string for 0 ms', function () {
            expect(u.millisecondsToTimeString(0)).to.equal('');
        });

        it('returns seconds component for values under 1 minute', function () {
            const result = u.millisecondsToTimeString(5000);
            expect(result).to.include('5.');
            expect(result).to.include('s');
        });

        it('includes minutes for values >= 60 seconds', function () {
            const result = u.millisecondsToTimeString(90000);
            expect(result).to.include('m');
            expect(result).to.include('s');
        });

        it('includes hours for values >= 1 hour', function () {
            const result = u.millisecondsToTimeString(3600000 + 60000);
            expect(result).to.include('h');
            expect(result).to.include('m');
        });

        it('includes days for values >= 1 day', function () {
            const result = u.millisecondsToTimeString(86400000 + 3600000);
            expect(result).to.include('d');
            expect(result).to.include('h');
        });

        it('pads hours and minutes to two digits', function () {
            const result = u.millisecondsToTimeString(3661000); // 1h 1m 1s
            expect(result).to.include('01h');
            expect(result).to.include('01m');
        });

    });

    // -----------------------------------------------------------------------
    // getCurrentTime
    // -----------------------------------------------------------------------

    describe('getCurrentTime()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('returns a value close to Math.floor(Date.now()/1000)', function () {
            const expected = Math.floor(Date.now() / 1000);
            const result   = parseInt(u.getCurrentTime().toString());
            // Allow a 2-second window for slow test environments
            expect(result).to.be.within(expected - 2, expected + 2);
        });

        it('returns a mathjs BigNumber', function () {
            const mathjs = require('mathjs');
            const result = u.getCurrentTime();
            expect(mathjs.isBigNumber(result)).to.be.true;
        });

    });

    // -----------------------------------------------------------------------
    // Timer helpers (startTimer / getTimer / getTimerString / logTimer)
    // -----------------------------------------------------------------------

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

    });

    describe('getTimerString()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('returns "0ms" for 0 milliseconds', function () {
            expect(u.getTimerString(0)).to.equal('0ms');
        });

        it('returns a time string with "s" for 5000ms', function () {
            const result = u.getTimerString(5000);
            expect(result).to.include('s');
        });

    });

    describe('logTimer()', function () {

        let u;
        let stub;
        before(function () { u = makeUtil(); });
        afterEach(function () { if (stub) { stub.restore(); stub = null; } });

        it('calls console.log once', function () {
            stub = sinon.stub(console, 'log');
            const t = u.startTimer();
            u.logTimer(t, 'TestTimer');
            expect(stub.calledOnce).to.be.true;
        });

        it('uses "Time" label when timeName is null', function () {
            stub = sinon.stub(console, 'log');
            const t = u.startTimer();
            u.logTimer(t, null);
            const output = stub.firstCall.args[0];
            expect(output).to.include('Time');
        });

    });

    // -----------------------------------------------------------------------
    // sleep
    // -----------------------------------------------------------------------

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

    // -----------------------------------------------------------------------
    // throwError / logError
    // -----------------------------------------------------------------------

    describe('throwError()', function () {

        let u;
        let consoleStub;
        before(function ()  { u = makeUtil(); });
        beforeEach(function () { consoleStub = sinon.stub(console, 'error'); });
        afterEach(function ()  { consoleStub.restore(); });

        it('throws an Error with the provided message', function () {
            expect(() => u.throwError('boom')).to.throw(Error, 'boom');
        });

        it('logs to console.error before throwing', function () {
            try { u.throwError('oops'); } catch (e) { /* expected */ }
            expect(consoleStub.calledOnce).to.be.true;
        });

    });

    describe('logError()', function () {

        let u;
        let consoleStub;
        before(function ()  { u = makeUtil(); });
        beforeEach(function () { consoleStub = sinon.stub(console, 'error'); });
        afterEach(function ()  { consoleStub.restore(); });

        it('ultimately throws (delegates to throwError)', function () {
            expect(() => u.logError('fail', {})).to.throw(Error);
        });

    });

    // -----------------------------------------------------------------------
    // fileExists (stubbing fs/promises)
    // -----------------------------------------------------------------------

    describe('fileExists()', function () {

        let UtilityWithStub;
        let fsStub;

        beforeEach(function () {
            fsStub = { access: sinon.stub(), readFile: sinon.stub() };
            UtilityWithStub = proxyquire('../../src/utility', { 'fs/promises': fsStub });
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

    // -----------------------------------------------------------------------
    // fileGetContents (stubbing fs/promises)
    // -----------------------------------------------------------------------

    describe('fileGetContents()', function () {

        let UtilityWithStub;
        let fsStub;

        beforeEach(function () {
            fsStub = { access: sinon.stub(), readFile: sinon.stub() };
            UtilityWithStub = proxyquire('../../src/utility', { 'fs/promises': fsStub });
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
