/**
 * Database Connection Entry Point
 * Exclusively uses MongoDB via Mongoose
 */

const mongoConnect = require('./db-mongodb');

module.exports = mongoConnect;
