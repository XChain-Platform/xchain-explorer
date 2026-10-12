'use strict';

const assert = require('assert');
const { limitedHandler } = require('../../../src/http/rate_limit_log.js');

function build(clock) {
    const lines = [];
    const handler = limitedHandler({
        service: 'Explorer', name: 'n', envVar: 'ENV', limit: 5, windowMs: 60000,
        message: { error: 'x' }, log: l => lines.push(l), now: () => clock.t
    });
    const res = { status() { return this; }, json() { return this; } };
    return { lines, hit: () => handler({}, res, () => {}, {}) };
}

describe('rate limit line span', function () {
    it('reports the window on the first line', function () {
        const clock = { t: 1000 };
        const { lines, hit } = build(clock);
        hit();
        assert.ok(lines[0].includes('in the last 60 s'));
    });

    it('reports the real gap since the previous line, not zero', function () {
        const clock = { t: 1000 };
        const { lines, hit } = build(clock);
        hit();
        clock.t += 90000;
        hit();
        assert.strictEqual(lines.length, 2);
        assert.ok(lines[1].includes('in the last 90 s'), lines[1]);
    });

    it('suppresses inside the window and counts the suppressed refusals', function () {
        const clock = { t: 1000 };
        const { lines, hit } = build(clock);
        hit();
        clock.t += 10000; hit();
        clock.t += 10000; hit();
        clock.t += 50000; hit();
        assert.strictEqual(lines.length, 2);
        assert.ok(lines[1].includes('3 requests refused in the last 70 s'), lines[1]);
    });
});
