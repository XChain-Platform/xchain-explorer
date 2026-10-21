# Lane report: cx-xc-6013

## Files touched
- src/explorer/mount.js: new mountFeeQuotePostRoute (buildFeeQuotePostLimiter, then express.json at PREFLIGHT_BODY_LIMIT, then the shared handler)
- src/http/api_boot/security_headers.js: global 10kb parser skips POST /:coin/api/feequote
- docs/openapi.build.js, docs/openapi.json (regenerated): postFeequote documented with 413 and 429
- test/unit/http/feequote_post_route.test.js: new

## Tests
- Verify command from the brief: 64 passing, 1 pending (pre-existing), 0 failing.
- api_boot suite and jsonrpc_body_guard: run, no failures.

## Notes
- processFeeQuoteRequest (src/explorer/fees_preflight.js, outside Surfaces) reads only req.query. Rather than edit it, the POST handler passes it a view of the request whose query is the JSON body, so GET and POST share one code path.
- The global-parser bypass uses a local predicate in security_headers.js, since isPreflightPostRequest lives in fees_preflight.js (outside Surfaces).
- buildFeeQuotePostLimiter and its EXPLORER_FEE_QUOTE_POST_RATE_LIMIT_RPM knob already existed (default 60/min).
- npm ci was run locally to run tests; node_modules is untracked and not committed.

RUN-COMPLETE c506ecdd1af43af8e052345e4c5a77e5
