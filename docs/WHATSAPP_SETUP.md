# WhatsApp (Meta Cloud API) — Complete Setup Guide

Follow these phases in order. Phases A–C are clicking around Meta's websites;
D–F connect it to Stellar Viking; G is the test run.

> Meta renames menus often. If a label doesn't match exactly, look for the
> closest equivalent — the concepts don't change.

---

## Phase A — Meta accounts & app (≈30 min + verification wait)

1. **Business portfolio** — go to https://business.facebook.com. If you don't
   have a Business Portfolio ("Meta Business Account"), create one with your
   company name and business email.

2. **Developer app** — go to https://developers.facebook.com → **My Apps** →
   **Create App**:
   - Use case / type: **Business**
   - Connect it to your Business Portfolio when asked.

3. **Add WhatsApp to the app** — on the app dashboard, find the **WhatsApp**
   product card → **Set up**. This automatically creates a
   **WhatsApp Business Account (WABA)** and gives you a **free test number**.

4. **Start Business Verification** (do this now — it runs in the background
   and takes days):
   - https://business.facebook.com/settings → **Security Center** →
     **Start verification**.
   - You'll upload proof of the business (registration document, utility
     bill, website, business email). 
   - You can build and test with the test number while you wait. Verification
     is what unlocks messaging real customers at scale.

---

## Phase B — Phone number

**For first tests: use the free test number.** It can only message up to 5
recipient numbers that you register manually: App dashboard → **WhatsApp** →
**API Setup** → in the "To" dropdown → **Manage phone number list** → add
your personal WhatsApp number, confirm the OTP it sends you.

**For production: add a real number.** App dashboard → WhatsApp → API Setup →
**Add phone number**:
- The number must NOT have an existing WhatsApp account (or you must delete
  that account first — the number gets permanently bound to the API and can
  no longer be used in the normal WhatsApp app).
- A dedicated SIM or virtual number works; you verify ownership via SMS or
  voice call OTP.
- Give it a display name matching your brand (Meta reviews it).

**Copy the Phone Number ID** — on the API Setup page, under the selected
number, there's a numeric **Phone number ID** (15-16 digits, NOT the phone
number itself). You'll paste this into the Stellar Viking dashboard in
Phase F.

---

## Phase C — Credentials (the env vars)

### 1. `WHATSAPP_ACCESS_TOKEN` — permanent System User token

The token shown on the API Setup page **expires in 24 hours** — never ship
it. Create a permanent one:

1. https://business.facebook.com/settings → **Users** → **System users** →
   **Add**. Name it e.g. `stellar-viking-bot`, role **Admin**.
2. Select the system user → **Add assets** → **Apps** → pick your app →
   enable **Manage app (full control)** → Save.
3. Click **Generate new token**:
   - App: your app
   - Token expiration: **Never**
   - Permissions: check **`whatsapp_business_messaging`** and
     **`whatsapp_business_management`**
