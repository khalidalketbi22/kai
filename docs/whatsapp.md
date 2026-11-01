# WhatsApp setup (Meta WhatsApp Cloud API)

The 9pm summary is a *business-initiated* message, so WhatsApp requires a **pre-approved template**. Free-form
text is only allowed within 24 hours of an owner messaging the business number. The system therefore sends:

- **template mode (default):** the approved template with short single-line parameters, plus a link to the full
  report on the dashboard.
- **text mode:** the full summary as text (`WHATSAPP_MODE=text`). Use it only if owners message the number daily.

## 1. One-time Meta setup

1. Create a Meta Business account and verify the business (trade licence).
2. In developers.facebook.com create an app → add **WhatsApp** → add a phone number that is not on any personal
   WhatsApp account.
3. Create a **System User** with a permanent token that has `whatsapp_business_messaging`.
4. Put the token and the *Phone number ID* in `.env` as `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID`.
5. Add each owner's number: `npm run liwan -- owner --name "Partner 1" --phone +9715XXXXXXXX --locale en`

## 2. Templates to submit (category: Utility)

**`liwan_daily_summary`** (language: English)

```
☕ The Liwan daily summary for {{1}}
Net sales: {{2}} · Orders: {{3}} · Avg ticket: {{4}}
Gross margin: {{5}} · Operating profit: {{6}}
Stock: {{7}}
Payback: {{8}}
Full report: {{9}}
```

**`liwan_weekly_report`** (language: English)

```
📊 The Liwan weekly report {{1}}
Net sales: {{2}} · Orders: {{3}}
Operating profit: {{4}}
Payback: {{5}}
Full report: {{6}}
```

You can submit Arabic versions under the same names with language `ar`. Set `WHATSAPP_TEMPLATE_LANG=ar`, or later
choose the language per owner.

## 3. Test

```bash
npm run liwan -- summary --send --no-agent
```

Each send is logged in the `notifications` table, including any error returned by the API.

## Phase 2: approvals over WhatsApp

Purchase orders will arrive as an interactive message with **Approve / Reject** buttons. A webhook
(`/webhooks/whatsapp`) will accept replies only from owner numbers on record, and every decision is logged with the
owner and time in the `actions` table.
