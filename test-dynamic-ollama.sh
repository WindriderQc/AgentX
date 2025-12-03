#!/bin/bash
# Test dynamic Ollama host configuration for V3 RAG

BASE_URL="http://localhost:3080"
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo "========================================="
echo "   Dynamic Ollama Host Test"
echo "========================================="
echo

# Test 1: Ingest with default Ollama host (localhost:11434)
echo -e "${YELLOW}[1/4] Testing ingestion with default host...${NC}"
RESPONSE1=$(curl -s -X POST "$BASE_URL/api/rag/ingest" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "test",
    "path": "/docs/test1",
    "title": "Test Default Host",
    "text": "This document uses the default Ollama host."
  }')

echo "$RESPONSE1" | jq .
echo

# Test 2: Ingest with custom Ollama host (192.168.2.99:11434)
echo -e "${YELLOW}[2/4] Testing ingestion with custom host 192.168.2.99...${NC}"
RESPONSE2=$(curl -s -X POST "$BASE_URL/api/rag/ingest" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "test",
    "path": "/docs/test2",
    "title": "Test Custom Host",
    "text": "This document uses a custom Ollama host on 192.168.2.99.",
    "target": "192.168.2.99:11434"
  }')

echo "$RESPONSE2" | jq .
echo

# Test 3: Search with default host
echo -e "${YELLOW}[3/4] Testing search with default host...${NC}"
RESPONSE3=$(curl -s -X POST "$BASE_URL/api/rag/search" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "What is the Ollama host?",
    "topK": 2
  }')

echo "$RESPONSE3" | jq .
echo

# Test 4: Search with custom host
echo -e "${YELLOW}[4/4] Testing search with custom host 192.168.2.99...${NC}"
RESPONSE4=$(curl -s -X POST "$BASE_URL/api/rag/search" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "What is the Ollama host?",
    "topK": 2,
    "target": "192.168.2.99:11434"
  }')

echo "$RESPONSE4" | jq .
echo

echo "========================================="
echo -e "${GREEN}✓ Dynamic Ollama host tests complete!${NC}"
echo "========================================="
echo
echo "Notes:"
echo "  • 'target' parameter can be added to /api/rag/ingest"
echo "  • 'target' parameter can be added to /api/rag/search"
echo "  • 'target' parameter in /api/chat automatically flows to RAG"
echo "  • Format: 'host:port' or 'http://host:port'"
echo "  • UI config changes auto-refresh model list"
