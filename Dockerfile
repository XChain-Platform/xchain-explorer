FROM node:latest

RUN mkdir /XChainExplorer/
COPY ./package.json /XChainExplorer/package.json
COPY ./package-lock.json /XChainExplorer/package-lock.json
WORKDIR /XChainExplorer
RUN npm ci --omit=dev

COPY ./src /XChainExplorer/src
COPY ./docs /XChainExplorer/docs
#COPY ./.en[v] /XChainExplorer/.env

CMD ["npm", "run", "api"]