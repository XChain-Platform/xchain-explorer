'use strict';

const { srcText } = require('../../helpers/source_text');
const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

describe('POST /{COIN}/api/feequote mount', function () {
    const MOUNT = srcText('src/explorer/mount.js');
    const HEADERS = srcText('src/http/api_boot/security_headers.js');

    it('registers the POST route with its own limiter before the body parser', function () {
        expect(MOUNT).to.match(/app\.post\('\/:coin\/api\/feequote',\s*feeQuotePostLimiter,\s*express\.json\(\{\s*limit:\s*PREFLIGHT_BODY_LIMIT\s*\}\)/);
        expect(MOUNT).to.match(/buildFeeQuotePostLimiter\(host\)/);
    });

    it('routes the global 10kb parser around that one request', function () {
        expect(HEADERS).to.match(/isFeeQuotePostRequest\(req\)/);
        expect(HEADERS).to.match(/express\.json\(\{\s*limit:\s*'10kb'\s*\}\)/);
    });

    it('documents the POST in openapi.json', function () {
        const spec = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../docs/openapi.json'), 'utf8'));
        const op = spec.paths['/{COIN}/api/feequote'].post;
        expect(op.operationId).to.equal('postFeeQuote');
        expect(op.requestBody.content['application/json'].schema.required).to.deep.equal(['action']);
        expect(op.responses).to.have.property('429');
    });
});
