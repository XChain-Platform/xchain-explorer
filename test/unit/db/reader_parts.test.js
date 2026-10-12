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

const { expect } = require('chai');
const { mixinReaders, composeReaderParts } = require('../../../src/db/reader_parts.js');

const COLLISION = 'db.js reader mixin collision: shared is defined twice';

class ReaderA {
    a() { return 'a'; }
}

class ReaderB {
    b() { return 'b'; }
}

class AccessorReader {
    get value() { return 42; }
}

describe('reader part composition', function() {
    it('copies methods from every source and skips constructors', function() {
        const target = {};
        mixinReaders(target, ReaderA.prototype, ReaderB.prototype);

        expect(target.a()).to.equal('a');
        expect(target.b()).to.equal('b');
        expect(target).to.not.have.own.property('constructor');
    });

    it('preserves getter and class method descriptors', function() {
        const target = {};
        mixinReaders(target, AccessorReader.prototype, ReaderA.prototype);

        expect(Object.getOwnPropertyDescriptor(target, 'value').get)
            .to.equal(Object.getOwnPropertyDescriptor(AccessorReader.prototype, 'value').get);
        expect(Object.getOwnPropertyDescriptor(target, 'a').enumerable).to.equal(false);
    });

    it('rejects a name already defined on the target', function() {
        const target = { shared() {} };
        const source = { shared() {} };

        expect(() => mixinReaders(target, source)).to.throw()
            .with.property('message', COLLISION);
    });

    it('rejects a name defined by two sources', function() {
        const first = { shared() {} };
        const second = { shared() {} };

        expect(() => mixinReaders({}, first, second)).to.throw()
            .with.property('message', COLLISION);
    });

    it('composes every prototype into a new plain object', function() {
        const composed = composeReaderParts(ReaderA.prototype, ReaderB.prototype);

        expect(Object.getPrototypeOf(composed)).to.equal(Object.prototype);
        expect(composed).to.not.equal(ReaderA.prototype);
        expect(composed).to.not.equal(composeReaderParts());
        expect(composed.a()).to.equal('a');
        expect(composed.b()).to.equal('b');
    });

    it('rejects duplicate names while composing', function() {
        const first = { shared() {} };
        const second = { shared() {} };

        expect(() => composeReaderParts(first, second)).to.throw()
            .with.property('message', COLLISION);
    });

    it('returns an empty object when no prototypes are provided', function() {
        expect(composeReaderParts()).to.deep.equal({});
    });
});
