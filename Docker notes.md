# Docker notes

# create docker container from dockerfile
docker build -t xchain-explorer . 

# start up docker
docker run xchain-explorer

# start up docker in background
docker run -d xchain-explorer

# Stop docker
docker ps | grep xchain-explorer | awk '{print $1}' | xargs docker stop

# List all containers
docker container ls -a

# remove all containers
docker container prune

# remove unused docker resources
docker system prune

# Start up docker via docker compose
docker-compose up

# Build docker, prune containers, start up docker
docker compose build ; echo y | docker container prune ; docker compose up
or
docker compose build ; docker compose up


# Node install notes
git clone git@github.com:XChain-platform/xchain-node.git
cd xchain-node
npm install
node .


# add user to docker group


# mysql notes (separate install only)
CREATE USER 'xchain-node'@'%' IDENTIFIED WITH mysql_native_password BY 'xchain-node-password';
GRANT ALL PRIVILEGES on *.* TO 'xchain-node'@'*' WITH GRANT OPTION;

# mariadb notes 
CREATE USER 'xchain-node'@'%' IDENTIFIED BY 'xchain-node-password';
GRANT ALL PRIVILEGES on *.* TO 'xchain-node'@'%' WITH GRANT OPTION;



# Reset indexer database 
drop database XChain_Indexer;create database XChain_Indexer;use XChain_Indexer;

