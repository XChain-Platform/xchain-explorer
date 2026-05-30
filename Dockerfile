FROM node:latest

RUN mkdir /XChainExplorer/
COPY ./package.json /XChainExplorer/package.json
COPY ./package-lock.json /XChainExplorer/package-lock.json
WORKDIR /XChainExplorer
RUN npm ci

COPY ./src /XChainExplorer/src
#COPY ./.en[v] /XChainExplorer/.env

CMD ["npm", "run", "api"]