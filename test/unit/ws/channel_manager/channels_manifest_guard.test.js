// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Every action name the subscribe validator admits must be a manifest action,
// unless it is a lifecycle or phase event the change detector synthesizes, or one
// of the settlement anchor rows the indexer mints outside its dispatch switch.
// A new admitted name that is neither fails here instead of reaching a client as
// a filter that names no protocol action.

'use strict';

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const { VALID_TYPES } = require('../../../../src/ws/channel_manager/channels.js');

const MANIFEST = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'fixtures', 'action-manifest.json'), 'utf8'));

const LIFECYCLE_EVENTS = [
    'COINPAY_REQUIRED', 'COINPAY_FULFILLED', 'COINPAY_EXPIRED',
    'ORDER_EXPIRED', 'SWAP_EXPIRED',
    'DISPENSER_CLOSED', 'DISPENSER_EXPIRED',
    'BET_EXPIRED', 'BET_CLOSED',
    'XCALL_COMPLETED', 'XCALL_EXPIRED',
    'ATTESTATION_REQUEST', 'ATTESTATION_RESPONSE'
];
const EXEMPT = new Set(LIFECYCLE_EVENTS);

describe('channel manager type names against the action manifest', function () {

    it('gives every admitted action name a manifest entry', function () {
        const manifest = new Set([...Object.keys(MANIFEST.actions), ...Object.keys(MANIFEST.aliases || {})]);
        const unmanifested = [...VALID_TYPES].filter((type) => !manifest.has(type) && !EXEMPT.has(type));

        expect(unmanifested).to.deep.equal([]);
    });

    it('keeps the exemption list to names the validator really admits', function () {
        const stale = [...EXEMPT].filter((type) => !VALID_TYPES.has(type));

        expect(stale).to.deep.equal([]);
    });

    it('does not exempt a name that already has a manifest entry', function () {
        const redundant = [...EXEMPT].filter((type) => Object.prototype.hasOwnProperty.call(MANIFEST.actions, type));

        expect(redundant).to.deep.equal([]);
    });

});
