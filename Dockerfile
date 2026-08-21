# Pinned to node:22-bookworm: the optional xchain-vm dependency's isolated-vm
# native build only succeeds against Node 22 V8 headers (same pin as
# xchain-indexer / xchain-utxo-tracker). The explorer itself runs on any >=22.
FROM node:22-bookworm

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

# Exec-form node, not `npm run api` (which is this exact command). npm builds an
# npm -> sh -c -> node tree and no wrapper forwards signals, so `docker stop`
# kills npm while node is never told anything (measured on the regtest encoder,
# xchain-encoder/Dockerfile) and src/api.js's SIGTERM/SIGINT VM-worker teardown
# never runs. Dropping the npm wrapper also drops the npm_package_* env vars,
# which XChainExplorer.js reads for the version it reports on the WebSocket
# WELCOME frame; that read falls back to package.json for this launch path.
CMD ["node", "./src/api.js"]