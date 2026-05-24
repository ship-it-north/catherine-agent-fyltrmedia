const { google } = require('googleapis');
const logger = require('../utils/logger');

const HEADERS = ['Date', 'Lead Name', 'Company', 'Phone', 'Attempt #', 'Outcome', 'Booked Y/N', 'Next Action'];

function getAuth() {
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!json) return null;
  try {
    const credentials = JSON.parse(json);
    return new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
  } catch (err) {
    logger.error(`Failed to parse GOOGLE_SERVICE_ACCOUNT_JSON: ${err.message}`);
    return null;
  }
}

/**
 * Ensure the header row exists in the Google Sheet.
 */
async function ensureHeaders() {
  const auth = getAuth();
  if (!auth) return;

  try {
    const sheets = google.sheets({ version: 'v4', auth });
    const SHEET_ID = process.env.GOOGLE_SHEET_ID;
    const TAB = process.env.GOOGLE_SHEET_TAB || 'Catherine — Call Logs';

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${TAB}!A1:H1`
    });

    const rows = res.data.values || [];
    if (rows.length === 0 || !rows[0] || rows[0][0] !== 'Date') {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${TAB}!A1:H1`,
        valueInputOption: 'RAW',
        requestBody: { values: [HEADERS] }
      });
      logger.info('Google Sheets headers created');
    }
  } catch (err) {
    logger.error(`ensureHeaders error: ${err.message}`);
  }
}

/**
 * Log a call to Google Sheets.
 * @param {object} callData
 * @param {string} callData.date
 * @param {string} callData.leadName
 * @param {string} callData.company
 * @param {string} callData.phone
 * @param {number} callData.attemptNumber
 * @param {string} callData.outcome
 * @param {boolean} callData.booked
 * @param {string} callData.nextAction
 * @returns {Promise<boolean>} true if successfully logged
 */
async function logCall(callData) {
  const auth = getAuth();
  if (!auth) {
    logger.warn('Google Sheets not configured — skipping log');
    return false;
  }

  try {
    const sheets = google.sheets({ version: 'v4', auth });
    const SHEET_ID = process.env.GOOGLE_SHEET_ID;
    const TAB = process.env.GOOGLE_SHEET_TAB || 'Catherine — Call Logs';

    const row = [
      callData.date || new Date().toISOString(),
      callData.leadName || '',
      callData.company || '',
      callData.phone || '',
      callData.attemptNumber || 1,
      callData.outcome || 'unknown',
      callData.booked ? 'Y' : 'N',
      callData.nextAction || ''
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${TAB}!A:H`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] }
    });

    logger.info(`Call logged to Sheets: ${callData.leadName}, outcome=${callData.outcome}`);
    return true;
  } catch (err) {
    logger.error(`Google Sheets logCall error: ${err.message}`);
    return false;
  }
}

module.exports = { logCall, ensureHeaders };
