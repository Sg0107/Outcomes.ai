const app = require('./src/app');
const connectDB = require('./src/config/db.js');
const config = require('./src/config/env.js');
const { startSummaryWorker } = require('./src/worker/summaryWorker');

// Connect to Database and start server
connectDB().then(async () => {
  await startSummaryWorker();
  app.listen(config.port, () => {
    console.log(`Server running in ${config.nodeEnv} mode on port ${config.port}`);
  });
});
