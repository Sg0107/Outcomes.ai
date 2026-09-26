const app = require('./src/app');
const connectDB = require('./src/config/db.js');
const config = require('./src/config/env.js');

// Connect to Database and start server
connectDB().then(() => {
  app.listen(config.port, () => {
    console.log(`Server running in ${config.nodeEnv} mode on port ${config.port}`);
  });
});
