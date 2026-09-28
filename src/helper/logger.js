const log = (level, component, message, meta = {}) => {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    component,
    message,
    ...meta,
  };
  const line = JSON.stringify(entry);
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
};

const logger = {
  info: (component, message, meta) => log('info', component, message, meta),
  warn: (component, message, meta) => log('warn', component, message, meta),
  error: (component, message, meta) => log('error', component, message, meta),
};

module.exports = logger;
