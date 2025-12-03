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

// Routes
const apiRoutes = require('./routes/api');
app.use('/api', apiRoutes);

// Health Check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', port: PORT });
});

// Fallback to Frontend
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`AgentX control running on http://localhost:${PORT}`);
});
