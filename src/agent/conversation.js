/**
 * Core conversation engine for Catherine.
 * Manages state machine, calls OpenAI, handles booking and logging.
 */

const OpenAI = require('openai').default;
const { getSystemPrompt } = require('./prompts');
const calendlyService = require('../integrations/calendly');
const sheetsService = require('../integrations/sheets');
const db = require('../db/database');
const logger = require('../utils/logger');
const { getNextAvailableSlots } = require('../utils/availability');

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

/**
 * Process one turn of the conversation.
 * @param {string} callSid - Twilio call SID
 * @param {string|null} speechResult - What the prospect said (null on first turn)
 * @returns {Promise<object>} { speech, language, action, nextState, appointmentSlot }
 */
async function processConversationTurn(callSid, speechResult) {
  // 1. Load conversation state
  let conv = db.prepare('SELECT * FROM conversations WHERE call_sid = ?').get(callSid);
  if (!conv) {
    logger.warn(`No conversation found for callSid ${callSid} — creating default`);
    db.prepare(`
      INSERT OR IGNORE INTO conversations (call_sid, state, language, attempt_number)
      VALUES (?, 'init', 'fr', 1)
    `).run(callSid);
    conv = db.prepare('SELECT * FROM conversations WHERE call_sid = ?').get(callSid);
  }

  // 2. Load lead info
  const lead = conv.lead_id
    ? db.prepare('SELECT * FROM leads WHERE id = ?').get(conv.lead_id)
    : null;

  // 3. Parse conversation history
  let history = [];
  try {
    history = JSON.parse(conv.history || '[]');
  } catch (e) {
    history = [];
  }

  // 4. First turn — return greeting
  if (conv.state === 'init' || !speechResult) {
    const greeting = await getGreeting(lead, conv.attempt_number);
    // Advance state
    db.prepare(`UPDATE conversations SET state = 'greeting', updated_at = ? WHERE call_sid = ?`)
      .run(new Date().toISOString(), callSid);
    return {
      speech: greeting,
      language: 'fr',
      action: 'continue',
      nextState: 'greeting',
      appointmentSlot: null
    };
  }

  // 5. Add prospect's response to history
  history.push({ role: 'user', content: speechResult });

  // 6. Get available slots for context
  let availableSlots = [];
  try {
    const et = await calendlyService.getEventType();
    if (et && et.uri) {
      availableSlots = await calendlyService.getAvailableSlots(et.uri);
    }
  } catch (err) {
    logger.warn(`Could not fetch Calendly slots: ${err.message}`);
  }
  // Fall back to local availability logic
  if (!availableSlots || availableSlots.length === 0) {
    availableSlots = getNextAvailableSlots(2);
  }

  // 7. Call AI for next response
  let aiResponse;
  if (openai) {
    aiResponse = await callAI(history, lead, conv.state, conv.language, availableSlots, conv.attempt_number);
  } else {
    aiResponse = await scriptedFallback(speechResult, conv.state, conv.language, lead, availableSlots);
  }

  // 8. Handle booking action
  if (aiResponse.action === 'book_appointment' && aiResponse.appointmentSlot) {
    aiResponse = await handleBooking(aiResponse, conv, lead, callSid);
  }

  // 9. Handle email collection
  if (aiResponse.action === 'collect_email') {
    db.prepare(`UPDATE conversations SET email_collected = NULL, state = 'email_collection', updated_at = ? WHERE call_sid = ?`)
      .run(new Date().toISOString(), callSid);
  }

  // 10. Add Catherine's response to history
  history.push({ role: 'assistant', content: aiResponse.speech });

  // 11. Persist updated conversation
  const newState = aiResponse.nextState || conv.state;
  const newLanguage = aiResponse.language || conv.language;
  db.prepare(`
    UPDATE conversations
    SET state = ?, language = ?, history = ?, updated_at = ?
    WHERE call_sid = ?
  `).run(newState, newLanguage, JSON.stringify(history), new Date().toISOString(), callSid);

  // 12. Update transcript in call_logs
  try {
    const transcript = history.map(m => `${m.role === 'user' ? 'Prospect' : 'Catherine'}: ${m.content}`).join('\n');
    db.prepare(`
      UPDATE call_logs SET transcript = ?, language_detected = ? WHERE call_sid = ?
    `).run(transcript, newLanguage, callSid);
  } catch (e) {
    // Non-critical
  }

  return {
    speech: aiResponse.speech,
    language: newLanguage,
    action: aiResponse.action || 'continue',
    nextState: newState,
    appointmentSlot: aiResponse.appointmentSlot || null
  };
}

