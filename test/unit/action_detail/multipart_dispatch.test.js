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
 ********************************************************************/

'use strict';

const assert     = require('node:assert/strict');
const { expect } = require('chai');
const sinon      = require('sinon');
const {
    resolveFilePartDetail,
    needsManifestSummary,
    attachMultipartSummary
} = require('../../../src/action-detail/multipart_dispatch.js');

describe('resolveFilePartDetail', function () {
    it('reads and builds one part detail', async function () {
        const row       = { action_index: 41, part_index: 2 };
        const detail    = { action: 'FILE', action_format: 2 };
        const readPart  = sinon.stub().resolves(row);
        const buildPart = sinon.stub().returns(detail);

        expect(await resolveFilePartDetail(41, { readPart, buildPart })).to.equal(detail);
        sinon.assert.calledOnceWithExactly(readPart, 41);
        sinon.assert.calledOnceWithExactly(buildPart, row);
    });

    it('returns null without building when the part row is null', async function () {
        const readPart  = sinon.stub().resolves(null);
        const buildPart = sinon.stub();

        expect(await resolveFilePartDetail(42, { readPart, buildPart })).to.equal(null);
        sinon.assert.calledOnceWithExactly(readPart, 42);
        sinon.assert.notCalled(buildPart);
    });

    it('propagates a rejected part reader', async function () {
        const failure   = new Error('part read failed');
        const readPart  = sinon.stub().rejects(failure);
        const buildPart = sinon.stub();

        await assert.rejects(
            resolveFilePartDetail(43, { readPart, buildPart }),
            (error) => error === failure
        );
        sinon.assert.calledOnceWithExactly(readPart, 43);
        sinon.assert.notCalled(buildPart);
    });
});

describe('needsManifestSummary', function () {
    it('accepts only format 1 as a number or decimal string', function () {
        expect(needsManifestSummary({ action_format: 1 })).to.equal(true);
        expect(needsManifestSummary({ action_format: '1' })).to.equal(true);
        for(const action_format of [0, '0', 2, '2', '01', '1.0', null, undefined])
            expect(needsManifestSummary({ action_format })).to.equal(false);
        expect(needsManifestSummary(null)).to.equal(false);
    });
});

describe('attachMultipartSummary formats', function () {
    it('does no manifest read for format 0', async function () {
        const detail       = { action: 'FILE', action_format: 0 };
        const readManifest = sinon.stub();
        const result = await attachMultipartSummary(detail, {
            readManifest,
            buildSummary: sinon.stub()
        });

        expect(result).to.equal(detail);
        sinon.assert.notCalled(readManifest);
    });

    it('reads the manifest once for format 1', async function () {
        const detail       = { action: 'FILE', action_format: 1 };
        const record       = { file_hash: 'a'.repeat(64) };
        const readManifest = sinon.stub().resolves(record);
        await attachMultipartSummary(detail, {
            readManifest,
            buildSummary: sinon.stub().returns(null)
        });

        sinon.assert.calledOnceWithExactly(readManifest);
    });

    it('does no manifest read for format 2', async function () {
        const detail       = { action: 'FILE', action_format: 2 };
        const readManifest = sinon.stub();
        const result = await attachMultipartSummary(detail, {
            readManifest,
            buildSummary: sinon.stub()
        });

        expect(result).to.equal(detail);
        sinon.assert.notCalled(readManifest);
    });
});

describe('attachMultipartSummary result shaping', function () {
    it('attaches a summary without mutating the input detail', async function () {
        const detail  = Object.freeze({ action: 'FILE', action_format: '1' });
        const record  = { result: 'complete' };
        const summary = { status: 'complete', parts_received: 2 };
        const buildSummary = sinon.stub().returns(summary);
        const result = await attachMultipartSummary(detail, {
            readManifest: sinon.stub().resolves(record),
            buildSummary
        });

        expect(result).to.deep.equal({ ...detail, multipart: summary });
        expect(result).to.not.equal(detail);
        expect(detail).to.not.have.property('multipart');
        sinon.assert.calledOnceWithExactly(buildSummary, record);
    });

    it('returns the original detail when the summary is null', async function () {
        const detail = { action: 'FILE', action_format: 1 };
        const result = await attachMultipartSummary(detail, {
            readManifest: sinon.stub().resolves(null),
            buildSummary: sinon.stub().returns(null)
        });

        expect(result).to.equal(detail);
    });

    it('propagates a rejected manifest reader', async function () {
        const failure      = new Error('manifest read failed');
        const readManifest = sinon.stub().rejects(failure);
        const buildSummary = sinon.stub();

        await assert.rejects(
            attachMultipartSummary({ action_format: 1 }, { readManifest, buildSummary }),
            (error) => error === failure
        );
        sinon.assert.calledOnceWithExactly(readManifest);
        sinon.assert.notCalled(buildSummary);
    });
});
