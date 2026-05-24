/**
 * Twilio webhook routes for Catherine voice agent.
 *
 * Routes:
 *  POST /webhook/voice       — Outbound call connected (human answered)
 *  POST /webhook/gather      — Prospect has spoken; process and respond
 *  POST /webhook/status      — Call status updates (completed, busy, no-answer, etc.)
 *  POST /webhook/amd         — Answering machine detection callback
 *  POST /webhook/no-response — No speech detected during gather
 */

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const logger = require('../utils/logger');
const { processConversationTurn, getGreeting } = require('../agent/conversation');
const {
  buildGatherResponse,
  buildSayAndHangup,
  buildVoicemail,
  buildEmptyResponse
} = require('../agent/twiml-helpers');
const sheetsService = require('../integrations/sheets');

// ─── POST /webhook/voice ──────────────────────────────────────────────────────
// Called when the outbound call is answered (human confirmed by AMD or first ring)
router.post('/voice', async (req, res) => {
  res.setHeader('Content-Type', 'text/xml');

  const callSid = req.body.CallSid;
  const answeredBy = req.body.AnsweredBy; // 'human', 'machine_start', 'machine_end_beep', etc.

  logger.info(`/webhook/voice: CallSid=${callSid}, AnsweredBy=${answeredBy}`);

  try {
    // Retrieve conversation
    const conv = db.prepare('SELECT * FROM conversations WHERE call_sid = ?').get(callSid);

    // If AMD already flagged this as a machine, handle voicemail
    if (answeredBy && answeredBy.startsWith('machine')) {
      const attemptNumber = conv ? conv.attempt_number : 1;

      if (attemptNumber >= 3) {
        // Leave voicemail on 3rd attempt
        const lead = conv && conv.lead_id
          ? db.prepare('SELECT * FROM leads WHERE id = ?').get(conv.lead_id)
          : null;
        const vmScript = await getGreeting(lead, 3); // attempt 3 = voicemail version
        const twiml = buildVoicemail(vmScript, 'fr');
        updateCallOutcome(callSid, 'voicemail');
        return res.send(twiml);
      } else {
        // Hang up silently — will retry later
        updateCallOutcome(callSid, 'machine_no_message');
        const response = buildSayAndHangup('', 'fr');
        // Actually just hang up without speaking
        const twilio = require('twilio');
        const vr = new twilio.twiml.VoiceResponse();
        vr.hangup();
        return res.send(vr.toString());
      }
    }

    // Human answered — start conversation
    const result = await processConversationTurn(callSid, null);
    const twiml = buildGatherResponse(result.speech, result.language);
    return res.send(twiml);
  } catch (err) {
    logger.error(`/webhook/voice error: ${err.message}`, err);
    const twiml = buildSayAndHangup(
      "Désolé, une erreur s'est produite. Veuillez rappeler plus tard.",
      'fr'
    );
    return res.send(twiml);
  }
});

// ─── POST /webhook/gather ─────────────────────────────────────────────────────
// Called after prospect speaks during a Gather
router.post('/gather', async (req, res) => {
  res.setHeader('Content-Type', 'text/xml');

  const callSid = req.body.CallSid;
  const speechResult = req.body.SpeechResult || '';
  const confidence = parseFloat(req.body.Confidence || '0');

  logger.info(`/webhook/gather: CallSid=${callSid}, Speech="${speechResult}", Confidence=${confidence}`);

  try {
    // Low confidence or empty — ask to repeat
    if (!speechResult || speechResult.trim() === '') {
      const conv = db.prepare('SELECT * FROM conversations WHERE call_sid = ?').get(callSid);
      const lang = conv ? conv.language : 'fr';
      const reprompt = lang === 'fr'
        ? "Excusez-moi, je n'ai pas bien entendu. Pourriez-vous répéter?"
        : "Sorry, I didn't quite catch that. Could you repeat?";
      return res.send(buildGatherResponse(reprompt, lang));
    }

    const result = await processConversationTurn(callSid, speechResult);

    // Determine if we should hang up after speaking
    const endActions = ['end_call_positive', 'end_call_negative', 'leave_voicemail'];
    if (endActions.includes(result.action)) {
      const twiml = buildSayAndHangup(result.speech, result.language);
      return res.send(twiml);
    }

    // Continue gathering
    const twiml = buildGatherResponse(result.speech, result.language);
    return res.send(twiml);
  } catch (err) {
    logger.error(`/webhook/gather error: ${err.message}`, err);
    const twiml = buildSayAndHangup(
      "Je suis désolée, il y a eu une erreur. Bonne journée!",
      'fr'
    );
    return res.send(twiml);
  }
});

