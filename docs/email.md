# Email setup (about 5 minutes)

The 9pm daily summary and the Sunday weekly report are emailed to every owner who has an email address on record.
Arabic-speaking owners (`--locale ar`) get the Arabic version, laid out right-to-left. WhatsApp can be added later
and runs alongside email.

## With Gmail or Google Workspace

1. Use the Google account that will send the reports. A dedicated one such as `liwan.reports@gmail.com` is tidiest.
2. Turn on **2-Step Verification**: Google Account → Security.
3. Create an **App Password**: Google Account → Security → App passwords → name it "Liwan Ops". Copy the 16 characters.
4. In `.env`:

   ```
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=465
   SMTP_USER=liwan.reports@gmail.com
   SMTP_PASS=abcdabcdabcdabcd
   EMAIL_FROM="The Liwan <liwan.reports@gmail.com>"
   ```

5. Add each owner's email and language:

   ```bash
   npm run liwan -- owner --name "Partner 1" --rename "Khalid" --email khalid@example.com --locale en
   npm run liwan -- owner --name "Partner 2" --email partner2@example.com --locale ar
   npm run liwan -- owners
   ```

6. Test:

   ```bash
   npm run liwan -- test-email you@example.com
   npm run liwan -- summary --send --no-agent
   ```

Other providers (Outlook/Microsoft 365, Zoho, Amazon SES, Brevo) work the same way: use their SMTP host, port and
credentials.

Every send, and any error, is logged in the `notifications` table. If the app password is wrong, you'll see
`Invalid login` there and on the console.

## Preview without sending

```bash
npm run liwan -- summary --preview-email preview.html            # open in a browser
npm run liwan -- summary --lang ar --preview-email preview-ar.html
```
