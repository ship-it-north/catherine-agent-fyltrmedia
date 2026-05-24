/**
 * Cron-based outbound call scheduler.
 * Runs every 2 minutes during business hours (Mon-Fri 9am-5pm ET).
 * Processes leads in 'pending' or 'retry' status up to 5 at a time.
 */

const cron = require('node-cron');
const moment = require('moment-timezone');
const db = require('../db/database');
const { makeOutboundCall } = require('../integrations/twilio');
const logger = require('../utils/logger');

const TIMEZONE = 'America/Toronto';
const CALL_HOURS_START = 9;   // 9:00 AM ET
const CALL_HOURS_END = 17;    // 5:00 PM ET (17:00)
const CALL_DAYS = [1, 2, 3, 4, 5]; // Monday through Friday
const MIN_HOURS_BETWEEN_ATTEMPTS = 48;
const MAX_ATTEMPTS = 3;
const BATCH_SIZE = 5;

let isProcessing = false;

/**
 * Check if current time is within business calling hours.
 * @returns {boolean}
 */
function isBusinessHours() {
  const now = moment().tz(TIMEZONE);
  const hour = now.hour();
  const day = now.day(); // 0=Sunday, 1=Monday, ..., 6=Saturday
  return CALL_DAYS.includes(day) && hour >= CALL_HOURS_START && hour < CALL_HOURS_END;
}

/**
 * Query and call up to BATCH_SIZE leads that are due for a call attempt.
 */
async function processDueLeads() {
  if (isProcessing) {
    logger.debug('Scheduler: already processing — skipping this tick');
    return;
  }

  if (!isBusinessHours()) {
    logger.debug('Scheduler: outside business hours — skipping');
    return;
  }

  isProcessing = true;

  try {
    const now = new Date().toISOString();

    const leads = db.prepare(`
      SELECT * FROM leads
      WHERE status IN ('pending', 'retry')
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        AND attempt_count < ?
      ORDER BY created_at ASC
      LIMIT ?
    `).all(now, MAX_ATTEMPTS, BATCH_SIZE);

    if (leads.length === 0) {
      logger.debug('Scheduler: no leads due for calling');
      return;
    }

    logger.info(`Scheduler: processing ${leads.length} due lead(s)`);

    for (const lead of leads) {
      try {
        const attemptNumber = lead.attempt_count + 1;

        // Mark as 'calling' before the API call to prevent duplicate calls
        db.prepare(`
          UPDATE leads
          SET status = 'calling', last_attempt_at = ?, attempt_count = attempt_count + 1
          WHERE id = ? AND status IN ('pending', 'retry')
        `).run(now, lead.id);

        await makeOutboundCall(lead.phone_number, lead.id, attemptNumber);

        logger.info(
          `Scheduler: called ${lead.firstName} ${lead.lastName || ''} ` +
          `at ${lead.phone_number} (attempt ${attemptNumber}/${MAX_ATTEMPTS})`
        );
      } catch (err) {
        logger.error(`Scheduler: failed to call lead ${lead.id} (${lead.phone_number}): ${err.message}`);

        // Roll back status so it can be retried
        const retryAfter = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min
        db.prepare(`
          UPDATE leads
          SET status = 'retry', next_attempt_at = ?, attempt_count = MAX(0, attempt_count - 1)
          WHERE id = ?
        `).run(retryAfter, lead.id);
      }
    }
  } catch (err) {
    logger.error(`Scheduler processDueLeads error: ${err.message}`, err);
  } finally {
    isProcessing = false;
  }
}

/**
 * Start the cron scheduler.
 */
function start() {
  // Run every 2 minutes
  cron.schedule('*/2 * * * *', processDueLeads, { timezone: TIMEZONE });
  logger.info('Scheduler started — checking for leads every 2 minutes during business hours (Mon-Fri 9am-5pm ET)');
}

/**
 * Manually trigger a scheduler run (for testing/admin).
 */
async function runNow() {
  logger.info('Scheduler: manual trigger');
  await processDueLeads();
}

module.exports = { start, isBusinessHours, processDueLeads, runNow };
