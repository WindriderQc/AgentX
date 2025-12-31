const fetch = require('node-fetch');

const API_URL = 'http://localhost:3080/api/rag/search';

async function testSearch() {
  try {
    const payload = {
      query: "how many totalFiles do I have?",
      topK: 5,
      minScore: 0.0 // Set to 0 to see all results and their scores
    };

    console.log('Testing RAG search with query:', payload.query);
    
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    
    if (data.results) {
      console.log(`Found ${data.resultCount} results.`);
      data.results.forEach((res, i) => {
        console.log(`\nResult ${i + 1}:`);
        console.log(`Score: ${res.score}`);
        console.log(`Source: ${res.metadata.title}`);
        console.log(`Snippet: ${res.text.substring(0, 100)}...`);
      });
    } else {
      console.log('No results found or error:', data);
    }

  } catch (err) {
    console.error('Error:', err);
  }
}

testSearch();
