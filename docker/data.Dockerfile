FROM node:24.21.0-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
ARG AGENTX_BUILD_REVISION=working-tree
ENV AGENTX_BUILD_REVISION=${AGENTX_BUILD_REVISION}
WORKDIR /app
COPY data/package*.json ./
RUN npm ci --omit=dev
COPY data/ ./
COPY shared/ /shared/
RUN rm -rf tests test-results
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3083
EXPOSE 3083
CMD ["node", "server.js"]
