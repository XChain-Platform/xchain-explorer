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

CMD ["npm", "run", "api"]