/**
 * Get the opening greeting for a call.
 * @param {object|null} lead
 * @param {number} attemptNumber
 * @returns {string} Greeting text
 */
async function getGreeting(lead, attemptNumber) {
  const firstName = lead ? lead.firstName : '';

  if (attemptNumber >= 3) {
    // Voicemail version
    return `Bonjour, ce message est pour ${firstName || 'vous'}. Je m'appelle Catherine, j'appelle de la part de Fyltr Media. C'est mon troisième essai de vous joindre — je voulais vous parler d'une approche qui aide les entreprises à améliorer leurs résultats publicitaires grâce à l'IA. N'hésitez pas à nous rappeler ou à visiter fyltrmedia.com. Bonne journée!`;
  }

  if (attemptNumber === 2) {
    return `Bonjour, est-ce que je parle bien à ${firstName || 'vous'}? Je m'appelle Catherine, je rappelle de la part de Fyltr Media — on s'était parlé brièvement la semaine passée. J'avais quelques questions rapides pour vous. Est-ce que c'est un bon moment?`;
  }

  return `Bonjour, est-ce que je parle bien à ${firstName || 'vous'}?`;
}

/**
 * Call GPT-4o-mini with full conversation history and return structured response.
 */
async function callAI(history, lead, state, language, availableSlots, attemptNumber) {
  try {
    const systemPrompt = getSystemPrompt(lead, availableSlots, attemptNumber || 1);

    const messages = [
      { role: 'system', content: systemPrompt },
      ...history
    ];

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      temperature: 0.7,
      max_tokens: 400,
      response_format: { type: 'json_object' }
    });

    const raw = response.choices[0].message.content;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      logger.error(`Failed to parse AI response as JSON: ${raw}`);
      return scriptedFallback(history[history.length - 1]?.content || '', state, language, lead, availableSlots);
    }

    // Validate required fields
    if (!parsed.speech) {
      parsed.speech = language === 'fr'
        ? "Excusez-moi, pourriez-vous répéter?"
        : "I'm sorry, could you repeat that?";
    }
    if (!parsed.language) parsed.language = language;
    if (!parsed.action) parsed.action = 'continue';
    if (!parsed.nextState) parsed.nextState = state;

    return parsed;
  } catch (err) {
    logger.error(`OpenAI callAI error: ${err.message}`);
    return scriptedFallback(
      history[history.length - 1]?.content || '',
      state,
      language,
      lead,
      availableSlots
    );
  }
}

/**
 * Rule-based fallback conversation engine (used when OpenAI is unavailable).
 */
