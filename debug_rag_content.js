const fetch = require('node-fetch');

const QDRANT_URL = 'http://localhost:6333';
const COLLECTION_NAME = 'agentx_embeddings';

async function searchForContent() {
  try {
    console.log('Searching Qdrant for "totalFiles"...');
    const response = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}/points/scroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        limit: 10,
        with_payload: true,
        with_vector: false,
        filter: {
            should: [
                {
                    key: "text",
                    match: { text: "totalFiles" }
                }
            ]
        }
      })
    });

    const data = await response.json();
    
    if (data.result && data.result.points) {
      console.log(`Found ${data.result.points.length} points matching 'totalFiles'.`);
      data.result.points.forEach(point => {
        console.log(`- ID: ${point.id}`);
        console.log(`  Title: ${point.payload.title}`);
        console.log(`  Path: ${point.payload.path}`);
        console.log(`  Snippet: ${point.payload.text.substring(0, 150)}...`);
      });
    } else {
      console.log('No points found.');
      console.log('Response:', JSON.stringify(data, null, 2));
    }

  } catch (err) {
    console.error('Error:', err);
  }
}

searchForContent();
