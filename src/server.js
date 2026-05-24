require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const logger = require('./utils/logger');
const db = require('./db/database');
const scheduler = require('./utils/scheduler');
const twilioClient = require('./integrations/twilio');
const sheetsService = require('./integrations/sheets');

const webhookRoutes = require('./routes/webhooks');
const callRoutes = require('./routes/calls');
const uploadRoutes = require('./routes/upload');

const app = express();
const PORT = process.env.PORT || 3000;

// Parse URL-encoded (Twilio webhooks) and JSON bodies
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Routes
app.use('/webhook', webhookRoutes);
app.use('/api/calls', callRoutes);
app.use('/api', uploadRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    agent: 'Catherine',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// Root info
app.get('/', (req, res) => {
  res.json({
    agent: 'Catherine — Fyltr Media AI Voice Agent',
    status: 'live',
    endpoints: {
      health: 'GET /health',
      uploadLeads: 'POST /api/upload-leads',
      initiateCall: 'POST /api/calls/initiate',
      callStatus: 'GET /api/calls/status',
      callStatusById: 'GET /api/calls/status/:leadId'
    }
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  logger.error(`Unhandled error: ${err.message}`, err);
  res.status(500).json({ error: 'Internal server error' });
});

/**
 * Auto-configure Twilio webhook URLs on startup using WEBHOOK_BASE_URL env var.
 */
async function updateTwilioWebhook() {
  const baseUrl = process.env.WEBHOOK_BASE_URL;
  if (!baseUrl) {
    logger.warn('WEBHOOK_BASE_URL not set — Twilio webhook not updated');
    return;
  }
  try {
    const phoneNumbers = await twilioClient.incomingPhoneNumbers.list({
      phoneNumber: process.env.TWILIO_PHONE_NUMBER
    });
    if (phoneNumbers.length > 0) {
      await twilioClient.incomingPhoneNumbers(phoneNumbers[0].sid).update({
        voiceUrl: `${baseUrl}/webhook/voice`,
        voiceMethod: 'POST',
        statusCallback: `${baseUrl}/webhook/status`,
        statusCallbackMethod: 'POST'
      });
      logger.info(`Twilio webhook updated to ${baseUrl}/webhook/voice`);
    } else {
      logger.warn(`No Twilio number found matching ${process.env.TWILIO_PHONE_NUMBER}`);
    }
  } catch (err) {
    logger.error(`Failed to update Twilio webhook: ${err.message}`);
  }
}

const server = app.listen(PORT, async () => {
  logger.info(`Catherine agent listening on port ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);

  // Initialize Google Sheets headers
  try {
    await sheetsService.ensureHeaders();
  } catch (err) {
    logger.warn(`Could not initialize Sheets headers: ${err.message}`);
  }

  // Register Twilio webhook
  await updateTwilioWebhook();

  // Start outbound call scheduler
  scheduler.start();
  logger.info('Catherine AI Voice Agent is live and ready');
});

// Graceful shutdown
function gracefulShutdown(signal) {
  logger.info(`${signal} received — shutting down gracefully`);
  server.close(() => {
    logger.info('HTTP server closed');
    try {
      db.close();
      logger.info('Database connection closed');
    } catch (e) {
      // ignore
    }
    process.exit(0);
  });

  // Force exit after 10 seconds
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception: ${err.message}`, err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection: ${reason}`);
});

module.exports = app;
