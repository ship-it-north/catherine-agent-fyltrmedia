const moment = require('moment-timezone');

const TIMEZONE = 'America/Toronto';

/**
 * Get the next N available appointment slots based on Philip's availability:
 * - Mon-Fri: 6pm-9pm ET
 * - Sat-Sun: 10am-6pm ET
 * Slots are on the hour, 30-minute duration.
 *
 * @param {number} count - Number of slots to return (default 2)
 * @returns {Array<object>} Array of slot objects
 */
function getNextAvailableSlots(count = 2) {
  const slots = [];
  let check = moment().tz(TIMEZONE).add(1, 'hour').startOf('hour');
  let maxIterations = 200; // Safety limit

  while (slots.length < count && maxIterations-- > 0) {
    const hour = check.hour();
    const day = check.day(); // 0=Sun, 1=Mon, ..., 6=Sat
    const isWeekend = day === 0 || day === 6;

    let available = false;
    if (isWeekend && hour >= 10 && hour < 18) available = true;
    if (!isWeekend && hour >= 18 && hour < 21) available = true;

    if (available) {
      const slot = check.clone();
      slots.push({
        startTime: slot.toISOString(),
        endTime: slot.clone().add(30, 'minutes').toISOString(),
        labelFr: formatSlotFr(slot),
        labelEn: formatSlotEn(slot)
      });
    }

    check.add(1, 'hour');
  }

  return slots;
}

const FR_DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const EN_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Format a moment.js object as a French label, e.g. "mercredi à 19h00"
 */
function formatSlotFr(m) {
  const day = FR_DAYS[m.day()];
  const hour = m.hour();
  const min = m.minute();
  return `${day} à ${hour}h${min === 0 ? '00' : String(min).padStart(2, '0')}`;
}

/**
 * Format a moment.js object as an English label, e.g. "Wednesday at 7:00 PM"
 */
function formatSlotEn(m) {
  const day = EN_DAYS[m.day()];
  let hour = m.hour();
  const min = m.minute();
  const ampm = hour >= 12 ? 'PM' : 'AM';
  if (hour > 12) hour -= 12;
  if (hour === 0) hour = 12;
  return `${day} at ${hour}:${min === 0 ? '00' : String(min).padStart(2, '0')} ${ampm}`;
}

module.exports = { getNextAvailableSlots, formatSlotFr, formatSlotEn };
