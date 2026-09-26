const dotenv = require('dotenv');

dotenv.config();

module.exports = {
  port: process.env.PORT || 3000,
  mongoUri: process.env.MONGO_URI || 'mongodb://localhost:27017/Outcomes',
  nodeEnv: process.env.NODE_ENV || 'development',
};
