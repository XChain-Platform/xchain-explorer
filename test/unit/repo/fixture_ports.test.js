'use strict';

const assert = require('assert');
const ports = require('../../../bin/fixture-ports.js');

describe('fixture ports', function () {
    it('keeps base ports when CI_PORT_OFFSET is absent or zero', function () {
        assert.strictEqual(ports.port('XCHAIN_EXPLORER_DB_PORT', {}), 3307);
        assert.strictEqual(ports.port('XCHAIN_EXPLORER_CHAOS_API_PORT', { CI_PORT_OFFSET: '0' }), 8474);
    });

    it('adds CI_PORT_OFFSET to host ports', function () {
        const env = { CI_PORT_OFFSET: '10700' };
        assert.strictEqual(ports.port('XCHAIN_EXPLORER_DB_PORT', env), 14007);
        assert.strictEqual(ports.port('XCHAIN_EXPLORER_CHAOS_API_PORT', env), 19174);
    });

    it('does not add the offset to an explicit final port override', function () {
        const env = { CI_PORT_OFFSET: '10700', XCHAIN_EXPLORER_DB_PORT: '41000' };
        assert.strictEqual(ports.port('XCHAIN_EXPLORER_DB_PORT', env), 41000);
    });

    it('rejects invalid offsets and out-of-range results', function () {
        assert.throws(() => ports.port('XCHAIN_EXPLORER_DB_PORT', { CI_PORT_OFFSET: '-1' }), /non-negative integer/);
        assert.throws(() => ports.port('XCHAIN_EXPLORER_DB_PORT', { CI_PORT_OFFSET: '63000' }), /TCP port range/);
    });
});
