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

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const compression = require('../../../src/http/compression.js');
const multipart = require('../../../src/explorer/multipart_file.js');

describe('multipart_file compression ratio', function () {
    it('uses the vendored compression ratio for the inflate cap', function () {
        expect(multipart.COMPRESSION_MAX_RATIO).to.equal(compression.COMPRESSION_MAX_RATIO);
        expect(multipart.maxInflatedBytes(1000)).to.equal(compression.COMPRESSION_MAX_RATIO * 1000);
    });

    it('keeps the multipart ceiling when the ratio product exceeds it', function () {
        expect(multipart.maxInflatedBytes(multipart.MULTIPART_FILE_MAX_BYTES))
            .to.equal(multipart.MULTIPART_FILE_MAX_BYTES);
    });

    it('declares no private copy of the ratio literal', function () {
        const source = fs.readFileSync(
            path.join(__dirname, '../../../src/explorer/multipart_file.js'), 'utf8');
        expect(source).to.not.match(/const\s+COMPRESSION_MAX_RATIO\s*=\s*\d/);
    });
});
