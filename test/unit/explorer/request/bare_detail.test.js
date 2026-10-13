'use strict';

const { expect, makeExplorer, request, state } = require('../routes/explorer_routing.test/support/helpers.js');

describe('bare singular detail paths', function () {

    before(function () {
        state.explorer = makeExplorer();
    });

    describe('with a list page of the same type', function () {
        const cases = [
            ['poll', 'polls'], ['token', 'tokens'], ['address', 'addresses'], ['contract', 'contracts'],
            ['anchor', 'anchors'], ['checkpoint', 'checkpoints'], ['execution', 'executions'],
            ['bet_feed', 'bet_feeds'], ['dispenser', 'dispensers'], ['validator', 'validators']
        ];

        for (const [singular, plural] of cases) {
            it(`/BTC/${singular} redirects 302 to /BTC/${plural}`, async function () {
                const { res } = await request(state.explorer, '/BTC/' + singular);
                expect(res._redirect).to.deep.equal({ code: 302, url: '/BTC/' + plural });
                expect(res._body).to.equal(null);
            });
        }

        it('treats a trailing slash like the bare path', async function () {
            const { res } = await request(state.explorer, '/BTC/poll/');
            expect(res._redirect).to.deep.equal({ code: 302, url: '/BTC/polls' });
        });

        it('keeps the coin segment as the request spelled it', async function () {
            const { res } = await request(state.explorer, '/btc/token');
            expect(res._redirect).to.deep.equal({ code: 302, url: '/btc/tokens' });
        });
    });

    describe('with no list page of that type', function () {
        for (const singular of ['oracle', 'transaction']) {
            it(`/BTC/${singular} answers the 404 page with status 404`, async function () {
                const { res } = await request(state.explorer, '/BTC/' + singular);
                expect(res._redirect).to.equal(null);
                expect(res._status).to.equal(404);
                expect(res._body).to.be.a('string');
            });
        }

        it('answers 404 for the trailing-slash form too', async function () {
            const { res } = await request(state.explorer, '/BTC/oracle/');
            expect(res._redirect).to.equal(null);
            expect(res._status).to.equal(404);
        });
    });

    describe('left untouched', function () {
        it('serves a detail path that names a record', async function () {
            const { res } = await request(state.explorer, '/BTC/poll/abc');
            expect(res._redirect).to.equal(null);
            expect(res._status).to.equal(200);
        });

        it('serves the list page itself', async function () {
            const { res } = await request(state.explorer, '/BTC/polls');
            expect(res._redirect).to.equal(null);
            expect(res._status).to.equal(200);
        });

        it('serves the rich list bare, which prompts for a tick on its own', async function () {
            const { res } = await request(state.explorer, '/BTC/rich_list');
            expect(res._redirect).to.equal(null);
            expect(res._status).to.equal(200);
        });

        it('does not redirect a coin prefix that is not supported', async function () {
            const { res } = await request(state.explorer, '/ZZZ/poll');
            expect(res._redirect).to.equal(null);
        });

        it('sends a supported but unconfigured coin to the unavailable page', async function () {
            const { res } = await request(state.explorer, '/LTC/poll');
            expect(res._redirect).to.equal(null);
            expect(res._status).to.equal(200);
        });

        it('does not touch an api path', async function () {
            const { res, cfg } = await request(state.explorer, '/BTC/api/polls');
            expect(res._redirect).to.equal(null);
            expect(cfg.type).to.equal('api');
        });
    });
});
