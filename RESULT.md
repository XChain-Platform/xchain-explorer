# Lane report: cx-xc-6013

## Files touched
- src/explorer/mount.js (mountFeeQuotePostRoute: limiter, then 1mb parser, then processFeeQuoteRequest)
- src/http/api_boot/security_headers.js (global 10kb parser also skips POST feequote)
- docs/openapi.build.js, docs/openapi.json (postFeeQuote operation with body, 413, 429)
- test/unit/http/feequote_post_route.test.js (new)

## Tests
Verify command from the brief: 65 passing, 1 pending (pre-existing skip), 0 failing.

## Notes
- buildFeeQuotePostLimiter, isFeeQuotePostRequest and the POST body path in the handler already existed at the base commit.
- npm ci --ignore-scripts was run to get node_modules; nothing from it is committed.

RUN-COMPLETE abbe77be857ed0871a3bb9d1ce1db147
