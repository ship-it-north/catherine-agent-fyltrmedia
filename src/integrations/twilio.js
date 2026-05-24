const twilio = require('twilio');
const logger = require('../utils/logger');
const db = require('../db/database');

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

/**
 * Make an outbound call to a lead.
 * @param {string} phoneNumber - E.164 formatted phone number
 * @param {number} leadId - DB lead ID
 * @param {number} attemptNumber - Which attempt this is (1, 2, or 3)
 * @returns {Promise<object>} Twilio call object
 */
async function makeOutboundCall(phoneNumber, leadId, attemptNumber) {
  const baseUrl = process.env.WEBHOOK_BASE_URL;
  if (!baseUrl) {
    throw new Error('WEBHOOK_BASE_URL is not configured');
  }

  const call = await client.calls.create({
    to: phoneNumber,
    from: process.env.TWILIO_PHONE_NUMBER,
    url: `${baseUrl}/webhook/voice`,
    method: 'POST',
    statusCallback: `${baseUrl}/webhook/status`,
    statusCallbackMethod: 'POST',
    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    machineDetection: 'DetectMessageEnd',
    asyncAmdStatusCallback: `${baseUrl}/webhook/amd`,
    asyncAmdStatusCallbackMethod: 'POST',
    record: false
  });

  logger.info(`Outbound call initiated: SID=${call.sid}, to=${phoneNumber}, attempt=${attemptNumber}`);

  // Create call log entry
  try {
    db.prepare(`
      INSERT OR IGNORE INTO call_logs (lead_id, call_sid, attempt_number, started_at)
      VALUES (?, ?, ?, ?)
    `).run(leadId, call.sid, attemptNumber, new Date().toISOString());

    // Create conversation record
    db.prepare(`
      INSERT OR IGNORE INTO conversations (call_sid, lead_id, state, language, attempt_number)
      VALUES (?, ?, 'init', 'fr', ?)
    `).run(call.sid, leadId, attemptNumber);
  } catch (dbErr) {
    logger.error(`DB error creating call log for SID ${call.sid}: ${dbErr.message}`);
  }

  return call;
}

module.exports = client;
module.exports.makeOutboundCall = makeOutboundCall;
