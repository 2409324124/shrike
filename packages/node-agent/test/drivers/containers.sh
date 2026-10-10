#!/usr/bin/env bash
# Real databases for the driver and datasource tests, on non-standard ports. ./containers.sh up | down
set -euo pipefail
PW=shrike-secret-pw
if [ "${1:-up}" = down ]; then
  docker rm -f shrike-test-pg shrike-test-mysql shrike-test-redis shrike-test-mongo >/dev/null 2>&1 || true
  exit 0
fi
docker run -d --name shrike-test-pg -p 25432:5432 -e POSTGRES_PASSWORD=$PW -e POSTGRES_DB=shrike postgres:16-alpine >/dev/null
docker run -d --name shrike-test-mysql -p 23306:3306 -e MYSQL_ROOT_PASSWORD=$PW -e MYSQL_DATABASE=shrike mysql:8.4 >/dev/null
docker run -d --name shrike-test-redis -p 26379:6379 redis:7-alpine redis-server --requirepass $PW >/dev/null
docker run -d --name shrike-test-mongo -p 27117:27017 mongo:7 >/dev/null
for i in $(seq 1 90); do
  docker exec shrike-test-mysql mysqladmin ping -uroot -p$PW --silent >/dev/null 2>&1 && docker exec shrike-test-pg pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done
