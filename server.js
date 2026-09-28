const app = require('./src/app');
const connectDB = require('./src/config/db.js');
const config = require('./src/config/env.js');
const logger = require('./src/helper/logger');
const { startSummaryWorker } = require('./src/worker/summaryWorker');

// Connect to Database and start server
connectDB().then(async () => {
  logger.info('server', 'MongoDB connected', { nodeEnv: config.nodeEnv });
  await startSummaryWorker();
  app.listen(config.port, () => {
    logger.info('server', 'HTTP server listening', { port: config.port, nodeEnv: config.nodeEnv });
  });
});
