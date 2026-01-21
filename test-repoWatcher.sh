#!/bin/bash

# Test script for repoWatcher functionality
# Usage: ./test-repoWatcher.sh

BASE_URL="http://localhost:3080"
TOKEN="${1:-your-auth-token}"

echo "==================================="
echo "Testing Repo Watcher Endpoints"
echo "==================================="
echo ""

# Test 1: Get current status
echo "1. Testing GET /api/repoWatcher/status"
curl -s -X GET \
  -H "Authorization: Bearer ${TOKEN}" \
  "$BASE_URL/api/repoWatcher/status" | jq '.'
echo ""
echo ""

# Test 2: Trigger manual scan
echo "2. Testing POST /api/repoWatcher/scan"
echo "   (This may take 10-30 seconds...)"
curl -s -X POST \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  "$BASE_URL/api/repoWatcher/scan" | jq '.'
echo ""
echo ""

# Test 3: Get trends
echo "3. Testing GET /api/repoWatcher/trends"
curl -s -X GET \
  -H "Authorization: Bearer ${TOKEN}" \
  "$BASE_URL/api/repoWatcher/trends" | jq '.'
echo ""
echo ""

# Test 4: Get scan history
echo "4. Testing GET /api/repoWatcher/history"
curl -s -X GET \
  -H "Authorization: Bearer ${TOKEN}" \
  "$BASE_URL/api/repoWatcher/history?limit=5" | jq '.'
echo ""
echo ""

echo "==================================="
echo "Test Complete!"
echo "==================================="
echo ""
echo "Visit the dashboard at:"
echo "$BASE_URL/repoWatcher.html"
echo ""
