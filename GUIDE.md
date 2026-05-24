# Catherine — Fyltr Media AI Voice Agent
## Operations Guide

---

## 1. Daily Lead Upload

**CSV Format**

Create a `.csv` file with these columns (column names are flexible — the system handles variations):

```
firstName,lastName,phone_number,companyName,email
Jean,Tremblay,+15146661234,Clinique Tremblay,jean@tremblay.com
Marie,Dupont,+14501239876,Dupont HVAC,
```

- `phone_number`: Can be `5141234567` (10 digits), `+15141234567`, or `15141234567`. The system normalizes to E.164.
- `email`: Optional but recommended for Calendly booking confirmations.
- All other columns are required.

**Upload Endpoint**

```
POST https://your-railway-app.up.railway.app/api/upload-leads
Content-Type: multipart/form-data
Field name: file
```

**Using cURL:**
```bash
curl -X POST https://your-app.up.railway.app/api/upload-leads \
  -F "file=@leads.csv"
```

**Response:**
```json
{
  "success": true,
  "inserted": 42,
  "updated": 3,
  "skipped": 1,
  "total": 45
}
```

---

## 2. Reading the Call Log (Google Sheets)

The sheet is at: `https://docs.google.com/spreadsheets/d/1rK-wdQ2rK74v55XiMz9v4CLFVAOhCTvzC4qxZpsXkKo`

**Tab:** `Catherine — Call Logs`

| Column | Description |
|--------|-------------|
| Date | Timestamp of the call |
| Lead Name | Prospect's full name |
| Company | Company name |
| Phone | Phone number dialed |
| Attempt # | Which call attempt (1, 2, or 3) |
| Outcome | `completed`, `no_answer`, `busy`, `voicemail`, etc. |
| Booked Y/N | `Y` if a meeting was booked |
| Next Action | `Meeting booked`, `Retry in 48h`, `Email follow-up`, etc. |

**Important:** Share the Google Sheet with the service account email (found in `GOOGLE_SERVICE_ACCOUNT_JSON` → `client_email` field) as **Editor**.

---

## 3. Monitoring Performance

**API Endpoints:**

```bash
# Overall stats
GET /api/calls/status

# By status filter
GET /api/calls/status?status=booked
GET /api/calls/status?status=pending
GET /api/calls/status?status=retry

# Individual lead
GET /api/calls/status/42
```

**Response includes:**
- Total leads by status (pending, calling, retry, booked, rejected, email-followup)
- Full lead list with call count and last call time

