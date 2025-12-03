/**
 * Database Abstraction Layer
 * Supports both MongoDB (via Mongoose) and SQLite (via sqlite3)
 * 
 * Switch database type using DB_TYPE environment variable:
 * - DB_TYPE=mongodb (default, requires MONGO_URI)
 * - DB_TYPE=sqlite (requires SQLITE_PATH, defaults to ./agentx.db)
 */

const dbType = (process.env.DB_TYPE || 'mongodb').toLowerCase();

let dbModule;

if (dbType === 'sqlite') {
  console.log('[DB] Using SQLite database');
  dbModule = require('./db-sqlite');
} else {
  console.log('[DB] Using MongoDB database');
  dbModule = require('./db-mongodb');
}

module.exports = dbModule;
