/**
 * CSV parser for lead uploads.
 * Expected columns: firstName, lastName, phone_number, companyName, email
 * Handles case-insensitive column names and multiple phone formats.
 */

const fs = require('fs');
const { parse } = require('csv-parse');

// Column name aliases (lowercase key → canonical name)
const COLUMN_ALIASES = {
  // firstName
  firstname: 'firstName',
  first_name: 'firstName',
  'first name': 'firstName',
  prenom: 'firstName',
  prénom: 'firstName',

  // lastName
  lastname: 'lastName',
  last_name: 'lastName',
  'last name': 'lastName',
  nom: 'lastName',
  surname: 'lastName',

  // phone_number
  phone_number: 'phone_number',
  phone: 'phone_number',
  telephone: 'phone_number',
  téléphone: 'phone_number',
  tel: 'phone_number',
  mobile: 'phone_number',
  cell: 'phone_number',
  'cell phone': 'phone_number',
  'phone number': 'phone_number',
  numero: 'phone_number',
  numéro: 'phone_number',

  // companyName
  companyname: 'companyName',
  company_name: 'companyName',
  company: 'companyName',
  'company name': 'companyName',
  entreprise: 'companyName',
  organisation: 'companyName',
  organization: 'companyName',
  business: 'companyName',
  'business name': 'companyName',

  // email
  email: 'email',
  'e-mail': 'email',
  courriel: 'email',
  'email address': 'email',
  'email_address': 'email'
};

/**
 * Normalize a phone number to E.164 format (+1XXXXXXXXXX for North American numbers).
 * @param {string} raw
 * @returns {string|null} Normalized phone or null if invalid
 */
function normalizePhone(raw) {
  if (!raw) return null;
  // Strip all non-digit characters except leading +
  let cleaned = String(raw).replace(/[^\d+]/g, '');

  if (cleaned.startsWith('+')) {
    // Already has country code
    if (cleaned.length >= 11) return cleaned;
    return null;
  }

  // 10 digits — assume North American (+1)
  if (cleaned.length === 10) {
    return `+1${cleaned}`;
  }

  // 11 digits starting with 1 — North American
  if (cleaned.length === 11 && cleaned.startsWith('1')) {
    return `+${cleaned}`;
  }

  // Too short or too long
  if (cleaned.length < 10) return null;

  return `+${cleaned}`;
}

/**
 * Parse a CSV file and return validated lead objects.
 * @param {string} filePath - Path to CSV file
 * @returns {Promise<{ leads: Array, errors: Array }>}
 */
function parseCSV(filePath) {
  return new Promise((resolve, reject) => {
    const leads = [];
    const errors = [];
    let rowIndex = 0;
    let headers = null;

    const parser = parse({
      bom: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true
    });

    parser.on('readable', () => {
      let record;
      while ((record = parser.read()) !== null) {
        rowIndex++;

        if (rowIndex === 1) {
          // First row — detect headers
          headers = record.map(h => {
            const normalized = String(h).trim().toLowerCase();
            return COLUMN_ALIASES[normalized] || normalized;
          });
          continue;
        }

        // Map record to object using headers
        const obj = {};
        if (headers) {
          headers.forEach((header, i) => {
            obj[header] = record[i] ? String(record[i]).trim() : '';
          });
        } else {
          // No header row detected — use positional mapping
          obj.firstName = record[0] || '';
          obj.lastName = record[1] || '';
          obj.phone_number = record[2] || '';
          obj.companyName = record[3] || '';
          obj.email = record[4] || '';
        }

        // Validate required fields
        if (!obj.firstName) {
          errors.push({ row: rowIndex, error: 'Missing firstName', data: record });
          continue;
        }

        if (!obj.phone_number) {
          errors.push({ row: rowIndex, error: 'Missing phone_number', data: record });
          continue;
        }

        const phone = normalizePhone(obj.phone_number);
        if (!phone) {
          errors.push({
            row: rowIndex,
            error: `Invalid phone number: "${obj.phone_number}"`,
            data: record
          });
          continue;
        }

        // Validate email if provided
        if (obj.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(obj.email)) {
          // Not a hard error — just clear it
          obj.email = '';
        }

        leads.push({
          firstName: obj.firstName,
          lastName: obj.lastName || null,
          phone_number: phone,
          companyName: obj.companyName || null,
          email: obj.email || null
        });
      }
    });

    parser.on('error', (err) => {
      reject(new Error(`CSV parse error: ${err.message}`));
    });

    parser.on('end', () => {
      resolve({ leads, errors });
    });

    // Stream file into parser
    try {
      const fileStream = fs.createReadStream(filePath);
      fileStream.on('error', (err) => reject(new Error(`File read error: ${err.message}`)));
      fileStream.pipe(parser);
    } catch (err) {
      reject(new Error(`Could not open file: ${err.message}`));
    }
  });
}

module.exports = { parseCSV, normalizePhone };