**Railway Logs:**
1. Go to [railway.app](https://railway.app)
2. Open your `catherine-agent` service
3. Click **Logs** tab

Look for:
- `Calling [name] at [phone] (attempt X/3)` — scheduler firing
- `Twilio webhook updated` — startup success
- `Call logged to Sheets` — Google Sheets logging
- Any `ERROR` lines

---

## 4. Monthly Cost Breakdown

| Service | Usage Estimate | Monthly Cost |
|---------|---------------|--------------|
| **Twilio** | 500 calls × ~2 min avg | ~$40–60 |
| - Outbound call (per min) | $0.014/min | |
| - Polly TTS (per char) | $0.000004/char | |
| - Speech recognition | $0.01/15 sec | |
| **OpenAI GPT-4o-mini** | ~500 calls × 10 turns | ~$3–8 |
| **Railway hosting** | Hobby tier | $5 |
| **Calendly** | Standard plan | $12 |
| **Google Sheets API** | Free tier | $0 |
| **Total** | | **~$60–85/month** |

---

## 5. Environment Variables Reference

| Variable | Description | Required |
|----------|-------------|----------|
| `TWILIO_ACCOUNT_SID` | Twilio account SID (starts with AC) | Yes |
| `TWILIO_AUTH_TOKEN` | Twilio auth token | Yes |
| `TWILIO_PHONE_NUMBER` | Your Twilio number (E.164: +16205268438) | Yes |
| `OPENAI_API_KEY` | OpenAI API key (sk-...) | Yes |
| `CALENDLY_API_TOKEN` | Calendly personal access token | Yes |
| `CALENDLY_EVENT_URL` | Full Calendly event URL | Yes |
| `GOOGLE_SHEET_ID` | Google Sheet ID from URL | Yes |
| `GOOGLE_SHEET_TAB` | Tab name (default: `Catherine — Call Logs`) | No |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Full service account JSON (one line) | Yes |
| `WEBHOOK_BASE_URL` | Public HTTPS URL of this app | Yes |
| `PORT` | Port to listen on (Railway sets this) | No |
| `NODE_ENV` | `production` or `development` | No |
| `DB_PATH` | SQLite file path (default: `./data/catherine.db`) | No |

**Setting on Railway:**
1. Open your service → **Variables** tab
2. Click **New Variable** for each

---

## 6. Google Sheets Service Account Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a project (or use an existing one)
3. Enable the **Google Sheets API**
4. Go to **IAM & Admin → Service Accounts**
5. Create a new service account (e.g., `catherine-sheets@your-project.iam.gserviceaccount.com`)
6. Click **Keys → Add Key → Create new key → JSON**
7. Download the JSON file
8. Copy the entire JSON file contents as a single line
9. Set it as `GOOGLE_SERVICE_ACCOUNT_JSON` in Railway
10. **Share your Google Sheet** with the service account email address as **Editor**

The service account email looks like:
`catherine@your-project-name.iam.gserviceaccount.com`

---

## 7. Call Flow Overview

```
CSV Upload → DB (status: pending)
     ↓
Scheduler (every 2 min, Mon-Fri 9am-5pm ET)
     ↓
Twilio outbound call with AMD
     ↓
Human?  → /webhook/voice → greeting
     ↓
Prospect speaks → /webhook/gather
     ↓
GPT-4o-mini → next response
     ↓
3 qualifying questions → bridge pitch → offer slots
     ↓
Agreement → collect email → book Calendly → confirmation
     ↓
/webhook/status → update DB + log to Sheets
```

**Retry Logic:**
- Attempt 1: Call immediately
- Attempt 2: 48 hours after attempt 1 (if no answer/busy)
- Attempt 3: 48 hours after attempt 2 — leaves voicemail if machine detected
- After 3 attempts: status set to `email-followup`

---

## 8. Manual Call Trigger

To call a specific lead immediately (bypasses scheduler):

```bash
# By lead ID
curl -X POST https://your-app.up.railway.app/api/calls/initiate \
  -H "Content-Type: application/json" \
  -d '{"leadId": 42}'

# New lead
curl -X POST https://your-app.up.railway.app/api/calls/initiate \
  -H "Content-Type: application/json" \
  -d '{
    "firstName": "Jean",
    "lastName": "Tremblay",
    "phone_number": "+15146661234",
    "companyName": "Clinique Tremblay",
    "email": "jean@tremblay.com"
  }'
```

---

---

## 9. Railway Deployment (One-Time Setup)

### Step 1 — Create Railway Project
1. Go to [railway.app](https://railway.app) → **New Project**
2. Click **Deploy from GitHub repo**
3. Connect to: `ship-it-north/catherine-agent-fyltrmedia`

### Step 2 — Set Environment Variables
In Railway → your service → **Variables**, add ALL variables from Section 5.
Most important to get Catherine calling:
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`
- `OPENAI_API_KEY` — get from [platform.openai.com](https://platform.openai.com)
- `CALENDLY_API_TOKEN`, `CALENDLY_EVENT_URL`
- `GOOGLE_SERVICE_ACCOUNT_JSON` (see Section 6)
- `WEBHOOK_BASE_URL` — set AFTER deploying (copy from Railway domain)

### Step 3 — Get Your Railway Domain
After first deploy:
1. Railway → your service → **Settings** → **Domains**
2. Copy the `*.up.railway.app` URL
3. Set `WEBHOOK_BASE_URL=https://your-app-name.up.railway.app`
4. Railway will auto-redeploy → Catherine auto-updates Twilio webhook on startup

### Step 4 — Upgrade Twilio Account (REQUIRED)
The current Twilio account is a **trial account** which can only call verified numbers.
To call any number (including +15144000751):
1. Log in at [console.twilio.com](https://console.twilio.com)
2. Click **Upgrade Account** in the top banner
3. Add a payment method (credit card)
4. Minimum top-up: $20

After upgrading, Catherine can call all phone numbers from your CSV.

---

## 10. Test Call Confirmation

A test call was successfully placed on 2026-05-24:
- **Call SID**: CA36094498fff9105e3aa956527d466f21
- **Status**: completed
- **Duration**: 39 seconds
- **Voice**: Amazon Polly — Chantal (French Canadian)
- **Script**: Catherine's opening in French + appointment offer
- **Note**: Called +15146199473 (Philip's verified number) — trial account requires upgrade to call +15144000751

---

*Catherine — Fyltr Media AI Voice Agent v1.0.0*
