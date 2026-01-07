# AgentX Chat Service Test Suite (Task 3)

This directory contains the comprehensive test suite scaffold for the `chatService` module, fulfilling Task Package 3 requirements.

## Deliverables

- `chatService.test.js`: A Jest test file covering critical paths, including:
  - Routing logic (Primary/Secondary host)
  - RAG integration & File listing intent
  - Cost calculation
  - Error handling (Timeouts, API failures)
  - Tool execution (CLI & LLM-driven)

## Prerequisites

- Node.js environment
- Jest installed in the project (`npm install jest`)

## How to Run

1. Copy the test file to the main `tests/unit` directory:
   ```bash
   mkdir -p ../../tests/unit
   cp chatService.test.js ../../tests/unit/
   ```

2. Run the specific test file using Jest:
   ```bash
   cd ../../
   npx jest tests/unit/chatService.test.js
   ```

## Mocks & Dependencies

The test suite mocks all external dependencies to ensure unit isolation:
- `node-fetch`: Simulates Ollama API responses.
- `ragStore`: Simulates vector database search and document listing.
- `Conversation`, `PromptConfig`: Mocks database models using `jest.fn()` factories to ensure complete isolation from Mongoose.
- `modelRouter`, `costCalculator`: Mocks service logic.
