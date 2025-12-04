require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');

const app = express();
const PORT = process.env.PORT || 3080;

// Connect to Database
connectDB();

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// V3: Mount RAG routes
const ragRoutes = require('./routes/rag');
app.use('/api/rag', ragRoutes);

// V4: Mount Analytics & Dataset routes
const analyticsRoutes = require('./routes/analytics');
app.use('/api/analytics', analyticsRoutes);

const datasetRoutes = require('./routes/dataset');
app.use('/api/dataset', datasetRoutes);

// Mount API routes
const apiRoutes = require('./routes/api');
app.use('/api', apiRoutes);

function buildErrorResponse(err) {
  return {
    status: 'error',
    message: err.message || 'Unknown error',
    details: err.body || undefined,
  };
}

// Health Check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', port: PORT });
});

// Config endpoint - expose server configuration
app.get('/api/config', (_req, res) => {
  const ollamaHost = process.env.OLLAMA_HOST || 'http://localhost:11434';
  // Parse host and port from OLLAMA_HOST
  const match = ollamaHost.match(/^(?:https?:\/\/)?([^:]+)(?::(\d+))?/);
  const host = match ? match[1] : 'localhost';
  const port = match && match[2] ? match[2] : '11434';
  
  res.json({
    ollama: {
      host,
      port,
      fullUrl: ollamaHost
    },
    embeddingModel: process.env.EMBEDDING_MODEL || 'nomic-embed-text'
  });
});

// Fallback to Frontend
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`AgentX control running on http://localhost:${PORT}`);
});
