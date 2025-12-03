const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/agentx', {
      serverSelectionTimeoutMS: 2000 // Fail fast if no DB
    });
    console.log(`MongoDB Connected: ${conn.connection.host}`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    // Don't kill the server if DB is missing, just log error for now to allow frontend verification
    // process.exit(1);
  }
};

module.exports = connectDB;