async function scriptedFallback(speechResult, state, language, lead, availableSlots) {
  const speech = (speechResult || '').toLowerCase();
  const isFr = language !== 'en';

  // Language detection — switch to English if needed
  const englishWords = ['yes', 'no', 'hello', 'hi', 'sure', 'okay', 'what', 'how', 'not', 'i am', "i'm"];
  const speaksEnglish = englishWords.some(w => speech.includes(w));
  const detectedLang = speaksEnglish ? 'en' : (isFr ? 'fr' : 'en');

  const slot1 = availableSlots && availableSlots[0];
  const slot2 = availableSlots && availableSlots[1];

  // Negative keywords
  const negative = ['non', 'no', 'pas intéressé', 'not interested', 'arrêt', 'stop', 'jamais', 'never', 'occupé maintenant', 'busy'];
  const isNegative = negative.some(w => speech.includes(w));

  const stateMap = {
    greeting: {
      fr: {
        speech: `Parfait! J'appelle de la part de Fyltr Media. On aide les entreprises à ne plus jamais manquer un appel client grâce à nos agents IA disponibles 24h sur 24. J'aurais juste deux ou trois questions rapides. Est-ce que c'est un bon moment?`,
        nextState: 'q1'
      },
      en: {
        speech: `Perfect! I'm calling from Fyltr Media. We help businesses never miss another client call with AI agents available 24/7. I just have a couple of quick questions. Is now a good time?`,
        nextState: 'q1'
      }
    },
    q1: {
      fr: {
        speech: `En ce moment, qu'arrive-t-il à vos appels quand votre équipe est occupée ou après les heures de bureau?`,
        nextState: 'q2'
      },
      en: {
        speech: `Right now, what happens to your calls when your team is busy or after business hours?`,
        nextState: 'q2'
      }
    },
    q2: {
      fr: {
        speech: `Je vois. Et combien de nouveaux clients par mois visez-vous idéalement?`,
        nextState: 'q3'
      },
      en: {
        speech: `I see. And how many new clients per month are you ideally looking to bring in?`,
        nextState: 'q3'
      }
    },
    q3: {
      fr: {
        speech: `Intéressant. Et avez-vous déjà pensé à automatiser votre suivi de leads ou vos appels entrants?`,
        nextState: 'bridge'
      },
      en: {
        speech: `Interesting. Have you ever thought about automating your lead follow-up or inbound calls?`,
        nextState: 'bridge'
      }
    },
    bridge: {
      fr: {
        speech: `C'est exactement ce qu'on règle. On installe un agent IA qui répond à chaque appel 24h sur 24, qualifie chaque lead, et réserve les rendez-vous automatiquement — sans que vous leviez le petit doigt. Plusieurs clients récupèrent 40 à 50% des leads qu'ils perdaient avant. Philip a quelques disponibilités pour un appel de 15 minutes gratuit.`,
        nextState: 'slots'
      },
      en: {
        speech: `That's exactly what we solve. We set up an AI agent that answers every call 24/7, qualifies every lead, and books appointments automatically — without you lifting a finger. Several clients recover 40 to 50% of leads they were losing. Philip has a few openings for a free 15-minute call.`,
        nextState: 'slots'
      }
    },
    slots: {
      fr: {
        speech: `Est-ce que vous seriez disponible ${slot1 ? slot1.labelFr : 'lundi soir'} ou ${slot2 ? slot2.labelFr : 'mercredi soir'}?`,
        nextState: 'email_collection',
        action: isNegative ? 'continue' : 'continue'
      },
      en: {
        speech: `Would you be available ${slot1 ? slot1.labelEn : 'Monday evening'} or ${slot2 ? slot2.labelEn : 'Wednesday evening'}?`,
        nextState: 'email_collection'
      }
    },
    email_collection: {
      fr: {
        speech: `Parfait! Pour confirmer votre rendez-vous, j'aurais besoin de votre adresse courriel. C'est quoi?`,
        nextState: 'email_collection',
        action: 'collect_email'
      },
      en: {
        speech: `Perfect! To confirm your appointment, I'll need your email address. What is it?`,
        nextState: 'email_collection',
        action: 'collect_email'
      }
    }
  };

  if (isNegative && state !== 'email_collection') {
    return {
      speech: detectedLang === 'fr'
        ? `Je comprends tout à fait. Je vous remercie pour votre temps, ${lead ? lead.firstName : ''}. Bonne journée!`
        : `I completely understand. Thank you for your time${lead ? ', ' + lead.firstName : ''}. Have a great day!`,
      language: detectedLang,
      nextState: 'end_negative',
      action: 'end_call_negative',
      appointmentSlot: null
    };
  }

  const stateOptions = stateMap[state] || stateMap['greeting'];
  const option = stateOptions[detectedLang] || stateOptions['fr'];

  return {
    speech: option.speech,
    language: detectedLang,
    nextState: option.nextState || state,
    action: option.action || 'continue',
    appointmentSlot: null
  };
}

