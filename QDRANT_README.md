# Qdrant Vector Database

This directory contains the Qdrant binary and related files for persistent vector storage.

## Quick Start

```bash
# Start Qdrant
./qdrant --config-path qdrant_config.yaml

# Or run in background
./qdrant --config-path qdrant_config.yaml > qdrant.log 2>&1 &

# Check health
curl http://localhost:6333/healthz
```

## Configuration

The `qdrant_config.yaml` file configures:
- HTTP port: 6333
- gRPC port: 6334
- Storage path: `./qdrant_data`
- Logging level: INFO

## Data

Vector embeddings are stored in `./qdrant_data/` directory, which persists across restarts.

## Documentation

See `docs/QDRANT_DEPLOYMENT.md` for complete deployment and migration guide.
