/**
 * Call management API routes.
 *
 * POST /api/calls/initiate   — Trigger a single outbound call
 * GET  /api/calls/status     — All leads/calls status
 * GET  /api/calls/status/:id — Status for a single lead
 */

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const logger = require('../utils/logger');
const { makeOutboundCall } = require('../integrations/twilio');

// ─── POST /api/calls/initiate ─────────────────────────────────────────────────
router.post('/initiate', async (req, res) => {
  try {
    const { leadId, firstName, lastName, phone_number, companyName, email } = req.body;

    let lead;

    if (leadId) {
      // Look up existing lead
      lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
      if (!lead) {
        return res.status(404).json({ error: `Lead ${leadId} not found` });
      }
    } else {
      // Validate required fields
      if (!firstName || !phone_number) {
        return res.status(400).json({ error: 'firstName and phone_number are required' });
      }

      // Upsert lead by phone number
      const existing = db.prepare('SELECT * FROM leads WHERE phone_number = ?').get(phone_number);
      if (existing) {
        lead = existing;
      } else {
        const result = db.prepare(`
          INSERT INTO leads (firstName, lastName, phone_number, companyName, email)
          VALUES (?, ?, ?, ?, ?)
        `).run(firstName, lastName || null, phone_number, companyName || null, email || null);
        lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(result.lastInsertRowid);
      }
    }

    // Check if lead is already being called or has been booked
    if (lead.status === 'booked') {
      return res.status(409).json({
        error: 'Lead has already booked a meeting',
        lead: { id: lead.id, status: lead.status }
      });
    }
    if (lead.status === 'calling') {
      return res.status(409).json({
        error: 'Lead is currently being called',
        lead: { id: lead.id, status: lead.status }
      });
    }
    if (lead.attempt_count >= 3) {
      return res.status(409).json({
        error: 'Lead has exhausted all 3 call attempts',
        lead: { id: lead.id, status: lead.status }
      });
    }

    const attemptNumber = lead.attempt_count + 1;

    // Initiate the call
    const call = await makeOutboundCall(lead.phone_number, lead.id, attemptNumber);

    // Update lead status
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE leads
      SET status = 'calling', last_attempt_at = ?, attempt_count = attempt_count + 1
      WHERE id = ?
    `).run(now, lead.id);

    logger.info(`Manual call initiated: lead=${lead.id}, SID=${call.sid}, attempt=${attemptNumber}`);

    return res.json({
      success: true,
      callSid: call.sid,
      lead: {
        id: lead.id,
        name: `${lead.firstName} ${lead.lastName || ''}`.trim(),
        phone: lead.phone_number,
        attempt: attemptNumber
      }
    });
  } catch (err) {
    logger.error(`POST /api/calls/initiate error: ${err.message}`, err);
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/calls/status ────────────────────────────────────────────────────
router.get('/status', (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;

    let query = `
      SELECT
        l.*,
        COUNT(cl.id) as call_count,
        MAX(cl.started_at) as last_call_at,
        SUM(CASE WHEN cl.booked = 1 THEN 1 ELSE 0 END) as bookings
      FROM leads l
      LEFT JOIN call_logs cl ON cl.lead_id = l.id
    `;
    const params = [];

    if (status) {
      query += ' WHERE l.status = ?';
      params.push(status);
    }

    query += ' GROUP BY l.id ORDER BY l.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const leads = db.prepare(query).all(...params);

    // Summary stats
    const stats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'calling' THEN 1 ELSE 0 END) as calling,
        SUM(CASE WHEN status = 'retry' THEN 1 ELSE 0 END) as retry,
        SUM(CASE WHEN status = 'booked' THEN 1 ELSE 0 END) as booked,
        SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected,
        SUM(CASE WHEN status = 'email-followup' THEN 1 ELSE 0 END) as emailFollowup
      FROM leads
    `).get();

    return res.json({ stats, leads });
  } catch (err) {
    logger.error(`GET /api/calls/status error: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/calls/status/:leadId ────────────────────────────────────────────
router.get('/status/:leadId', (req, res) => {
  try {
    const leadId = parseInt(req.params.leadId, 10);
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);

    if (!lead) {
      return res.status(404).json({ error: `Lead ${leadId} not found` });
    }

    const callLogs = db.prepare(`
      SELECT cl.*, conv.state, conv.language, conv.history
      FROM call_logs cl
      LEFT JOIN conversations conv ON conv.call_sid = cl.call_sid
      WHERE cl.lead_id = ?
      ORDER BY cl.started_at DESC
    `).all(leadId);

    return res.json({ lead, callLogs });
  } catch (err) {
    logger.error(`GET /api/calls/status/${req.params.leadId} error: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
