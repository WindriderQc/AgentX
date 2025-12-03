/**
 * Database Connection Entry Point
 * Routes to either MongoDB or SQLite based on DB_TYPE environment variable
 */

const dbType = (process.env.DB_TYPE || 'mongodb').toLowerCase();

if (dbType === 'sqlite') {
  const sqlite = require('./db-sqlite');
  // For SQLite, export an async init function
  module.exports = async () => {
    console.log('[DB] Initializing SQLite database...');
    await sqlite.initDatabase();
    console.log('[DB] SQLite ready');
  };
} else {
  // For MongoDB, export the connectDB function directly
  const mongoConnect = require('./db-mongodb');
  module.exports = mongoConnect;
}
