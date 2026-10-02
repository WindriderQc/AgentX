FROM mongo:7.0.34@sha256:c1a84ab5d0c17deed1e0dba1d24bd7c76e5c7b281145fe536911939b1551754c AS mongo-tools

FROM node:24.21.0-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

ARG AGENTX_BUILD_REVISION=working-tree
ENV AGENTX_BUILD_REVISION=${AGENTX_BUILD_REVISION}

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssh-client ca-certificates libcurl4 libgssapi-krb5-2 tar poppler-utils \
  && rm -rf /var/lib/apt/lists/*

COPY --from=mongo-tools /usr/bin/mongodump /usr/local/bin/mongodump
COPY --from=mongo-tools /usr/bin/mongorestore /usr/local/bin/mongorestore

COPY core/package*.json ./
RUN npm ci --omit=dev

COPY core/ ./
COPY shared/ /shared/
RUN mkdir -p /app/product-config/config
COPY docker-compose.yml docker-compose.ollama.yml /app/product-config/
COPY config/agentx.env config/rag-ingestion-policy.json config/product-surfaces.json config/adapter-consumer-contracts.json config/container-image-pins.json /app/product-config/config/
RUN npm run build && rm -rf tests surfaces/household/test surfaces/data-toolbox/test surfaces/psyx/test integrations/runtime-bridges/test coverage .env .env.* .git

EXPOSE 3080

ENV NODE_ENV=production
ENV PORT=3080

CMD ["node", "server.js"]