// ─── POST /webhook/status ─────────────────────────────────────────────────────
// Called on every call status change (initiated, ringing, answered, completed)
router.post('/status', async (req, res) => {
  res.sendStatus(204);

  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus; // 'completed', 'busy', 'no-answer', 'failed', 'canceled'
  const callDuration = parseInt(req.body.CallDuration || '0', 10);

  logger.info(`/webhook/status: CallSid=${callSid}, Status=${callStatus}, Duration=${callDuration}s`);

  if (callStatus !== 'completed' && callStatus !== 'busy' && callStatus !== 'no-answer' && callStatus !== 'failed') {
    return; // Only process terminal states
  }

  try {
    const callLog = db.prepare('SELECT * FROM call_logs WHERE call_sid = ?').get(callSid);
    const conv = db.prepare('SELECT * FROM conversations WHERE call_sid = ?').get(callSid);

    if (!callLog) {
      logger.warn(`No call_log found for SID ${callSid}`);
      return;
    }

    const lead = callLog.lead_id
      ? db.prepare('SELECT * FROM leads WHERE id = ?').get(callLog.lead_id)
      : null;

    // Map Twilio status to our outcome
    const outcomeMap = {
      completed: 'completed',
      busy: 'busy',
      'no-answer': 'no_answer',
      failed: 'failed',
      canceled: 'canceled'
    };
    const outcome = callLog.outcome || outcomeMap[callStatus] || callStatus;

    // Update call_log
    db.prepare(`
      UPDATE call_logs
      SET ended_at = ?, duration_seconds = ?, outcome = ?
      WHERE call_sid = ?
    `).run(new Date().toISOString(), callDuration, outcome, callSid);

    // Update lead status
    if (lead) {
      const isBooked = callLog.booked === 1 || (conv && conv.state === 'booking_confirmation');

      if (isBooked) {
        db.prepare(`UPDATE leads SET status = 'booked' WHERE id = ?`).run(lead.id);
      } else if (callStatus === 'no-answer' || callStatus === 'busy') {
        const retryAfter = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
        db.prepare(`
          UPDATE leads SET status = 'retry', next_attempt_at = ? WHERE id = ?
        `).run(retryAfter, lead.id);

        if (lead.attempt_count >= 3) {
          db.prepare(`UPDATE leads SET status = 'email-followup' WHERE id = ?`).run(lead.id);
        }
      } else if (callStatus === 'completed') {
        const finalState = conv ? conv.state : '';
        if (['end_negative', 'end_negative', 'rejected'].includes(finalState)) {
          db.prepare(`UPDATE leads SET status = 'rejected' WHERE id = ?`).run(lead.id);
        } else if (!isBooked) {
          // Completed but no booking — schedule retry if attempts remain
          if (lead.attempt_count < 3) {
            const retryAfter = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
            db.prepare(`
              UPDATE leads SET status = 'retry', next_attempt_at = ? WHERE id = ?
            `).run(retryAfter, lead.id);
          } else {
            db.prepare(`UPDATE leads SET status = 'email-followup' WHERE id = ?`).run(lead.id);
          }
        }
      }
    }

    // Log to Google Sheets if not already done
    if (!callLog.sheets_logged) {
      const booked = callLog.booked === 1;
      const nextAction = determineNextAction(lead, callStatus, booked);

      const logged = await sheetsService.logCall({
        date: new Date().toISOString(),
        leadName: lead ? `${lead.firstName} ${lead.lastName || ''}`.trim() : 'Unknown',
        company: lead ? lead.companyName || '' : '',
        phone: lead ? lead.phone_number : '',
        attemptNumber: callLog.attempt_number || 1,
        outcome,
        booked,
        nextAction
      });

      if (logged) {
        db.prepare(`UPDATE call_logs SET sheets_logged = 1, next_action = ? WHERE call_sid = ?`)
          .run(nextAction, callSid);
      }
    }
  } catch (err) {
    logger.error(`/webhook/status processing error: ${err.message}`, err);
  }
});

