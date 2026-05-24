/**
 * TwiML helper functions for building Twilio voice responses.
 */

const twilio = require('twilio');
const VoiceResponse = twilio.twiml.VoiceResponse;

/**
 * Build a TwiML response that speaks text then opens a speech Gather.
 * @param {string} speech - Text for Catherine to say
 * @param {string} language - 'fr' or 'en'
 * @param {string} [gatherAction] - URL for the gather action (default: /webhook/gather)
 * @returns {string} TwiML XML string
 */
function buildGatherResponse(speech, language, gatherAction) {
  const response = new VoiceResponse();
  const voice = language === 'fr' ? 'Polly.Chantal' : 'Polly.Joanna';
  const lang = language === 'fr' ? 'fr-CA' : 'en-US';

  const gather = response.gather({
    input: 'speech',
    action: gatherAction || '/webhook/gather',
    method: 'POST',
    timeout: 10,
    speechTimeout: 'auto',
    speechModel: 'experimental_conversations',
    language: lang,
    enhanced: 'true'
  });

  gather.say({ voice, language: lang }, speech);

  // If no input received, redirect to no-response handler
  response.redirect({ method: 'POST' }, '/webhook/no-response');

  return response.toString();
}

/**
 * Build a TwiML response that speaks text and hangs up.
 * @param {string} speech
 * @param {string} language - 'fr' or 'en'
 * @returns {string} TwiML XML string
 */
function buildSayAndHangup(speech, language) {
  const response = new VoiceResponse();
  const voice = language === 'fr' ? 'Polly.Chantal' : 'Polly.Joanna';
  const lang = language === 'fr' ? 'fr-CA' : 'en-US';
  response.say({ voice, language: lang }, speech);
  response.hangup();
  return response.toString();
}

/**
 * Build a TwiML response that only says something (no gather, no hangup).
 * Useful for interim messages.
 * @param {string} speech
 * @param {string} language
 * @returns {string} TwiML XML string
 */
function buildSayOnly(speech, language) {
  const response = new VoiceResponse();
  const voice = language === 'fr' ? 'Polly.Chantal' : 'Polly.Joanna';
  const lang = language === 'fr' ? 'fr-CA' : 'en-US';
  response.say({ voice, language: lang }, speech);
  return response.toString();
}

/**
 * Build an empty TwiML response (for AMD callbacks etc.)
 * @returns {string} TwiML XML string
 */
function buildEmptyResponse() {
  const response = new VoiceResponse();
  return response.toString();
}

/**
 * Build a voicemail TwiML: speak message then hang up.
 * @param {string} speech
 * @param {string} language
 * @returns {string} TwiML XML string
 */
function buildVoicemail(speech, language) {
  return buildSayAndHangup(speech, language);
}

module.exports = {
  buildGatherResponse,
  buildSayAndHangup,
  buildSayOnly,
  buildEmptyResponse,
  buildVoicemail
};
