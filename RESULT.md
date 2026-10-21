# Lane report: cx-xc-6013

## Files touched
- src/explorer/mount.js: new mountFeeQuotePostRoute (limiter, then express.json at PREFLIGHT_BODY_LIMIT, then handler), called after mountPreflightPostRoute
- src/http/api_boot/security_headers.js: isFeeQuotePostRequest, global 10kb parser skipped for it
- docs/openapi.build.js, docs/openapi.json: postFeeQuote operation (regenerated)
- test/unit/http/feequote_post_route.test.js: new

## Tests
- Verify command: 63 passing, 0 failing, 1 pending (pre-existing skip)

## Notes
- The shared handler processFeeQuoteRequest lives in src/explorer/fees_preflight.js, outside Surfaces and reads req.query. To avoid editing it, the POST handler passes it a view of the request whose query is the JSON body.
- Uses the existing buildFeeQuotePostLimiter (env EXPLORER_FEE_QUOTE_POST_RATE_LIMIT_RPM, default 60).
- npm ci was run to run tests; node_modules is untracked/ignored and not committed.

RUN-COMPLETE 1ef4ac608e7d8b5190fe670eba0294fd