/**
 * Handle the booking flow: book via Calendly and update DB.
 */
async function handleBooking(aiResponse, conv, lead, callSid) {
  const { appointmentSlot } = aiResponse;

  // Build invitee info
  const email = conv.email_collected || (lead && lead.email);
  const name = lead ? `${lead.firstName} ${lead.lastName || ''}`.trim() : 'Unknown';
  const phone = lead ? lead.phone_number : '';

  if (!email) {
    // Need email first
    const lang = conv.language;
    return {
      ...aiResponse,
      speech: lang === 'fr'
        ? "Pour confirmer le rendez-vous, j'aurais besoin de votre adresse courriel. C'est quoi?"
        : "To confirm the appointment, I'll need your email address. What is it?",
      action: 'collect_email',
      nextState: 'email_collection'
    };
  }

  try {
    // Get event type URI
    const et = await calendlyService.getEventType();
    const eventTypeUri = et ? et.uri : null;

    const booking = await calendlyService.bookAppointment(
      { name, email, phone },
      appointmentSlot.startTime,
      eventTypeUri
    );

    if (booking.success) {
      // Update lead as booked
      const bookingDetails = JSON.stringify({
        slot: appointmentSlot,
        booking,
        bookedAt: new Date().toISOString()
      });
      if (lead) {
        db.prepare(`
          UPDATE leads SET status = 'booked', booked_at = ?, booking_details = ? WHERE id = ?
        `).run(new Date().toISOString(), bookingDetails, lead.id);
      }
      db.prepare(`
        UPDATE call_logs SET booked = 1, next_action = 'Booked' WHERE call_sid = ?
      `).run(callSid);

      const slotLabel = conv.language === 'fr'
        ? (appointmentSlot.label || appointmentSlot.labelFr || appointmentSlot.startTime)
        : (appointmentSlot.labelEn || appointmentSlot.label || appointmentSlot.startTime);

      const confirmSpeech = conv.language === 'fr'
        ? `Excellent! J'ai réservé votre appel avec Philip pour ${slotLabel}. Vous allez recevoir une confirmation par courriel sous peu. Merci beaucoup, ${lead ? lead.firstName : ''}! Bonne journée!`
        : `Excellent! I've booked your call with Philip for ${slotLabel}. You'll receive an email confirmation shortly. Thank you so much, ${lead ? lead.firstName : ''}! Have a great day!`;

      return {
        ...aiResponse,
        speech: confirmSpeech,
        action: 'end_call_positive',
        nextState: 'booking_confirmation'
      };
    } else {
      // Booking failed — note it and continue
      logger.error(`Booking failed for lead ${lead ? lead.id : 'unknown'}: ${booking.error}`);
      const fallbackSpeech = conv.language === 'fr'
        ? `Parfait! Philip va vous contacter directement pour confirmer le créneau. Merci beaucoup, ${lead ? lead.firstName : ''}! Bonne journée!`
        : `Great! Philip will reach out to confirm the time slot directly. Thank you so much, ${lead ? lead.firstName : ''}! Have a great day!`;
      return {
        ...aiResponse,
        speech: fallbackSpeech,
        action: 'end_call_positive',
        nextState: 'end_positive'
      };
    }
  } catch (err) {
    logger.error(`handleBooking error: ${err.message}`);
    return {
      ...aiResponse,
      speech: conv.language === 'fr'
        ? `Merci beaucoup pour votre intérêt! Philip va vous contacter bientôt. Bonne journée!`
        : `Thank you so much for your interest! Philip will be in touch soon. Have a great day!`,
      action: 'end_call_positive',
      nextState: 'end_positive'
    };
  }
}

module.exports = { processConversationTurn, getGreeting };
