FROM node:22-bookworm-slim

WORKDIR /app

# psql：首次启动 seed、运维排查都会用到
RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client ca-certificates chromium fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
# tsx 目前是 devDependency，但运行时需要；生产镜像保留 dev 依赖
RUN npm ci --include=dev

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY db ./db

COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

ENV NODE_ENV=production
EXPOSE 8788

ENTRYPOINT ["./docker-entrypoint.sh"]
