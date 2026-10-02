FROM node:24.21.0-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

ARG AGENTX_BUILD_REVISION=working-tree
ENV AGENTX_BUILD_REVISION=${AGENTX_BUILD_REVISION}

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

COPY benchmark/package*.json ./
RUN npm ci --omit=dev

COPY benchmark/ ./
COPY shared/ /shared/
COPY scripts/bounded-response.js /scripts/bounded-response.js

COPY core/views/layouts /core/views/layouts
COPY core/views/partials /core/views/partials
RUN mkdir -p /core/public/dist
COPY core/src/frontend/shared-tokens.css /core/public/dist/shared-tokens.css
COPY core/src/frontend/shared-utils.js /core/public/dist/shared-utils.js
COPY core/public/css/local-fonts.css /core/public/css/local-fonts.css
COPY core/public/css/platform-chrome.css /core/public/css/platform-chrome.css
COPY core/public/js/utils/polling-controller.js /core/public/js/utils/polling-controller.js
COPY core/public/js/utils/polling-controller-global.js /core/public/js/utils/polling-controller-global.js
COPY core/public/js/utils/shared.js /core/public/js/utils/shared.js
COPY core/public/js/utils/typed-confirmation.js /core/public/js/utils/typed-confirmation.js
COPY core/public/js/utils/shortcut-hints.js /core/public/js/utils/shortcut-hints.js
COPY core/public/js/utils/shortcuts-modal.js /core/public/js/utils/shortcuts-modal.js
COPY core/public/js/utils/toast.js /core/public/js/utils/toast.js

RUN mkdir -p /app/config-data \
  && ln -sf /app/config-data/benchmark.config.json /app/benchmark.config.json \
  && find scripts -type f \
    ! -name 'migrate-*.js' \
    ! -name 'cloud-lane-campaign.js' \
    ! -name 'repo-coding-qualification.js' \
    ! -name 'paired-thinking-campaign.js' \
    -delete \
  && rm -rf tests coverage test-results .env .env.* .git

EXPOSE 3081

ENV NODE_ENV=production
ENV PORT=3081
ENV JUDGE_DEFAULTS_PATH=/app/config-data/judge-host-defaults.json

CMD ["node", "server.js"]
