'use strict';

const { srcText } = require('../../helpers/source_text');

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const XChainExplorer = require('../../../src/XChainExplorer.js');

const MOUNT = srcText('src/explorer/mount.js');
const SPEC = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '../../docs/openapi.json'), 'utf8'));

describe('POST /{COIN}/api/feequote wiring', function () {
    it('registers the route behind its own limiter, before the body parser', function () {
        expect(MOUNT).to.match(/app\.post\('\/:coin\/api\/feequote',\s*feeQuotePostLimiter,\s*express\.json\(\{\s*limit:\s*PREFLIGHT_BODY_LIMIT\s*\}\)/);
    });

    it('exempts only POST feequote from the global parser', function () {
        const yes = (method, p) => XChainExplorer.isFeeQuotePostRequest({ method, path: p });
        expect(yes('POST', '/RBTC/api/feequote')).to.equal(true);
        expect(yes('GET', '/RBTC/api/feequote')).to.equal(false);
        expect(yes('POST', '/RBTC/api/feeschedule')).to.equal(false);
        expect(srcText('src/http/api_boot/security_headers.js')).to.match(/isFeeQuotePostRequest\(req\)/);
    });

    it('is documented with a request body in openapi.json', function () {
        const item = SPEC.paths['/{COIN}/api/feequote'];
        expect(item.get).to.be.an('object');
        expect(item.post.operationId).to.equal('postFeeQuote');
        expect(item.post.requestBody.content['application/json'].schema.required).to.deep.equal(['action']);
        expect(item.post.responses).to.have.property('429');
    });
});
