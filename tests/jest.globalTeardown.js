const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const MONGO_URI_FILE = path.join(__dirname, '.jest-mongo-uri');

module.exports = async () => {
  try {
    await mongoose.disconnect();
  } catch {
    // ignore
  }

  try {
    if (global.__MONGOD__) {
      await global.__MONGOD__.stop();
    }
  } finally {
    try {
      fs.unlinkSync(MONGO_URI_FILE);
    } catch {
      // ignore
    }
  }

  if (global.gc) {
    global.gc();
  }

  await new Promise(resolve => setTimeout(resolve, 250));
};
