# Lane report: cx-xc-6013

Files touched:
- src/explorer/mount.js (mountFeeQuotePostRoute: limiter, then 1mb parser, then processFeeQuoteRequest)
- src/http/api_boot/security_headers.js (global 10kb parser now also skips POST feequote)
- docs/openapi.build.js, docs/openapi.json (postFeeQuote operation with body, 413, 429; spec regenerated)
- test/unit/http/feequote_post_route.test.js (new)

Tests: npx mocha --require ./test/setup.js --timeout 0 --exit on feequote_post_route, feequote_route, preflight_route, openapi_coverage, docs_openapi_build: 63 passing, 0 failing, 1 pending (pre-existing skip). The git grep check for app.post('/:coin/api/feequote' passes.

Notes:
- buildFeeQuotePostLimiter and isFeeQuotePostRequest already existed at the base commit; this lane only wired them.
- node_modules was absent, so npm ci --ignore-scripts was run locally (not committed).
- The src-text pins in preflight_route.test.js read src/XChainExplorer.js and src/api.js; they pass as is and were not edited.

RUN-COMPLETE fceb362b68fa381727544872c73f8001
