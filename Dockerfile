FROM node:latest

RUN mkdir /XChainExplorer/
COPY ./package.json /XChainExplorer/package.json
WORKDIR /XChainExplorer
RUN npm install

COPY ./src /XChainExplorer/src
COPY ./.en[v] /XChainExplorer/.env

CMD ["npm", "run", "explorer"]