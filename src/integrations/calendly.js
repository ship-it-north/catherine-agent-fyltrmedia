const axios = require('axios');
const logger = require('../utils/logger');

const CALENDLY_BASE = 'https://api.calendly.com';

function getHeaders() {
  return {
    Authorization: `Bearer ${process.env.CALENDLY_API_TOKEN}`,
    'Content-Type': 'application/json'
  };
}

/**
 * Extract user UUID from the Calendly JWT without calling /users/me
 * (token lacks users:read scope).
 */
function getUserUriFromToken() {
  try {
    const token = process.env.CALENDLY_API_TOKEN || '';
    const payload = token.split('.')[1];
    if (!payload) return null;
    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    const uuid = decoded.user_uuid;
    return uuid ? `https://api.calendly.com/users/${uuid}` : null;
  } catch {
    return null;
  }
}

/**
 * Get the event type resource matching CALENDLY_EVENT_URL.
 * @returns {Promise<object|null>} Event type resource or null if not found
 */
async function getEventType() {
  try {
    const userUri = getUserUriFromToken();
    if (!userUri) {
      logger.error('Could not extract user URI from Calendly token');
      return null;
    }

    const res = await axios.get(`${CALENDLY_BASE}/event_types`, {
      headers: getHeaders(),
      params: { user: userUri, active: true }
    });

    const eventTypes = res.data.collection || [];
    const targetUrl = process.env.CALENDLY_EVENT_URL || '';

    // Match by slug in the scheduling_url
    const match = eventTypes.find(et => {
      const slug = targetUrl.split('/').pop();
      return et.scheduling_url && et.scheduling_url.includes(slug);
    });

    return match || eventTypes[0] || null;
  } catch (err) {
    logger.error(`Calendly getEventType error: ${err.message}`);
    return null;
  }
}

/**
 * Get available appointment slots for the event type.
 * Filtered to Philip's availability: Mon-Fri 6pm-9pm ET, Sat-Sun 10am-6pm ET.
 * @param {string} eventTypeUri - Calendly event type URI
 * @param {number} daysAhead - How many days to look ahead
 * @returns {Promise<Array>} Available slots
 */
async function getAvailableSlots(eventTypeUri, daysAhead = 14) {
  try {
    // Start 1 hour from now to satisfy Calendly's "must be in the future" requirement
    const now = new Date(Date.now() + 60 * 60 * 1000);
    const end = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);

    const res = await axios.get(`${CALENDLY_BASE}/event_type_available_times`, {
      headers: getHeaders(),
      params: {
        event_type: eventTypeUri,
        start_time: now.toISOString(),
        end_time: end.toISOString()
      }
    });

    const allTimes = res.data.collection || [];

    // Filter to Philip's availability windows (ET = UTC-4 or UTC-5)
    const filtered = allTimes.filter(slot => {
      const date = new Date(slot.start_time);
      // Convert to ET (approximate: UTC-5 for EST, UTC-4 for EDT)
      const etOffset = isEDT(date) ? -4 : -5;
      const etHour = (date.getUTCHours() + etOffset + 24) % 24;
      const etDay = getETDay(date, etOffset);

      const isWeekend = etDay === 0 || etDay === 6;
      if (isWeekend && etHour >= 10 && etHour < 18) return true;
      if (!isWeekend && etHour >= 18 && etHour < 21) return true;
      return false;
    });

    // Return first 2 suitable slots
    return filtered.slice(0, 2).map(slot => ({
      startTime: slot.start_time,
      endTime: slot.invitees_remaining ? slot.start_time : new Date(new Date(slot.start_time).getTime() + 30 * 60 * 1000).toISOString(),
      labelFr: formatSlotFr(new Date(slot.start_time)),
      labelEn: formatSlotEn(new Date(slot.start_time))
    }));
  } catch (err) {
    logger.error(`Calendly getAvailableSlots error: ${err.message}`);
    return [];
  }
}

/**
 * Create a single-use Calendly scheduling link.
 * @param {string} eventTypeUri
 * @returns {Promise<object>} Scheduling link resource
 */
async function createSchedulingLink(eventTypeUri) {
  const res = await axios.post(`${CALENDLY_BASE}/scheduling_links`, {
    max_event_count: 1,
    owner: eventTypeUri,
    owner_type: 'EventType'
  }, { headers: getHeaders() });
  return res.data.resource;
}

/**
 * Book an appointment via Calendly.
 * Tries direct booking first, falls back to scheduling link.
 * @param {object} inviteeInfo - { name, email, phone }
 * @param {string} startTime - ISO8601 start time
 * @param {string} eventTypeUri - Calendly event type URI
 * @returns {Promise<object>} Booking result
 */
async function bookAppointment(inviteeInfo, startTime, eventTypeUri) {
  // Extract UUID from event type URI
  const eventTypeUuid = eventTypeUri ? eventTypeUri.split('/').pop() : null;

  // Attempt direct booking via Calendly internal API
  if (eventTypeUuid && inviteeInfo.email) {
    try {
      const response = await axios.post('https://calendly.com/api/booking/invitees', {
        full_name: inviteeInfo.name,
        email: inviteeInfo.email,
        start_time: startTime,
        event_type_uuid: eventTypeUuid,
        timezone: 'America/Toronto',
        questions_and_answers: []
      }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000
      });
      logger.info(`Calendly direct booking success for ${inviteeInfo.email}`);
      return { success: true, type: 'direct', data: response.data };
    } catch (err) {
      logger.warn(`Calendly direct booking failed (${err.message}), falling back to scheduling link`);
    }
  }

  // Fallback: create a single-use scheduling link
  try {
    const link = await createSchedulingLink(eventTypeUri);
    logger.info(`Calendly scheduling link created: ${link.booking_url}`);
    return { success: true, type: 'link', bookingUrl: link.booking_url };
  } catch (err) {
    logger.error(`Calendly createSchedulingLink error: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Rough check: is a date during Eastern Daylight Time?
 * EDT runs from second Sunday of March to first Sunday of November.
 */
function isEDT(date) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth(); // 0-indexed
  return month >= 2 && month <= 9; // March–October (conservative)
}

function getETDay(date, etOffset) {
  const etMs = date.getTime() + etOffset * 60 * 60 * 1000;
  return new Date(etMs).getUTCDay();
}

const FR_DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const EN_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function formatSlotFr(date) {
  const etOffset = isEDT(date) ? -4 : -5;
  const etMs = date.getTime() + etOffset * 60 * 60 * 1000;
  const etDate = new Date(etMs);
  const day = FR_DAYS[etDate.getUTCDay()];
  const hour = etDate.getUTCHours();
  const min = etDate.getUTCMinutes();
  return `${day} à ${hour}h${min === 0 ? '00' : min}`;
}

function formatSlotEn(date) {
  const etOffset = isEDT(date) ? -4 : -5;
  const etMs = date.getTime() + etOffset * 60 * 60 * 1000;
  const etDate = new Date(etMs);
  const day = EN_DAYS[etDate.getUTCDay()];
  let hour = etDate.getUTCHours();
  const min = etDate.getUTCMinutes();
  const ampm = hour >= 12 ? 'PM' : 'AM';
  if (hour > 12) hour -= 12;
  if (hour === 0) hour = 12;
  return `${day} at ${hour}:${min === 0 ? '00' : min} ${ampm}`;
}

module.exports = {
  getUserUriFromToken,
  getEventType,
  getAvailableSlots,
  createSchedulingLink,
  bookAppointment
};
