const path = require('path');
const express = require('express');
const encounterRoutes = require('./routes/encounterRoutes');
const app = express();

// Middleware
app.use(express.json());

// Health Check Route
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', message: 'Outcomes API is running' });
});

// API v1 Routes
app.use('/v1', encounterRoutes);

// Local page for exercising the API
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Centralized Error Handler Middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    error: {
      message: err.message || 'Internal Server Error',
    },
  });
});

module.exports = app;
