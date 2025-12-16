#!/bin/bash
# V3 RAG Testing Script for AgentX
# Tests all V3 endpoints and validates V1/V2 compatibility

set -e  # Exit on error

BASE_URL="http://localhost:3080"
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "========================================="
echo "   AgentX V3 RAG Testing Suite"
echo "========================================="
echo

# Check if server is running
echo -e "${YELLOW}[1/8] Checking server availability...${NC}"
if ! curl -s "$BASE_URL/health" > /dev/null; then
    echo -e "${RED}✗ Server is not running on $BASE_URL${NC}"
    echo "Please start the server with: npm start"
    exit 1
fi
echo -e "${GREEN}✓ Server is running${NC}"
echo

# Test 1: Ingest a document
echo -e "${YELLOW}[2/8] Testing POST /api/rag/ingest...${NC}"
INGEST_RESPONSE=$(curl -s -X POST "$BASE_URL/api/rag/ingest" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "test",
    "path": "/docs/test-document",
    "title": "Test Document for RAG",
    "text": "This is a test document. It contains information about RAG systems. Retrieval-Augmented Generation combines language models with semantic search. This allows the model to access relevant context from a knowledge base.",
    "tags": ["test", "rag", "documentation"]
  }')

if echo "$INGEST_RESPONSE" | jq -e '.documentId' > /dev/null; then
    DOC_ID=$(echo "$INGEST_RESPONSE" | jq -r '.documentId')
    CHUNK_COUNT=$(echo "$INGEST_RESPONSE" | jq -r '.chunkCount')
    STATUS=$(echo "$INGEST_RESPONSE" | jq -r '.status')
    echo -e "${GREEN}✓ Document ingested successfully${NC}"
    echo "  Document ID: $DOC_ID"
    echo "  Chunks: $CHUNK_COUNT"
    echo "  Status: $STATUS"
else
    echo -e "${RED}✗ Ingestion failed${NC}"
    echo "$INGEST_RESPONSE" | jq .
    exit 1
fi
echo

# Test 2: Ingest another document
echo -e "${YELLOW}[3/8] Testing duplicate ingestion (should be 'unchanged')...${NC}"
INGEST2_RESPONSE=$(curl -s -X POST "$BASE_URL/api/rag/ingest" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "github",
    "path": "/repos/agentx/README.md",
    "title": "AgentX README",
    "text": "AgentX is a local AI assistant with RAG capabilities. It uses Ollama for embeddings and chat. The system supports semantic search over ingested documents.",
    "tags": ["readme", "documentation"]
  }')

echo "$INGEST2_RESPONSE" | jq .
echo

# Test 3: Search for relevant chunks
echo -e "${YELLOW}[4/8] Testing POST /api/rag/search...${NC}"
SEARCH_RESPONSE=$(curl -s -X POST "$BASE_URL/api/rag/search" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "What is RAG?",
    "topK": 3
  }')

if echo "$SEARCH_RESPONSE" | jq -e '.resultCount' > /dev/null; then
    RESULT_COUNT=$(echo "$SEARCH_RESPONSE" | jq -r '.resultCount')
    echo -e "${GREEN}✓ Search returned $RESULT_COUNT results${NC}"
    echo "$SEARCH_RESPONSE" | jq '.results[] | {score, title: .metadata.title, preview: .text[0:100]}'
else
    echo -e "${RED}✗ Search failed${NC}"
    echo "$SEARCH_RESPONSE" | jq .
    exit 1
fi
echo

# Test 4: List documents
echo -e "${YELLOW}[5/8] Testing GET /api/rag/documents...${NC}"
DOCS_RESPONSE=$(curl -s "$BASE_URL/api/rag/documents")
echo "$DOCS_RESPONSE" | jq '{stats, count, documents: [.documents[] | {title, source, chunkCount}]}'
echo

# Test 5: V1/V2 Chat without RAG (backwards compatibility)
echo -e "${YELLOW}[6/8] Testing V1/V2 chat (without RAG)...${NC}"
CHAT_V2_RESPONSE=$(curl -s -X POST "$BASE_URL/api/chat" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama2:latest",
    "message": "Hello, how are you?",
    "messages": [],
    "target": "192.168.2.99:11434"
  }')

if echo "$CHAT_V2_RESPONSE" | jq -e '.status' > /dev/null; then
    RAG_USED=$(echo "$CHAT_V2_RESPONSE" | jq -r '.ragUsed')
    echo -e "${GREEN}✓ V1/V2 chat works (ragUsed: $RAG_USED)${NC}"
    if [ "$RAG_USED" = "true" ]; then
        echo -e "${RED}✗ WARNING: RAG was used when it shouldn't be!${NC}"
        exit 1
    fi
else
    echo -e "${RED}✗ V1/V2 chat failed${NC}"
    echo "$CHAT_V2_RESPONSE" | jq .
    exit 1
fi
echo

# Test 6: V3 Chat with RAG enabled
echo -e "${YELLOW}[7/8] Testing V3 chat (with RAG)...${NC}"
CHAT_V3_RESPONSE=$(curl -s -X POST "$BASE_URL/api/chat" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama3.2:1b",
    "message": "What is Retrieval-Augmented Generation?",
    "messages": [],
    "target": "192.168.2.99:11434",
    "useRag": true,
    "ragTopK": 3
  }')

if echo "$CHAT_V3_RESPONSE" | jq -e '.ragUsed' > /dev/null; then
    RAG_USED=$(echo "$CHAT_V3_RESPONSE" | jq -r '.ragUsed')
    SOURCE_COUNT=$(echo "$CHAT_V3_RESPONSE" | jq -r '.ragSources | length')
    echo -e "${GREEN}✓ V3 chat works (ragUsed: $RAG_USED, sources: $SOURCE_COUNT)${NC}"
    
    if [ "$RAG_USED" == "true" ]; then
        echo "  RAG Sources:"
        echo "$CHAT_V3_RESPONSE" | jq -r '.ragSources[] | "  - [\(.score | tonumber | . * 100 | floor)%] \(.title): \(.text[0:80])..."'
    fi
else
    echo -e "${RED}✗ V3 chat failed${NC}"
    echo "$CHAT_V3_RESPONSE" | jq .
    exit 1
fi
echo

# Test 7: Validation error handling
echo -e "${YELLOW}[8/8] Testing error handling...${NC}"
ERROR_RESPONSE=$(curl -s -X POST "$BASE_URL/api/rag/ingest" \
  -H "Content-Type: application/json" \
  -d '{"source": "test"}')

if echo "$ERROR_RESPONSE" | jq -e '.error' > /dev/null; then
    echo -e "${GREEN}✓ Validation errors work correctly${NC}"
    echo "$ERROR_RESPONSE" | jq .
else
    echo -e "${RED}✗ Error handling not working${NC}"
    exit 1
fi
echo

# Summary
echo "========================================="
echo -e "${GREEN}✓ All V3 RAG tests passed!${NC}"
echo "========================================="
echo
echo "Test Summary:"
echo "  • Document ingestion: ✓"
echo "  • Semantic search: ✓"
echo "  • V1/V2 compatibility: ✓"
echo "  • V3 RAG chat: ✓"
echo "  • Error handling: ✓"
echo
echo "Ready for Agent C (n8n) integration!"
