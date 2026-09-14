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

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire').noCallThru();

// Collapse retry backoff to zero so the retry-path tests run instantly;
// the connector reads this env var in its constructor.
process.env.HUB_RETRY_DELAY_MS = '0';

function makeAxiosStub() {
    return { post: sinon.stub() };
}

function loadConnector(axiosStub) {
    return proxyquire('../../../src/connectors/hub', {
        'axios': axiosStub
    });
}

// Axios-style error for a non-2xx response that still carries a valid JSON-RPC
// body (e.g. the hub's HTTP 503 "degraded" response when its DB pool is down);
// axios attaches the full response to the thrown error as err.response.
function degraded503Error(body) {
    const err = new Error('Request failed with status code 503');
    err.response = {
        status: 503,
        data: { jsonrpc: '2.0', id: 1, result: body || { status: 'degraded', db: false } }
    };
    return err;
}

module.exports = { sinon, expect, makeAxiosStub, loadConnector, degraded503Error };
