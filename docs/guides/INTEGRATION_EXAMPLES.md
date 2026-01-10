# SBQC N3.2 AI Gateway - Integration Examples

This document provides production-ready integration examples for the SBQC N3.2 AI Gateway in multiple programming languages.

## API Endpoint Information

- **Endpoint:** `POST https://n8n.specialblend.icu/webhook/sbqc-ai-query`
- **Content-Type:** `application/json`

### Request Format

```json
{
  "message": "Your question here",
  "model": "qwen2.5:7b-instruct-q4_0",
  "useRag": false,
  "conversationId": "optional-for-multi-turn"
}
```

### Response Format

```json
{
  "success": true,
  "response": "AI response text",
  "conversationId": "unique-conversation-id",
  "tokens": {
    "prompt": 123,
    "completion": 456,
    "total": 579
  }
}
```

---

## Table of Contents

1. [Python Examples](#python-examples)
2. [JavaScript/Node.js Examples](#javascriptnodejs-examples)
3. [cURL Examples](#curl-examples)
4. [Go Examples](#go-examples)

---

## Python Examples

### Installation

```bash
pip install requests
```

### Basic Request

```python
import requests
import json
from typing import Dict, Optional

def send_ai_query(
    message: str,
    model: str = "qwen2.5:7b-instruct-q4_0",
    use_rag: bool = False,
    conversation_id: Optional[str] = None,
    timeout: int = 30
) -> Dict:
    """
    Send a query to the SBQC N3.2 AI Gateway.

    Args:
        message: The question or prompt to send
        model: The AI model to use (default: qwen2.5:7b-instruct-q4_0)
        use_rag: Whether to use RAG (Retrieval-Augmented Generation)
        conversation_id: Optional conversation ID for multi-turn conversations
        timeout: Request timeout in seconds

    Returns:
        Dict containing the API response

    Raises:
        requests.exceptions.RequestException: For network/HTTP errors
        ValueError: For invalid responses
    """
    url = "https://n8n.specialblend.icu/webhook/sbqc-ai-query"

    payload = {
        "message": message,
        "model": model,
        "useRag": use_rag
    }

    # Add conversation ID if provided
    if conversation_id:
        payload["conversationId"] = conversation_id

    headers = {
        "Content-Type": "application/json"
    }

    try:
        response = requests.post(
            url,
            json=payload,
            headers=headers,
            timeout=timeout
        )

        # Raise an exception for bad status codes
        response.raise_for_status()

        # Parse JSON response
        data = response.json()

        # Validate response structure
        if not isinstance(data, dict):
            raise ValueError("Invalid response format: expected JSON object")

        if not data.get("success"):
            error_msg = data.get("error", "Unknown error occurred")
            raise ValueError(f"API returned error: {error_msg}")

        return data

    except requests.exceptions.Timeout:
        raise requests.exceptions.Timeout(
            f"Request timed out after {timeout} seconds"
        )
    except requests.exceptions.ConnectionError as e:
        raise requests.exceptions.ConnectionError(
            f"Failed to connect to AI Gateway: {str(e)}"
        )
    except requests.exceptions.HTTPError as e:
        raise requests.exceptions.HTTPError(
            f"HTTP error occurred: {e.response.status_code} - {e.response.text}"
        )
    except json.JSONDecodeError as e:
        raise ValueError(f"Failed to parse response as JSON: {str(e)}")


# Example usage: Basic request
if __name__ == "__main__":
    try:
        result = send_ai_query("What is the capital of France?")
        print(f"Response: {result['response']}")
        print(f"Conversation ID: {result['conversationId']}")
        print(f"Tokens used: {result['tokens']['total']}")

    except Exception as e:
        print(f"Error: {str(e)}")
```

### Multi-Turn Conversation

```python
import requests
from typing import List, Dict, Optional

class AIConversation:
    """
    Manages multi-turn conversations with the SBQC N3.2 AI Gateway.
    """

    def __init__(
        self,
        model: str = "qwen2.5:7b-instruct-q4_0",
        use_rag: bool = False,
        timeout: int = 30
    ):
        """
        Initialize a new conversation session.

        Args:
            model: The AI model to use
            use_rag: Whether to use RAG
            timeout: Request timeout in seconds
        """
        self.url = "https://n8n.specialblend.icu/webhook/sbqc-ai-query"
        self.model = model
        self.use_rag = use_rag
        self.timeout = timeout
        self.conversation_id: Optional[str] = None
        self.history: List[Dict[str, str]] = []
        self.total_tokens = 0

    def send_message(self, message: str) -> str:
        """
        Send a message in the conversation.

        Args:
            message: The message to send

        Returns:
            The AI's response text

        Raises:
            Exception: For any errors that occur
        """
        payload = {
            "message": message,
            "model": self.model,
            "useRag": self.use_rag
        }

        # Include conversation ID for follow-up messages
        if self.conversation_id:
            payload["conversationId"] = self.conversation_id

        headers = {"Content-Type": "application/json"}

        try:
            response = requests.post(
                self.url,
                json=payload,
                headers=headers,
                timeout=self.timeout
            )
            response.raise_for_status()
            data = response.json()

            if not data.get("success"):
                raise ValueError(f"API error: {data.get('error', 'Unknown error')}")

            # Store conversation ID from first response
            if not self.conversation_id:
                self.conversation_id = data.get("conversationId")

            # Track conversation history
            self.history.append({
                "user": message,
                "assistant": data["response"]
            })

            # Update token count
            if "tokens" in data:
                self.total_tokens += data["tokens"].get("total", 0)

            return data["response"]

        except requests.exceptions.Timeout:
            raise TimeoutError(f"Request timed out after {self.timeout} seconds")
        except requests.exceptions.RequestException as e:
            raise Exception(f"Network error: {str(e)}")
        except (KeyError, ValueError) as e:
            raise Exception(f"Invalid response: {str(e)}")

    def get_conversation_id(self) -> Optional[str]:
        """Get the current conversation ID."""
        return self.conversation_id

    def get_history(self) -> List[Dict[str, str]]:
        """Get the full conversation history."""
        return self.history.copy()

    def get_total_tokens(self) -> int:
        """Get the total tokens used in this conversation."""
        return self.total_tokens


# Example usage: Multi-turn conversation
if __name__ == "__main__":
    conversation = AIConversation(timeout=30)

    try:
        # First message
        response1 = conversation.send_message("What is Python?")
        print(f"AI: {response1}\n")

        # Follow-up message (uses same conversation ID)
        response2 = conversation.send_message("What are its main features?")
        print(f"AI: {response2}\n")

        # Another follow-up
        response3 = conversation.send_message("Can you give me an example?")
        print(f"AI: {response3}\n")

        # Print conversation summary
        print(f"\nConversation ID: {conversation.get_conversation_id()}")
        print(f"Total tokens used: {conversation.get_total_tokens()}")
        print(f"Messages exchanged: {len(conversation.get_history())}")

    except TimeoutError as e:
        print(f"Timeout error: {e}")
    except Exception as e:
        print(f"Error: {e}")
```

### Advanced: Retry Logic and Connection Pooling

```python
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
import time
from typing import Dict, Optional

class RobustAIClient:
    """
    Production-ready AI Gateway client with retry logic and connection pooling.
    """

    def __init__(
        self,
        model: str = "qwen2.5:7b-instruct-q4_0",
        use_rag: bool = False,
        timeout: int = 30,
        max_retries: int = 3
    ):
        """
        Initialize the robust AI client.

        Args:
            model: The AI model to use
            use_rag: Whether to use RAG
            timeout: Request timeout in seconds
            max_retries: Maximum number of retry attempts
        """
        self.url = "https://n8n.specialblend.icu/webhook/sbqc-ai-query"
        self.model = model
        self.use_rag = use_rag
        self.timeout = timeout

        # Create a session with retry logic
        self.session = requests.Session()

        # Configure retry strategy
        retry_strategy = Retry(
            total=max_retries,
            backoff_factor=1,  # Wait 1, 2, 4 seconds between retries
            status_forcelist=[429, 500, 502, 503, 504],  # Retry on these status codes
            allowed_methods=["POST"]  # Retry POST requests
        )

        # Mount adapter with retry strategy
        adapter = HTTPAdapter(
            max_retries=retry_strategy,
            pool_connections=10,
            pool_maxsize=10
        )
        self.session.mount("https://", adapter)
        self.session.mount("http://", adapter)

    def query(
        self,
        message: str,
        conversation_id: Optional[str] = None
    ) -> Dict:
        """
        Send a query with automatic retry on failure.

        Args:
            message: The message to send
            conversation_id: Optional conversation ID

        Returns:
            Dict containing the API response

        Raises:
            Exception: For unrecoverable errors
        """
        payload = {
            "message": message,
            "model": self.model,
            "useRag": self.use_rag
        }

        if conversation_id:
            payload["conversationId"] = conversation_id

        headers = {"Content-Type": "application/json"}

        try:
            start_time = time.time()

            response = self.session.post(
                self.url,
                json=payload,
                headers=headers,
                timeout=self.timeout
            )

            elapsed_time = time.time() - start_time

            response.raise_for_status()
            data = response.json()

            if not data.get("success"):
                raise ValueError(f"API error: {data.get('error', 'Unknown error')}")

            # Add timing information
            data["_metadata"] = {
                "elapsed_time": round(elapsed_time, 2),
                "status_code": response.status_code
            }

            return data

        except requests.exceptions.Timeout:
            raise TimeoutError(
                f"Request timed out after {self.timeout} seconds. "
                "Consider increasing the timeout or checking network connectivity."
            )
        except requests.exceptions.RetryError as e:
            raise Exception(
                f"Max retries exceeded. The AI Gateway may be unavailable. Error: {str(e)}"
            )
        except requests.exceptions.RequestException as e:
            raise Exception(f"Network error: {str(e)}")
        except ValueError as e:
            raise Exception(f"Invalid response: {str(e)}")

    def close(self):
        """Close the session and release resources."""
        self.session.close()

    def __enter__(self):
        """Context manager entry."""
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Context manager exit."""
        self.close()


# Example usage: Robust client with retry logic
if __name__ == "__main__":
    # Use context manager for automatic resource cleanup
    with RobustAIClient(timeout=30, max_retries=3) as client:
        try:
            result = client.query("Explain machine learning in simple terms")

            print(f"Response: {result['response']}")
            print(f"Conversation ID: {result['conversationId']}")
            print(f"Tokens: {result['tokens']['total']}")
            print(f"Request time: {result['_metadata']['elapsed_time']}s")

        except TimeoutError as e:
            print(f"Timeout: {e}")
        except Exception as e:
            print(f"Error: {e}")
```

---

## JavaScript/Node.js Examples

### Installation

```bash
npm install axios
```

### Basic Request

```javascript
const axios = require('axios');

/**
 * Send a query to the SBQC N3.2 AI Gateway
 * @param {string} message - The question or prompt to send
 * @param {string} model - The AI model to use
 * @param {boolean} useRag - Whether to use RAG
 * @param {string|null} conversationId - Optional conversation ID for multi-turn
 * @param {number} timeout - Request timeout in milliseconds
 * @returns {Promise<Object>} The API response
 * @throws {Error} For network or API errors
 */
async function sendAIQuery(
  message,
  model = 'qwen2.5:7b-instruct-q4_0',
  useRag = false,
  conversationId = null,
  timeout = 30000
) {
  const url = 'https://n8n.specialblend.icu/webhook/sbqc-ai-query';

  const payload = {
    message,
    model,
    useRag
  };

  // Add conversation ID if provided
  if (conversationId) {
    payload.conversationId = conversationId;
  }

  try {
    const response = await axios.post(url, payload, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout
    });

    // Validate response structure
    if (!response.data || typeof response.data !== 'object') {
      throw new Error('Invalid response format: expected JSON object');
    }

    if (!response.data.success) {
      const errorMsg = response.data.error || 'Unknown error occurred';
      throw new Error(`API returned error: ${errorMsg}`);
    }

    return response.data;

  } catch (error) {
    // Handle different error types
    if (error.code === 'ECONNABORTED') {
      throw new Error(`Request timed out after ${timeout}ms`);
    } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      throw new Error(`Failed to connect to AI Gateway: ${error.message}`);
    } else if (error.response) {
      // Server responded with error status
      throw new Error(
        `HTTP ${error.response.status}: ${error.response.data?.error || error.response.statusText}`
      );
    } else if (error.request) {
      // Request was made but no response received
      throw new Error(`No response from server: ${error.message}`);
    } else {
      // Something else went wrong
      throw new Error(`Request failed: ${error.message}`);
    }
  }
}

// Example usage: Basic request
(async () => {
  try {
    const result = await sendAIQuery('What is the capital of France?');

    console.log(`Response: ${result.response}`);
    console.log(`Conversation ID: ${result.conversationId}`);
    console.log(`Tokens used: ${result.tokens.total}`);

  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
})();
```

### Multi-Turn Conversation

```javascript
const axios = require('axios');

/**
 * Manages multi-turn conversations with the SBQC N3.2 AI Gateway
 */
class AIConversation {
  /**
   * Initialize a new conversation session
   * @param {string} model - The AI model to use
   * @param {boolean} useRag - Whether to use RAG
   * @param {number} timeout - Request timeout in milliseconds
   */
  constructor(
    model = 'qwen2.5:7b-instruct-q4_0',
    useRag = false,
    timeout = 30000
  ) {
    this.url = 'https://n8n.specialblend.icu/webhook/sbqc-ai-query';
    this.model = model;
    this.useRag = useRag;
    this.timeout = timeout;
    this.conversationId = null;
    this.history = [];
    this.totalTokens = 0;
  }

  /**
   * Send a message in the conversation
   * @param {string} message - The message to send
   * @returns {Promise<string>} The AI's response text
   * @throws {Error} For any errors that occur
   */
  async sendMessage(message) {
    const payload = {
      message,
      model: this.model,
      useRag: this.useRag
    };

    // Include conversation ID for follow-up messages
    if (this.conversationId) {
      payload.conversationId = this.conversationId;
    }

    try {
      const response = await axios.post(this.url, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: this.timeout
      });

      const data = response.data;

      if (!data.success) {
        throw new Error(`API error: ${data.error || 'Unknown error'}`);
      }

      // Store conversation ID from first response
      if (!this.conversationId) {
        this.conversationId = data.conversationId;
      }

      // Track conversation history
      this.history.push({
        user: message,
        assistant: data.response
      });

      // Update token count
      if (data.tokens) {
        this.totalTokens += data.tokens.total || 0;
      }

      return data.response;

    } catch (error) {
      if (error.code === 'ECONNABORTED') {
        throw new Error(`Request timed out after ${this.timeout}ms`);
      } else if (error.response) {
        throw new Error(`HTTP ${error.response.status}: ${error.response.statusText}`);
      } else {
        throw new Error(`Network error: ${error.message}`);
      }
    }
  }

  /**
   * Get the current conversation ID
   * @returns {string|null} The conversation ID
   */
  getConversationId() {
    return this.conversationId;
  }

  /**
   * Get the full conversation history
   * @returns {Array} Array of message objects
   */
  getHistory() {
    return [...this.history];
  }

  /**
   * Get the total tokens used in this conversation
   * @returns {number} Total token count
   */
  getTotalTokens() {
    return this.totalTokens;
  }
}

// Example usage: Multi-turn conversation
(async () => {
  const conversation = new AIConversation();

  try {
    // First message
    const response1 = await conversation.sendMessage('What is Python?');
    console.log(`AI: ${response1}\n`);

    // Follow-up message (uses same conversation ID)
    const response2 = await conversation.sendMessage('What are its main features?');
    console.log(`AI: ${response2}\n`);

    // Another follow-up
    const response3 = await conversation.sendMessage('Can you give me an example?');
    console.log(`AI: ${response3}\n`);

    // Print conversation summary
    console.log(`\nConversation ID: ${conversation.getConversationId()}`);
    console.log(`Total tokens used: ${conversation.getTotalTokens()}`);
    console.log(`Messages exchanged: ${conversation.getHistory().length}`);

  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
})();
```

### Advanced: Retry Logic with axios-retry

```javascript
const axios = require('axios');
const axiosRetry = require('axios-retry');

/**
 * Production-ready AI Gateway client with retry logic
 */
class RobustAIClient {
  /**
   * Initialize the robust AI client
   * @param {string} model - The AI model to use
   * @param {boolean} useRag - Whether to use RAG
   * @param {number} timeout - Request timeout in milliseconds
   * @param {number} maxRetries - Maximum number of retry attempts
   */
  constructor(
    model = 'qwen2.5:7b-instruct-q4_0',
    useRag = false,
    timeout = 30000,
    maxRetries = 3
  ) {
    this.url = 'https://n8n.specialblend.icu/webhook/sbqc-ai-query';
    this.model = model;
    this.useRag = useRag;
    this.timeout = timeout;

    // Create axios instance with retry configuration
    this.client = axios.create({
      timeout: this.timeout,
      headers: {
        'Content-Type': 'application/json'
      }
    });

    // Configure retry logic
    axiosRetry(this.client, {
      retries: maxRetries,
      retryDelay: axiosRetry.exponentialDelay, // 1s, 2s, 4s...
      retryCondition: (error) => {
        // Retry on network errors or 5xx status codes
        return axiosRetry.isNetworkOrIdempotentRequestError(error) ||
               (error.response && error.response.status >= 500);
      },
      onRetry: (retryCount, error, requestConfig) => {
        console.log(`Retry attempt ${retryCount} for ${requestConfig.url}`);
      }
    });
  }

  /**
   * Send a query with automatic retry on failure
   * @param {string} message - The message to send
   * @param {string|null} conversationId - Optional conversation ID
   * @returns {Promise<Object>} The API response
   * @throws {Error} For unrecoverable errors
   */
  async query(message, conversationId = null) {
    const payload = {
      message,
      model: this.model,
      useRag: this.useRag
    };

    if (conversationId) {
      payload.conversationId = conversationId;
    }

    const startTime = Date.now();

    try {
      const response = await this.client.post(this.url, payload);
      const elapsedTime = (Date.now() - startTime) / 1000;

      if (!response.data.success) {
        throw new Error(`API error: ${response.data.error || 'Unknown error'}`);
      }

      // Add timing information
      response.data._metadata = {
        elapsedTime: parseFloat(elapsedTime.toFixed(2)),
        statusCode: response.status
      };

      return response.data;

    } catch (error) {
      if (error.code === 'ECONNABORTED') {
        throw new Error(
          `Request timed out after ${this.timeout}ms. ` +
          'Consider increasing the timeout or checking network connectivity.'
        );
      } else if (error.response) {
        throw new Error(
          `HTTP ${error.response.status}: ${error.response.data?.error || error.response.statusText}`
        );
      } else {
        throw new Error(
          `Max retries exceeded. The AI Gateway may be unavailable. Error: ${error.message}`
        );
      }
    }
  }
}

// Example usage: Robust client with retry logic
(async () => {
  const client = new RobustAIClient(
    'qwen2.5:7b-instruct-q4_0',
    false,
    30000,
    3
  );

  try {
    const result = await client.query('Explain machine learning in simple terms');

    console.log(`Response: ${result.response}`);
    console.log(`Conversation ID: ${result.conversationId}`);
    console.log(`Tokens: ${result.tokens.total}`);
    console.log(`Request time: ${result._metadata.elapsedTime}s`);

  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
})();
```

**Note:** For the retry logic example, install: `npm install axios axios-retry`

---

## cURL Examples

### Basic Request

```bash
#!/bin/bash

# Basic AI query using cURL
curl -X POST https://n8n.specialblend.icu/webhook/sbqc-ai-query \
  -H "Content-Type: application/json" \
  -d '{
    "message": "What is the capital of France?",
    "model": "qwen2.5:7b-instruct-q4_0",
    "useRag": false
  }' \
  --max-time 30 \
  --connect-timeout 10
```

### Multi-Turn Conversation

```bash
#!/bin/bash

# Multi-turn conversation using cURL
# Store the conversation ID from the first response

# First message
RESPONSE1=$(curl -s -X POST https://n8n.specialblend.icu/webhook/sbqc-ai-query \
  -H "Content-Type: application/json" \
  -d '{
    "message": "What is Python?",
    "model": "qwen2.5:7b-instruct-q4_0",
    "useRag": false
  }' \
  --max-time 30)

# Extract conversation ID (requires jq)
CONV_ID=$(echo "$RESPONSE1" | jq -r '.conversationId')

echo "First response:"
echo "$RESPONSE1" | jq -r '.response'
echo ""

# Second message (follow-up using conversation ID)
RESPONSE2=$(curl -s -X POST https://n8n.specialblend.icu/webhook/sbqc-ai-query \
  -H "Content-Type: application/json" \
  -d "{
    \"message\": \"What are its main features?\",
    \"model\": \"qwen2.5:7b-instruct-q4_0\",
    \"useRag\": false,
    \"conversationId\": \"$CONV_ID\"
  }" \
  --max-time 30)

echo "Second response:"
echo "$RESPONSE2" | jq -r '.response'
echo ""

# Third message (another follow-up)
RESPONSE3=$(curl -s -X POST https://n8n.specialblend.icu/webhook/sbqc-ai-query \
  -H "Content-Type: application/json" \
  -d "{
    \"message\": \"Can you give me an example?\",
    \"model\": \"qwen2.5:7b-instruct-q4_0\",
    \"useRag\": false,
    \"conversationId\": \"$CONV_ID\"
  }" \
  --max-time 30)

echo "Third response:"
echo "$RESPONSE3" | jq -r '.response'
echo ""

echo "Conversation ID: $CONV_ID"
```

### Error Handling and Retry Logic

```bash
#!/bin/bash

# AI query with comprehensive error handling and retry logic

AI_GATEWAY_URL="https://n8n.specialblend.icu/webhook/sbqc-ai-query"
MAX_RETRIES=3
RETRY_DELAY=2
TIMEOUT=30

# Function to send AI query with retry logic
# Args: message, conversation_id (optional)
send_ai_query() {
  local message="$1"
  local conversation_id="$2"
  local attempt=1
  local response=""
  local http_code=""

  # Build JSON payload
  local payload="{\"message\": \"$message\", \"model\": \"qwen2.5:7b-instruct-q4_0\", \"useRag\": false"
  if [ -n "$conversation_id" ]; then
    payload="$payload, \"conversationId\": \"$conversation_id\""
  fi
  payload="$payload}"

  # Retry loop
  while [ $attempt -le $MAX_RETRIES ]; do
    echo "Attempt $attempt of $MAX_RETRIES..." >&2

    # Send request and capture both response and HTTP code
    response=$(curl -s -w "\n%{http_code}" -X POST "$AI_GATEWAY_URL" \
      -H "Content-Type: application/json" \
      -d "$payload" \
      --max-time "$TIMEOUT" \
      --connect-timeout 10 \
      2>&1)

    # Check if curl command succeeded
    local curl_exit=$?
    if [ $curl_exit -ne 0 ]; then
      echo "Error: cURL command failed with exit code $curl_exit" >&2

      if [ $curl_exit -eq 28 ]; then
        echo "Error: Request timed out after ${TIMEOUT}s" >&2
      elif [ $curl_exit -eq 6 ] || [ $curl_exit -eq 7 ]; then
        echo "Error: Could not connect to AI Gateway" >&2
      fi

      if [ $attempt -lt $MAX_RETRIES ]; then
        echo "Retrying in ${RETRY_DELAY}s..." >&2
        sleep $RETRY_DELAY
        ((attempt++))
        continue
      else
        echo "Error: Max retries exceeded" >&2
        return 1
      fi
    fi

    # Extract HTTP code (last line)
    http_code=$(echo "$response" | tail -n1)
    # Extract response body (all but last line)
    response=$(echo "$response" | sed '$d')

    # Check HTTP status code
    if [ "$http_code" -ge 200 ] && [ "$http_code" -lt 300 ]; then
      # Success - validate JSON response
      if echo "$response" | jq -e '.success' > /dev/null 2>&1; then
        local success=$(echo "$response" | jq -r '.success')

        if [ "$success" = "true" ]; then
          # Return successful response
          echo "$response"
          return 0
        else
          # API returned error
          local error_msg=$(echo "$response" | jq -r '.error // "Unknown error"')
          echo "Error: API returned error: $error_msg" >&2
          return 1
        fi
      else
        echo "Error: Invalid JSON response" >&2
        return 1
      fi
    elif [ "$http_code" -ge 500 ] && [ "$http_code" -lt 600 ]; then
      # Server error - retry
      echo "Error: Server error (HTTP $http_code)" >&2

      if [ $attempt -lt $MAX_RETRIES ]; then
        echo "Retrying in ${RETRY_DELAY}s..." >&2
        sleep $RETRY_DELAY
        ((attempt++))
        continue
      else
        echo "Error: Max retries exceeded" >&2
        return 1
      fi
    else
      # Client error or other - don't retry
      echo "Error: HTTP $http_code" >&2
      echo "$response" >&2
      return 1
    fi
  done

  return 1
}

# Example usage
main() {
  echo "Sending AI query..."

  # Send query
  result=$(send_ai_query "What is the capital of France?")

  if [ $? -eq 0 ]; then
    # Extract and display information
    ai_response=$(echo "$result" | jq -r '.response')
    conv_id=$(echo "$result" | jq -r '.conversationId')
    tokens=$(echo "$result" | jq -r '.tokens.total')

    echo ""
    echo "Response: $ai_response"
    echo "Conversation ID: $conv_id"
    echo "Tokens used: $tokens"

    # Follow-up question
    echo ""
    echo "Sending follow-up query..."
    result2=$(send_ai_query "Tell me more about its landmarks." "$conv_id")

    if [ $? -eq 0 ]; then
      ai_response2=$(echo "$result2" | jq -r '.response')
      echo ""
      echo "Follow-up Response: $ai_response2"
    else
      echo "Follow-up query failed"
      exit 1
    fi
  else
    echo "Query failed"
    exit 1
  fi
}

# Run main function
main
```

**Requirements:** The cURL examples require `jq` for JSON parsing. Install with:
- Ubuntu/Debian: `sudo apt-get install jq`
- macOS: `brew install jq`
- CentOS/RHEL: `sudo yum install jq`

---

## Go Examples

### Installation

```bash
go get -u github.com/go-resty/resty/v2
```

### Basic Request

```go
package main

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/go-resty/resty/v2"
)

// AIRequest represents the request payload for the AI Gateway
type AIRequest struct {
	Message        string  `json:"message"`
	Model          string  `json:"model"`
	UseRag         bool    `json:"useRag"`
	ConversationID *string `json:"conversationId,omitempty"`
}

// TokenInfo represents token usage information
type TokenInfo struct {
	Prompt     int `json:"prompt"`
	Completion int `json:"completion"`
	Total      int `json:"total"`
}

// AIResponse represents the response from the AI Gateway
type AIResponse struct {
	Success        bool      `json:"success"`
	Response       string    `json:"response"`
	ConversationID string    `json:"conversationId"`
	Tokens         TokenInfo `json:"tokens"`
	Error          string    `json:"error,omitempty"`
}

// AIClient handles communication with the SBQC N3.2 AI Gateway
type AIClient struct {
	client  *resty.Client
	baseURL string
	model   string
	useRag  bool
	timeout time.Duration
}

// NewAIClient creates a new AI Gateway client
func NewAIClient(model string, useRag bool, timeout time.Duration) *AIClient {
	client := resty.New()
	client.SetTimeout(timeout)
	client.SetHeader("Content-Type", "application/json")

	return &AIClient{
		client:  client,
		baseURL: "https://n8n.specialblend.icu/webhook/sbqc-ai-query",
		model:   model,
		useRag:  useRag,
		timeout: timeout,
	}
}

// Query sends a query to the AI Gateway
func (c *AIClient) Query(message string, conversationID *string) (*AIResponse, error) {
	// Build request payload
	request := AIRequest{
		Message:        message,
		Model:          c.model,
		UseRag:         c.useRag,
		ConversationID: conversationID,
	}

	// Send request
	resp, err := c.client.R().
		SetBody(request).
		SetResult(&AIResponse{}).
		SetError(&AIResponse{}).
		Post(c.baseURL)

	if err != nil {
		// Network or timeout error
		if resp == nil || resp.StatusCode() == 0 {
			return nil, fmt.Errorf("network error: %w", err)
		}
		return nil, fmt.Errorf("request failed: %w", err)
	}

	// Check HTTP status code
	if resp.StatusCode() >= 400 {
		errResp := resp.Error().(*AIResponse)
		if errResp.Error != "" {
			return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode(), errResp.Error)
		}
		return nil, fmt.Errorf("HTTP %d: request failed", resp.StatusCode())
	}

	// Parse successful response
	result := resp.Result().(*AIResponse)

	// Validate response
	if !result.Success {
		errorMsg := result.Error
		if errorMsg == "" {
			errorMsg = "unknown error"
		}
		return nil, fmt.Errorf("API error: %s", errorMsg)
	}

	return result, nil
}

// Example usage: Basic request
func main() {
	// Create client with 30-second timeout
	client := NewAIClient("qwen2.5:7b-instruct-q4_0", false, 30*time.Second)

	// Send query
	result, err := client.Query("What is the capital of France?", nil)
	if err != nil {
		fmt.Printf("Error: %v\n", err)
		return
	}

	// Display result
	fmt.Printf("Response: %s\n", result.Response)
	fmt.Printf("Conversation ID: %s\n", result.ConversationID)
	fmt.Printf("Tokens used: %d\n", result.Tokens.Total)
}
```

### Multi-Turn Conversation

```go
package main

import (
	"fmt"
	"time"

	"github.com/go-resty/resty/v2"
)

// ConversationMessage represents a single message in the conversation
type ConversationMessage struct {
	User      string `json:"user"`
	Assistant string `json:"assistant"`
}

// AIConversation manages multi-turn conversations with the AI Gateway
type AIConversation struct {
	client         *resty.Client
	baseURL        string
	model          string
	useRag         bool
	timeout        time.Duration
	conversationID string
	history        []ConversationMessage
	totalTokens    int
}

// NewAIConversation creates a new conversation session
func NewAIConversation(model string, useRag bool, timeout time.Duration) *AIConversation {
	client := resty.New()
	client.SetTimeout(timeout)
	client.SetHeader("Content-Type", "application/json")

	return &AIConversation{
		client:      client,
		baseURL:     "https://n8n.specialblend.icu/webhook/sbqc-ai-query",
		model:       model,
		useRag:      useRag,
		timeout:     timeout,
		history:     make([]ConversationMessage, 0),
		totalTokens: 0,
	}
}

// SendMessage sends a message in the conversation
func (c *AIConversation) SendMessage(message string) (string, error) {
	// Build request payload
	request := AIRequest{
		Message: message,
		Model:   c.model,
		UseRag:  c.useRag,
	}

	// Include conversation ID for follow-up messages
	if c.conversationID != "" {
		request.ConversationID = &c.conversationID
	}

	// Send request
	resp, err := c.client.R().
		SetBody(request).
		SetResult(&AIResponse{}).
		SetError(&AIResponse{}).
		Post(c.baseURL)

	if err != nil {
		if resp == nil || resp.StatusCode() == 0 {
			return "", fmt.Errorf("network error: %w", err)
		}
		return "", fmt.Errorf("request failed: %w", err)
	}

	// Check HTTP status code
	if resp.StatusCode() >= 400 {
		errResp := resp.Error().(*AIResponse)
		if errResp.Error != "" {
			return "", fmt.Errorf("HTTP %d: %s", resp.StatusCode(), errResp.Error)
		}
		return "", fmt.Errorf("HTTP %d: request failed", resp.StatusCode())
	}

	// Parse successful response
	result := resp.Result().(*AIResponse)

	// Validate response
	if !result.Success {
		errorMsg := result.Error
		if errorMsg == "" {
			errorMsg = "unknown error"
		}
		return "", fmt.Errorf("API error: %s", errorMsg)
	}

	// Store conversation ID from first response
	if c.conversationID == "" {
		c.conversationID = result.ConversationID
	}

	// Track conversation history
	c.history = append(c.history, ConversationMessage{
		User:      message,
		Assistant: result.Response,
	})

	// Update token count
	c.totalTokens += result.Tokens.Total

	return result.Response, nil
}

// GetConversationID returns the current conversation ID
func (c *AIConversation) GetConversationID() string {
	return c.conversationID
}

// GetHistory returns the full conversation history
func (c *AIConversation) GetHistory() []ConversationMessage {
	return c.history
}

// GetTotalTokens returns the total tokens used in this conversation
func (c *AIConversation) GetTotalTokens() int {
	return c.totalTokens
}

// Example usage: Multi-turn conversation
func main() {
	// Create conversation
	conversation := NewAIConversation("qwen2.5:7b-instruct-q4_0", false, 30*time.Second)

	// First message
	response1, err := conversation.SendMessage("What is Python?")
	if err != nil {
		fmt.Printf("Error: %v\n", err)
		return
	}
	fmt.Printf("AI: %s\n\n", response1)

	// Follow-up message (uses same conversation ID)
	response2, err := conversation.SendMessage("What are its main features?")
	if err != nil {
		fmt.Printf("Error: %v\n", err)
		return
	}
	fmt.Printf("AI: %s\n\n", response2)

	// Another follow-up
	response3, err := conversation.SendMessage("Can you give me an example?")
	if err != nil {
		fmt.Printf("Error: %v\n", err)
		return
	}
	fmt.Printf("AI: %s\n\n", response3)

	// Print conversation summary
	fmt.Printf("\nConversation ID: %s\n", conversation.GetConversationID())
	fmt.Printf("Total tokens used: %d\n", conversation.GetTotalTokens())
	fmt.Printf("Messages exchanged: %d\n", len(conversation.GetHistory()))
}
```

### Advanced: Retry Logic and Error Handling

```go
package main

import (
	"fmt"
	"time"

	"github.com/go-resty/resty/v2"
)

// RobustAIClient is a production-ready AI Gateway client with retry logic
type RobustAIClient struct {
	client     *resty.Client
	baseURL    string
	model      string
	useRag     bool
	timeout    time.Duration
	maxRetries int
}

// NewRobustAIClient creates a new robust AI Gateway client
func NewRobustAIClient(
	model string,
	useRag bool,
	timeout time.Duration,
	maxRetries int,
) *RobustAIClient {
	client := resty.New()
	client.SetTimeout(timeout)
	client.SetHeader("Content-Type", "application/json")

	// Configure retry logic
	client.SetRetryCount(maxRetries)
	client.SetRetryWaitTime(1 * time.Second)
	client.SetRetryMaxWaitTime(4 * time.Second)

	// Retry on specific status codes
	client.AddRetryCondition(func(r *resty.Response, err error) bool {
		// Retry on network errors or 5xx server errors
		if err != nil {
			return true
		}
		return r.StatusCode() >= 500
	})

	// Log retry attempts
	client.OnBeforeRequest(func(c *resty.Client, req *resty.Request) error {
		if req.Attempt > 0 {
			fmt.Printf("Retry attempt %d for %s\n", req.Attempt, req.URL)
		}
		return nil
	})

	return &RobustAIClient{
		client:     client,
		baseURL:    "https://n8n.specialblend.icu/webhook/sbqc-ai-query",
		model:      model,
		useRag:     useRag,
		timeout:    timeout,
		maxRetries: maxRetries,
	}
}

// QueryResult extends AIResponse with metadata
type QueryResult struct {
	AIResponse
	Metadata struct {
		ElapsedTime float64 `json:"elapsedTime"`
		StatusCode  int     `json:"statusCode"`
	} `json:"_metadata"`
}

// Query sends a query with automatic retry on failure
func (c *RobustAIClient) Query(message string, conversationID *string) (*QueryResult, error) {
	// Build request payload
	request := AIRequest{
		Message:        message,
		Model:          c.model,
		UseRag:         c.useRag,
		ConversationID: conversationID,
	}

	startTime := time.Now()

	// Send request with automatic retry
	resp, err := c.client.R().
		SetBody(request).
		SetResult(&AIResponse{}).
		SetError(&AIResponse{}).
		Post(c.baseURL)

	elapsedTime := time.Since(startTime).Seconds()

	if err != nil {
		// Check if it's a timeout error
		if resp == nil || resp.StatusCode() == 0 {
			return nil, fmt.Errorf(
				"request timed out after %.2fs. Consider increasing the timeout or checking network connectivity",
				elapsedTime,
			)
		}
		return nil, fmt.Errorf(
			"max retries exceeded. The AI Gateway may be unavailable. Error: %w",
			err,
		)
	}

	// Check HTTP status code
	if resp.StatusCode() >= 400 {
		errResp := resp.Error().(*AIResponse)
		if errResp.Error != "" {
			return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode(), errResp.Error)
		}
		return nil, fmt.Errorf("HTTP %d: request failed", resp.StatusCode())
	}

	// Parse successful response
	result := resp.Result().(*AIResponse)

	// Validate response
	if !result.Success {
		errorMsg := result.Error
		if errorMsg == "" {
			errorMsg = "unknown error"
		}
		return nil, fmt.Errorf("API error: %s", errorMsg)
	}

	// Create result with metadata
	queryResult := &QueryResult{
		AIResponse: *result,
	}
	queryResult.Metadata.ElapsedTime = elapsedTime
	queryResult.Metadata.StatusCode = resp.StatusCode()

	return queryResult, nil
}

// Example usage: Robust client with retry logic
func main() {
	// Create client with 30-second timeout and 3 retries
	client := NewRobustAIClient(
		"qwen2.5:7b-instruct-q4_0",
		false,
		30*time.Second,
		3,
	)

	// Send query
	result, err := client.Query("Explain machine learning in simple terms", nil)
	if err != nil {
		fmt.Printf("Error: %v\n", err)
		return
	}

	// Display result
	fmt.Printf("Response: %s\n", result.Response)
	fmt.Printf("Conversation ID: %s\n", result.ConversationID)
	fmt.Printf("Tokens: %d\n", result.Tokens.Total)
	fmt.Printf("Request time: %.2fs\n", result.Metadata.ElapsedTime)
}
```

### Complete Go Module Example

Create a `go.mod` file:

```go
module sbqc-ai-client

go 1.21

require github.com/go-resty/resty/v2 v2.11.0

require golang.org/x/net v0.19.0 // indirect
```

---

## Best Practices

### 1. Timeout Configuration

- **Recommended timeout:** 30 seconds for most queries
- **Long queries:** Consider 60+ seconds for complex questions with RAG enabled
- **Production:** Always set both connection timeout and request timeout

### 2. Error Handling

Always handle these error scenarios:
- **Network errors:** Connection refused, DNS lookup failures
- **Timeout errors:** Request took too long
- **HTTP errors:** 4xx client errors, 5xx server errors
- **API errors:** `success: false` in response body
- **Invalid responses:** Malformed JSON, missing required fields

### 3. Retry Logic

Implement exponential backoff for retries:
- **Retry on:** Network errors, timeouts, 5xx server errors
- **Don't retry on:** 4xx client errors (except 429 rate limit)
- **Max retries:** 3 attempts is usually sufficient
- **Backoff:** 1s, 2s, 4s between retries

### 4. Conversation Management

For multi-turn conversations:
- **Store conversation ID:** Save from first response and reuse
- **Track token usage:** Monitor cumulative token consumption
- **Set conversation timeout:** End stale conversations after inactivity
- **Clean up:** Clear conversation history when done

### 5. Production Considerations

- **Connection pooling:** Reuse HTTP connections for better performance
- **Rate limiting:** Implement client-side rate limiting if making many requests
- **Logging:** Log request/response details for debugging
- **Monitoring:** Track response times, error rates, and token usage
- **Security:** Never log sensitive data in messages

### 6. Performance Tips

- **Batch independent queries:** Make parallel requests when possible
- **Cache responses:** Cache frequently asked questions
- **Optimize messages:** Keep prompts concise but clear
- **Use RAG selectively:** Only enable RAG when you need document retrieval

---

## Testing

Test your integration with these scenarios:

### 1. Basic Functionality
```
Message: "What is 2 + 2?"
Expected: Numeric answer with explanation
```

### 2. Multi-Turn Conversation
```
Message 1: "Tell me about Paris"
Message 2: "What is its population?" (using conversationId)
Expected: Contextual response about Paris population
```

### 3. Error Handling
```
- Test with invalid endpoint URL
- Test with malformed JSON
- Test with very long timeout (60+ seconds)
```

### 4. Edge Cases
```
- Empty message
- Very long message (10,000+ characters)
- Special characters in message
- Concurrent requests with same conversation ID
```

---

## Troubleshooting

### Common Issues

1. **Connection Timeout**
   - Check network connectivity
   - Verify endpoint URL is correct
   - Increase connection timeout

2. **Request Timeout**
   - Complex queries may take longer
   - Increase request timeout to 60+ seconds
   - Check if RAG is enabled (slower)

3. **Invalid Conversation ID**
   - Ensure conversation ID is from a recent response
   - Conversation may have expired on server
   - Start new conversation if error persists

4. **Rate Limiting (429)**
   - Implement exponential backoff
   - Add delays between requests
   - Contact administrator if limit too low

5. **Server Errors (5xx)**
   - Implement retry logic with backoff
   - Check AI Gateway status
   - Contact administrator if persistent

---

## Support

For issues or questions:
1. Check the troubleshooting section above
2. Review error messages and logs
3. Test with cURL to isolate client vs. server issues
4. Contact the SBQC development team

---

## License

These examples are provided as-is for integration with the SBQC N3.2 AI Gateway.

---

**Last Updated:** 2026-01-02
**API Version:** N3.2
**Document Version:** 1.0.0
