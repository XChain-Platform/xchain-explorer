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
const sinon      = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

// Real Utility (no stubbing of fs yet; we stub per-suite where needed)
const Utility = require('../../../../../src/lib/utility');
// The same lazy logger object lib/utility.js holds, so a stub on it sees every event
// whether or not an earlier suite installed the real shipper.
const log = require('../../../../../src/observability').getLogger();

function makeUtil(configInfo) {
    return new Utility(configInfo || null);
}

function makeStablePriceRows(entries) {
    return entries.map(([price, id]) => ({ price, id }));
}

function stringifyBigInt(util) {
    const obj = { amount: 9007199254740993n };
    return JSON.parse(util.jsonStringify(obj));
}

function stringifyBigNumber(util) {
    const mathjs = require('mathjs');
    const bn = mathjs.bignumber('123456789.987654321');
    const obj = { price: bn };
    return JSON.parse(util.jsonStringify(obj));
}

function stringifySimpleValues(util) {
    const obj = { a: 'text', b: 42, c: true };
    return JSON.parse(util.jsonStringify(obj));
}

function stringifyNestedBigNumber(util) {
    const mathjs = require('mathjs');
    const obj = { items: [{ val: mathjs.bignumber('999') }] };
    return JSON.parse(util.jsonStringify(obj));
}

function logWithTimerStub(util, name, timer) {
    const stub = sinon.stub(log, 'info');
    util.logTimer(timer === undefined ? util.startTimer() : timer, name);
    return stub;
}

module.exports = {
    expect, sinon, proxyquire, Utility, log, makeUtil, makeStablePriceRows,
    stringifyBigInt, stringifyBigNumber, stringifySimpleValues,
    stringifyNestedBigNumber, logWithTimerStub
};
