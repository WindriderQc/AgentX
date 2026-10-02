FROM node:24.21.0-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

# The code runner sidecar: runs candidate programs for Benchmark's coding
# prompts. No network, no npm dependencies, one job at a time as `nobody`.
# The interpreters it may start are exactly the two installed here.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /runner
COPY benchmark/runner/ ./

ENV NODE_ENV=production
ENV RUNNER_JOBS_DIR=/jobs
ENV RUNNER_WORK_DIR=/work

CMD ["node", "/runner/daemon.js"]