// ─── POST /webhook/amd ────────────────────────────────────────────────────────
// Async AMD callback — called when Twilio determines human vs machine
router.post('/amd', async (req, res) => {
  res.sendStatus(204);

  const callSid = req.body.CallSid;
  const answeredBy = req.body.AnsweredBy; // 'human', 'machine_start', 'machine_end_beep', 'machine_end_silence', 'unknown'

  logger.info(`/webhook/amd: CallSid=${callSid}, AnsweredBy=${answeredBy}`);

  try {
    const conv = db.prepare('SELECT * FROM conversations WHERE call_sid = ?').get(callSid);
    const isMachine = answeredBy && answeredBy.startsWith('machine');

    if (isMachine) {
      const attemptNumber = conv ? conv.attempt_number : 1;
      const baseUrl = process.env.WEBHOOK_BASE_URL;

      if (attemptNumber >= 3 && answeredBy === 'machine_end_beep') {
        // Redirect call to leave voicemail
        const twilioClient = require('../integrations/twilio');
        try {
          await twilioClient.calls(callSid).update({
            url: `${baseUrl}/webhook/voicemail`,
            method: 'POST'
          });
        } catch (e) {
          logger.warn(`Could not redirect call to voicemail: ${e.message}`);
        }
      } else if (answeredBy !== 'machine_end_beep') {
        // Machine still recording — hang up
        const twilioClient = require('../integrations/twilio');
        try {
          await twilioClient.calls(callSid).update({ status: 'completed' });
        } catch (e) {
          logger.warn(`Could not hang up machine call: ${e.message}`);
        }
      }
    }
    // If human, /webhook/voice already handles it
  } catch (err) {
    logger.error(`/webhook/amd error: ${err.message}`);
  }
});

// ─── POST /webhook/voicemail ──────────────────────────────────────────────────
// Redirected here to leave voicemail after AMD detects machine + beep
router.post('/voicemail', async (req, res) => {
  res.setHeader('Content-Type', 'text/xml');

  const callSid = req.body.CallSid;
  const conv = db.prepare('SELECT * FROM conversations WHERE call_sid = ?').get(callSid);
  const lead = conv && conv.lead_id
    ? db.prepare('SELECT * FROM leads WHERE id = ?').get(conv.lead_id)
    : null;

  const vmText = await getGreeting(lead, 3);
  const twiml = buildVoicemail(vmText, 'fr');
  updateCallOutcome(callSid, 'voicemail');
  return res.send(twiml);
});

// ─── POST /webhook/no-response ────────────────────────────────────────────────
// Called when Gather receives no input (redirect from gather)
router.post('/no-response', (req, res) => {
  res.setHeader('Content-Type', 'text/xml');

  const callSid = req.body.CallSid;
  const conv = db.prepare('SELECT * FROM conversations WHERE call_sid = ?').get(callSid);
  const lang = conv ? conv.language : 'fr';

  const prompt = lang === 'fr'
    ? "Êtes-vous toujours là? Je ne vous entends pas. Bonne journée!"
    : "Are you still there? I can't hear you. Have a great day!";

  return res.send(buildSayAndHangup(prompt, lang));
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function updateCallOutcome(callSid, outcome) {
  try {
    db.prepare(`UPDATE call_logs SET outcome = ? WHERE call_sid = ?`).run(outcome, callSid);
  } catch (e) {
    logger.error(`updateCallOutcome error: ${e.message}`);
  }
}

function determineNextAction(lead, callStatus, booked) {
  if (booked) return 'Meeting booked';
  if (!lead) return 'Unknown';

  const attempts = lead.attempt_count || 0;
  if (callStatus === 'no-answer' || callStatus === 'busy') {
    return attempts >= 3 ? 'Email follow-up' : `Retry attempt ${attempts + 1} in 48h`;
  }
  if (callStatus === 'completed') {
    return attempts >= 3 ? 'Email follow-up' : `Retry attempt ${attempts + 1} in 48h`;
  }
  return 'Review manually';
}

module.exports = router;