4. Copy the token immediately (it's shown once) and store it safely.

### 2. `WHATSAPP_APP_SECRET`

App dashboard (developers.facebook.com) → **App settings** → **Basic** →
**App secret** → Show. This lets the server verify that webhook calls really
come from Meta (`X-Hub-Signature-256`).

### 3. `WHATSAPP_VERIFY_TOKEN`

Not from Meta — **you invent it**. Any random string. You'll type the same
string in two places: your server env, and Meta's webhook form (Phase D).

### 4. `WHATSAPP_FOLLOWUP_TEMPLATE` + `WHATSAPP_TEMPLATE_LANGUAGE`

Set after Phase E (template approval). The template **name** and **language
code** must match Meta exactly.

### Full production env checklist

| Variable | Value | Why |
|---|---|---|
| `ADMIN_USER` / `ADMIN_PASS` | your choice | Dashboard login. **Server refuses to start in production without them** |
| `ADMIN_SECRET` | long random string | Signs dashboard session tokens |
| `GEMINI_API_KEY` | https://aistudio.google.com/apikey | Chat AI, knowledge base, summaries, voice |
| `WHATSAPP_ACCESS_TOKEN` | Phase C.1 | Sending messages |
| `WHATSAPP_APP_SECRET` | Phase C.2 | Webhook authenticity |
| `WHATSAPP_VERIFY_TOKEN` | invented by you | Webhook handshake |
| `WHATSAPP_FOLLOWUP_TEMPLATE` | e.g. `followup_checkin` | Re-engagement after 24h window |
| `WHATSAPP_TEMPLATE_LANGUAGE` | `en` or `en_US` — match Meta exactly | Template sends fail on mismatch |
| `PUBLIC_URL` | `https://your-domain.com` | Twilio webhooks, links |
| `NODE_ENV` | `production` | Enables fail-closed auth |
| `DATA_DIR` | e.g. `/data` | Persistent storage path |
| Optional: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Twilio console | Voice calls only |
| Optional: `CHAT_MODEL` | default `gemini-2.0-flash` | Chat LLM override |

---

## Phase D — Webhook (connects Meta → your server)

**Deploy first.** The webhook URL must be publicly reachable over HTTPS with
a valid certificate, and the server must be running with `WHATSAPP_VERIFY_TOKEN`
set — the server answers Meta's handshake automatically.

1. App dashboard → **WhatsApp** → **Configuration** → **Webhook** → **Edit**:
   - **Callback URL**: `https://your-domain.com/webhook/whatsapp`
   - **Verify token**: the exact string from `WHATSAPP_VERIFY_TOKEN`
   - Click **Verify and save**.
   - Success on Meta's side = your server logged
     `✅ WhatsApp webhook verified by Meta`. Failure usually means: server
     not deployed yet, token mismatch, or HTTPS problem.
2. Still in Configuration → **Webhook fields** → **Manage** → subscribe to
   **`messages`** (that one field carries inbound messages AND delivery
   statuses).

> If inbound messages later show `signature mismatch — rejected` in the
> logs, your `WHATSAPP_APP_SECRET` is wrong.

---

## Phase E — Re-engagement template

Needed only for messages sent **after** a lead has been silent for 24+ hours
(scheduled follow-ups). Everything inside the 24h window is free-form and
doesn't need this.

1. Go to WhatsApp Manager: https://business.facebook.com/wa/manage →
   select your WABA → **Message templates** → **Create template**.
2. Settings:
   - **Category**: Utility (Meta may reclassify it as Marketing — accept it)
   - **Name**: `followup_checkin` — lowercase + underscores only, and must
     match `WHATSAPP_FOLLOWUP_TEMPLATE` exactly
   - **Language**: English (`en`) or English (US) (`en_US`) — whichever you
     pick, put the **same code** in `WHATSAPP_TEMPLATE_LANGUAGE`
3. **Body** (must have exactly these two variables):

   ```
   Hi {{1}}! You asked us to get back to you about {{2}} — is now a good
   time to continue?
   ```

   `{{1}}` = lead's name, `{{2}}` = topic (the app fills these automatically).
4. Provide sample values when asked (e.g. "Ali", "the Gulmarg package") —
   templates without samples get rejected more often.
5. Submit. Approval is usually minutes to 24 hours. Status appears in
   Message templates list; you'll also get an email.

---

## Phase F — Stellar Viking dashboard

1. Open `https://your-domain.com/admin.html`, log in with `ADMIN_USER`/`ADMIN_PASS`.
2. **Agents** → open (or create) your agent →
   - **WhatsApp Phone Number ID**: the numeric ID from Phase B
   - **WhatsApp Number**: the display number in international format, e.g.
     `+923001234567` (used to build wa.me links on the landing pages)
   - Fill company name, personality, greeting, etc.
   - **Status: active**
3. **Knowledge Base** → upload your brand documents (pricing, FAQs,
   policies) so the AI answers from facts.

---

## Phase G — Test sequence

1. From your personal WhatsApp (a registered test recipient if you're on the
   test number), message the business number: "Hi".
2. Expect: AI replies within a few seconds, introducing itself as the
   brand's assistant. Watch it live in **Dashboard → Chats**.
3. Ask a knowledge-base question → answer should reflect your documents.
4. Say "can you message me tomorrow at 5pm?" → check **Leads** tab: status
   `follow_up_scheduled`, and the follow-up job listed.
5. Say "I want someone to call me" → **callback alert** appears in Leads,
   lead status `callback_requested`.
6. In Chats, press **Take over** → AI stops replying, you can type as the
   team → **Hand back** to resume AI.
7. Send "STOP" → bot confirms once and goes permanently silent for that
   number (lead marked opted-out).
8. Landing page loop: open `https://your-domain.com/`, submit the demo form
   → tap **Continue on WhatsApp** → the pre-filled message starts the AI
   conversation with your form context attached.

---

## Limits & gotchas

- **Messaging limits**: while unverified you get ~250 business-initiated
  conversations/day (template sends). Replies inside the 24h window are
  unlimited. Verification + good quality rating scale you to 1K → 10K → 100K.
- **Quality rating** (WhatsApp Manager → phone number): drops if users block
  or report you. Keep opt-in clean and the STOP flow working (it is).
- **Token safety**: the system-user token never expires — treat it like a
  password. If leaked, revoke it in Business Settings → System users.
- **Template edits** require re-approval; renames are new templates.
- **Test number ≠ production**: switching to a real number changes the
  Phone Number ID — update the agent in the dashboard when you switch.
