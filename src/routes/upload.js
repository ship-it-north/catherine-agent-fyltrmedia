/**
 * CSV lead upload route.
 * POST /api/upload-leads
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db/database');
const logger = require('../utils/logger');
const { parseCSV } = require('../utils/csv-parser');

// Ensure uploads directory exists
const uploadsDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer config — store CSV files temporarily
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ts = Date.now();
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${ts}_${safeName}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are accepted'));
    }
  }
});

// ─── POST /api/upload-leads ───────────────────────────────────────────────────
router.post('/upload-leads', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded. Use field name "file".' });
  }

  const filePath = req.file.path;

  try {
    const { leads, errors } = await parseCSV(filePath);

    if (leads.length === 0) {
      return res.status(400).json({
        error: 'No valid leads found in CSV',
        parseErrors: errors
      });
    }

    let inserted = 0;
    let updated = 0;
    const skipped = [];

    const insertStmt = db.prepare(`
      INSERT INTO leads (firstName, lastName, phone_number, companyName, email)
      VALUES (?, ?, ?, ?, ?)
    `);
    const updateStmt = db.prepare(`
      UPDATE leads SET firstName = ?, lastName = ?, companyName = ?, email = ?
      WHERE phone_number = ? AND status NOT IN ('calling', 'booked')
    `);

    // Use a transaction for bulk inserts
    const insertMany = db.transaction((leadsToInsert) => {
      for (const lead of leadsToInsert) {
        const existing = db.prepare('SELECT id, status FROM leads WHERE phone_number = ?')
          .get(lead.phone_number);

        if (existing) {
          if (['calling', 'booked'].includes(existing.status)) {
            skipped.push({ phone: lead.phone_number, reason: `Status is "${existing.status}"` });
          } else {
            updateStmt.run(lead.firstName, lead.lastName || null, lead.companyName || null, lead.email || null, lead.phone_number);
            updated++;
          }
        } else {
          try {
            insertStmt.run(
              lead.firstName,
              lead.lastName || null,
              lead.phone_number,
              lead.companyName || null,
              lead.email || null
            );
            inserted++;
          } catch (e) {
            skipped.push({ phone: lead.phone_number, reason: e.message });
          }
        }
      }
    });

    insertMany(leads);

    // Clean up uploaded file
    try {
      fs.unlinkSync(filePath);
    } catch (e) {
      // Non-critical
    }

    logger.info(`CSV upload: ${inserted} inserted, ${updated} updated, ${skipped.length} skipped`);

    return res.json({
      success: true,
      inserted,
      updated,
      skipped: skipped.length,
      skippedDetails: skipped.length > 0 ? skipped : undefined,
      parseErrors: errors.length > 0 ? errors : undefined,
      total: inserted + updated
    });
  } catch (err) {
    // Clean up file on error
    try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
    logger.error(`CSV upload error: ${err.message}`, err);
    return res.status(500).json({ error: err.message });
  }
});

// Multer error handler
router.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File too large (max 10MB)' });
  }
  if (err.message === 'Only CSV files are accepted') {
    return res.status(415).json({ error: err.message });
  }
  next(err);
});

module.exports = router;
