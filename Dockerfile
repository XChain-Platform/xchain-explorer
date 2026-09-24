# Pinned by digest to the node:22.23.2-bookworm build whose V8/ICU/unicode/cldr
# match xchain-vm's consensus runtime pin: the floating node:22-bookworm tag
# moved to a Node patch whose V8/ICU no longer match, which fails that check.
# The optional xchain-vm dependency's isolated-vm native build also needs
# Node 22 V8 headers (same pin as xchain-indexer / xchain-utxo-tracker); the
# explorer itself runs on any >=22.
FROM node:22.23.2-bookworm@sha256:dd5847a04b0deee391fa145f1f4c6d214196668b6bcc7988ebed67249f226844

RUN mkdir /XChainExplorer/
# xchain-vm is staged into the build context by xchain-node's install path
# (LIBRARY_BUNDLES) for the flag-gated contract-simulation endpoint. The glob
# makes the COPY a no-op in standalone builds without a staged copy; npm ci
# then simply skips the optional file: dependency and the endpoint reports
# VM_MODULE_UNAVAILABLE at runtime.
COPY ./xchain-v[m] /XChainExplorer/xchain-vm
COPY ./package.json /XChainExplorer/package.json
COPY ./package-lock.json /XChainExplorer/package-lock.json
WORKDIR /XChainExplorer
RUN npm ci --omit=dev

COPY ./src /XChainExplorer/src
COPY ./docs /XChainExplorer/docs
# The vendored action manifest, hashed into getrollcallsigners' manifest_hash (the
# version signal a validator's roll-call close defers on when it differs). Without it
# the hash reads null and every close served by this explorer defers. It stays at the
# test/fixtures path because sync-action-manifest.sh already keeps this exact copy
# byte-identical to canonical; a second copy would be a drift surface it does not know.
COPY ./test/fixtures/action-manifest.json /XChainExplorer/test/fixtures/action-manifest.json

# Exec-form node, not `npm run api` (which is this exact command). npm builds an
# npm -> sh -c -> node tree and no wrapper forwards signals, so `docker stop`
# kills npm while node is never told anything (measured on the regtest encoder,
# xchain-encoder/Dockerfile) and src/api.js's SIGTERM/SIGINT VM-worker teardown
# never runs. Dropping the npm wrapper also drops the npm_package_* env vars,
# which XChainExplorer.js reads for the version it reports on the WebSocket
# WELCOME frame; that read falls back to package.json for this launch path.
CMD ["node", "./src/api.js"]