# Running The Liwan Ops on a computer at the café or at home

The computer must be **on and awake at 21:00 Dubai time** (daily summary) and on **Sunday at 21:05**
(weekly report). A small always-on machine is ideal, e.g. a Mac mini, an old laptop with the lid open, or a mini PC.

## 1. Install (once)

1. Install **Node.js 22 LTS** from https://nodejs.org (the "LTS" button).
2. Download the code: on GitHub open the `claude/liwan-coffee-agents-n9jcjf` branch → **Code → Download ZIP**,
   and unzip it somewhere permanent, e.g. `Documents/liwan-ops`. (Or `git clone` it.)
3. Open a terminal in that folder (Mac: Terminal; Windows: right-click the folder → *Open in Terminal*) and run:

   ```bash
   npm install
   npm run setup
   ```

   Setup asks for each owner's name, email, report language (en/ar) and dashboard PIN, the Gmail account and
   App Password that sends the reports (see [email.md](email.md)), optionally an Anthropic API key, and today's
   opening stock. It finishes by sending a test email.

## 2. Start it

- **Mac:** double-click `scripts/start-liwan.command`. The first time, macOS may ask: right-click → Open.
- **Windows:** double-click `scripts/start-liwan.bat`.
- Or in a terminal: `npm start`

Leave the window open. Dashboard: http://localhost:8787

## 3. Start automatically and stay awake

**Mac**
- System Settings → General → Login Items → **+** → add `scripts/start-liwan.command`.
- System Settings → Energy (or Battery → Options) → turn on *Prevent automatic sleeping when the display is off*
  and *Start up automatically after a power failure*.

**Windows**
- Press Win+R, type `shell:startup`, Enter, and put a **shortcut** to `scripts\start-liwan.bat` in that folder.
- Settings → System → Power → Screen and sleep → set **Sleep: Never** when plugged in.

## 4. Every day: get the sales in

Before 20:55, export the Foodics **order items** report as CSV and save it into the `data/inbox/` folder.
It's imported automatically at 20:55 and the summary goes out at 21:00. You can also import by hand:

```bash
npm run liwan -- import ~/Downloads/foodics-export.csv
```

Log deliveries, waste and counts as they happen:

```bash
npm run liwan -- receive milk_fresh 10        # 10 packs (2L each) from Biru
npm run liwan -- waste milk_fresh 500 --note "spilled"
npm run liwan -- count beans_espresso 7400    # shelf count in grams
```

## 5. Purchase orders and approvals

When stock runs low, you'll get an email: "purchase order(s) to approve".

1. Open the dashboard → **Approvals**.
2. Check the items, then tap **Approve** or **Reject**. Any one owner can decide.
3. When the delivery arrives, tap **Delivery arrived** so stock and VAT are booked.

Add supplier emails so approved orders go out automatically. Re-run `npm run setup` (answer **No** to wiping the
data), or:

```bash
npm run liwan -- supplier --name Biru --email orders@biru.ae
```

For a better cash forecast, record your bank + till balance now and then:

```bash
npm run liwan -- cash --balance 25000
```

## 6. Staff, rota and payroll

Add your team once:

```bash
npm run liwan -- staff add --name "Aisha" --basic 4000 --housing 2000 --transport 500 --rest-day Friday --start 2026-10-08 --iban AE07…
npm run liwan -- rota --generate
```

Or re-run `npm run setup`, which now asks about staff.

- **Every Thursday** next week's rota is filled in automatically, and you get an email if a shift is uncovered.
- **On the Staff page**, change a shift to *sick*, *absent* or *leave* when it happens. Payroll uses this.
- **On the 6th** you get "payroll to approve". Check it under Approvals, approve it, then download the payment sheet
  from the Staff page for your bank or WPS agent. After the transfer on the 8th, tap **Mark as paid**.

The payment sheets in `data/payroll/` contain salaries and IBANs. Keep them private; they are never uploaded to GitHub.

## 7. Open the dashboard on your phone

- **Same Wi-Fi:** find the computer's local IP (Mac: System Settings → Wi-Fi → Details; Windows: `ipconfig`) and
  open `http://<that-ip>:8787` on your phone.
- **From anywhere:** install **Tailscale** (free) on the computer and on each owner's phone, then open
  `http://<computer-name>:8787`. Nothing is exposed to the public internet. If you do this, set `DASHBOARD_URL` in
  `.env` to that address so the email buttons open it.

## 8. Updating to a new version

In Terminal: press `Ctrl + C` to stop the app, then:

```bash
cd ~/Documents/liwan-ops
git pull
npm install
caffeinate -i npm start
```

Your data is kept. New database columns are added automatically.

## Backups

All the data is in `data/liwan.db`. Copy that file somewhere safe, such as iCloud/OneDrive/Google Drive, once a
week, and keep `.env` private (it holds the email password).
