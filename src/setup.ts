/**
 * Guided first-time setup on the computer that will run The Liwan Ops:
 *   npm run setup
 * Asks for owners (names, emails, language, dashboard PINs), email (SMTP) settings and the optional API key,
 * writes .env, creates a clean database (menu, recipes, suppliers — no simulated sales), optionally records
 * opening stock, and sends a test email.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createInterface, type Interface } from "node:readline";
import { stdin, stdout } from "node:process";
import { openDb, type DB } from "./db/index.js";
import { recordCount } from "./domain/inventory.js";
import { EmailNotifier } from "./integrations/notifiers/email.js";
import { seedReferenceData } from "./seed/seed.js";
import { setOwnerPin } from "./web/auth.js";
import { addStaff, generateWeekRota, listStaff, parseRestDay, weekStartOf } from "./domain/staff.js";
import { todayInDubai } from "./domain/periods.js";

/** Merge key/values into a .env file's text, keeping comments, order and unrelated keys. */
export function mergeEnv(existing: string, values: Record<string, string>): string {
  const lines = existing ? existing.split(/\r?\n/) : [];
  const done = new Set<string>();
  const quote = (v: string) => (/[\s#"'$]/.test(v) ? `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : v);
  const out = lines.map((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (m && m[1] in values) {
      done.add(m[1]);
      return `${m[1]}=${quote(values[m[1]])}`;
    }
    return line;
  });
  while (out.length && out[out.length - 1] === "") out.pop();
  for (const [k, v] of Object.entries(values)) if (!done.has(k)) out.push(`${k}=${quote(v)}`);
  return out.join("\n") + "\n";
}

export const isEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

class Prompt {
  private rl: Interface;
  private muted = false;
  private lines: string[] = [];
  private waiting: ((l: string | null) => void) | null = null;
  private ended = false;
  constructor() {
    this.rl = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY ?? false });
    // Queue every line so piped/pasted answers are never dropped between questions.
    this.rl.on("line", (l) => (this.waiting ? (this.waiting(l), (this.waiting = null)) : this.lines.push(l)));
    this.rl.on("close", () => { this.ended = true; this.waiting?.(null); });
    const rlAny = this.rl as any;
    const write = rlAny._writeToOutput?.bind(rlAny);
    if (write) rlAny._writeToOutput = (s: string) => (this.muted && !s.includes("\n") && !s.startsWith("\x1b") ? write(s ? "*" : "") : write(s));
  }
  private nextLine(): Promise<string> {
    if (this.lines.length) return Promise.resolve(this.lines.shift()!);
    if (this.ended) return Promise.reject(new Error("Setup cancelled (input closed)."));
    return new Promise((res, rej) => (this.waiting = (l) => (l === null ? rej(new Error("Setup cancelled (input closed).")) : res(l))));
  }
  async ask(q: string, def = "", check?: (v: string) => string | null): Promise<string> {
    for (;;) {
      stdout.write(`${q}${def ? ` [${def}]` : ""}: `);
      const a = (await this.nextLine()).trim() || def;
      if (!stdin.isTTY) stdout.write(this.muted ? "\n" : `${a}\n`);
      const err = check?.(a) ?? null;
      if (!err) return a;
      console.log(`  ✗ ${err}`);
    }
  }
  async secret(q: string, keep = false): Promise<string> {
    this.muted = true;
    try {
      return await this.ask(`${q}${keep ? " (Enter to keep current)" : ""}`);
    } finally {
      this.muted = false;
    }
  }
  async yes(q: string, def: boolean): Promise<boolean> {
    const a = (await this.ask(`${q} (${def ? "Y/n" : "y/N"})`)).toLowerCase();
    return a === "" ? def : a.startsWith("y");
  }
  close() { this.rl.close(); }
}

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, "$1").replace(/\\"/g, '"');
  }
  return out;
}

const hasSimulatedData = (db: DB) =>
  (db.prepare("SELECT COUNT(*) n FROM sales_imports WHERE file_name LIKE 'simulated-%'").get() as any).n > 0;

export async function runSetup(envPath = ".env"): Promise<void> {
  const p = new Prompt();
  const env = readEnvFile(envPath);
  const dbPath = env.LIWAN_DB || "data/liwan.db";
  try {
    console.log("\n☕ The Liwan Ops · first-time setup\n");

    // ---------------------------------------------------------------- database
    let fresh = !existsSync(dbPath);
    if (!fresh) {
      const probe = openDb(dbPath);
      const sim = hasSimulatedData(probe);
      probe.close();
      const wipe = await p.yes(
        sim ? `${dbPath} contains SIMULATED demo sales. Wipe it and start clean?` : `${dbPath} already exists. Wipe it and start clean? (No keeps your data)`,
        sim,
      );
      if (wipe) {
        for (const s of ["", "-wal", "-shm"]) rmSync(dbPath + s, { force: true });
        fresh = true;
      }
    }
    const db = openDb(dbPath);
    if (fresh) {
      seedReferenceData(db);
      console.log("✓ Database created with the menu, recipes, suppliers and fixed costs (edit prices later in src/seed/data.ts).\n");
    }

    // ---------------------------------------------------------------- owners
    console.log("Owners: everyone listed gets the 9pm summary and the Sunday report. Leave the email empty to skip someone.\n");
    const owners = db.prepare("SELECT id, name, email, locale FROM owners ORDER BY id").all() as any[];
    for (const [i, o] of owners.entries()) {
      console.log(`Owner ${i + 1} of ${owners.length}`);
      const name = await p.ask("  Name", o.name, (v) => (v.length ? null : "Name is required"));
      const email = await p.ask("  Email", o.email ?? "", (v) => (v === "" || isEmail(v) ? null : "Not a valid email"));
      const locale = await p.ask("  Report language en/ar", o.locale, (v) => (v === "en" || v === "ar" ? null : "Type en or ar"));
      const pin = await p.ask("  Dashboard PIN, 4–8 digits (Enter to skip)", "", (v) => (v === "" || /^\d{4,8}$/.test(v) ? null : "4–8 digits"));
      db.prepare("UPDATE owners SET name = ?, email = ?, locale = ? WHERE id = ?").run(name, email || null, locale, o.id);
      if (pin) setOwnerPin(db, name, pin);
      console.log("");
    }

    // ---------------------------------------------------------------- suppliers
    console.log("Suppliers: approved purchase orders are emailed here. Leave empty to send orders yourself (WhatsApp/phone).\n");
    for (const sp of db.prepare("SELECT id, name, email FROM suppliers ORDER BY name").all() as any[]) {
      const e = await p.ask(`  ${sp.name} orders email`, sp.email ?? "", (v) => (v === "" || isEmail(v) ? null : "Not a valid email"));
      db.prepare("UPDATE suppliers SET email = ? WHERE id = ?").run(e || null, sp.id);
    }
    console.log("");

    // ---------------------------------------------------------------- staff
    const haveStaff = listStaff(db).length;
    if (await p.yes(`Add staff now${haveStaff ? ` (${haveStaff} on record)` : ""}? Needed for the rota and payroll.`, haveStaff === 0)) {
      const dateOk = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? null : "Use YYYY-MM-DD");
      const aedOk = (v: string) => (v === "" || Number(v) >= 0 ? null : "A number in AED");
      for (;;) {
        console.log("");
        const name = await p.ask("  Staff name (Enter when done)");
        if (!name) break;
        if (listStaff(db).some((x) => x.name.toLowerCase() === name.toLowerCase())) { console.log("  ✗ Already on record"); continue; }
        const role = await p.ask("  Role", "barista");
        const basic = await p.ask("  Monthly basic salary, AED", "", (v) => (Number(v) > 0 ? null : "Required"));
        const housing = await p.ask("  Housing allowance, AED/month", "0", aedOk);
        const transport = await p.ask("  Transport allowance, AED/month", "0", aedOk);
        const other = await p.ask("  Other allowances, AED/month", "0", aedOk);
        const rest = await p.ask("  Weekly rest day", "Friday", (v) => { try { parseRestDay(v); return null; } catch (e) { return (e as Error).message; } });
        const maxH = await p.ask("  Max hours per week", role.toLowerCase().includes("part") ? "24" : "48", (v) => (Number(v) > 0 ? null : "A number"));
        const start = await p.ask("  Start date", "2026-10-08", dateOk);
        const iban = await p.ask("  IBAN for salary (Enter to skip)", "");
        const fils = (v: string) => Math.round(Number(v || 0) * 100);
        addStaff(db, { name, role, basicFils: fils(basic), housingFils: fils(housing), transportFils: fils(transport), otherFils: fils(other),
          restDay: parseRestDay(rest), maxWeeklyHours: Number(maxH), startDate: start, iban: iban || null });
        console.log(`  ✓ ${name} added`);
      }
      if (listStaff(db).length) {
        const ws = weekStartOf(todayInDubai());
        const r = generateWeekRota(db, ws);
        console.log(`✓ Rota for the week of ${ws}: ${r.created} shift(s)${r.gaps.length ? `, ${r.gaps.length} uncovered — see the Staff page` : ", all covered"}.`);
      }
    }
    console.log("");

    // ---------------------------------------------------------------- email
    console.log("Email: the reports are sent from a Gmail account using an App Password (see docs/email.md).\n");
    const host = await p.ask("SMTP server", env.SMTP_HOST || "smtp.gmail.com");
    const port = await p.ask("SMTP port", env.SMTP_PORT || "465", (v) => (/^\d+$/.test(v) ? null : "Number"));
    const user = await p.ask("Sending email address", env.SMTP_USER || "", (v) => (isEmail(v) ? null : "Not a valid email"));
    let pass = (await p.secret("App Password (16 characters, spaces are fine)", Boolean(env.SMTP_PASS))).replace(/\s+/g, "");
    if (!pass) pass = env.SMTP_PASS ?? "";

    // ---------------------------------------------------------------- agents
    console.log("\nAI insights (optional): an Anthropic API key adds 'Insights & actions' to each report and enables `ask`.");
    let apiKey = await p.secret("ANTHROPIC_API_KEY (Enter to skip)", Boolean(env.ANTHROPIC_API_KEY));
    if (!apiKey) apiKey = env.ANTHROPIC_API_KEY ?? "";

    const values: Record<string, string> = {
      SMTP_HOST: host,
      SMTP_PORT: port,
      SMTP_USER: user,
      SMTP_PASS: pass,
      EMAIL_FROM: `The Liwan <${user}>`,
      SESSION_SECRET: env.SESSION_SECRET && env.SESSION_SECRET !== "dev-only-change-me" ? env.SESSION_SECRET : randomBytes(32).toString("hex"),
      DASHBOARD_URL: env.DASHBOARD_URL || "http://localhost:8787",
      LIWAN_DB: dbPath,
    };
    if (apiKey) values.ANTHROPIC_API_KEY = apiKey;
    writeFileSync(envPath, mergeEnv(existsSync(envPath) ? readFileSync(envPath, "utf8") : "", values));
    console.log(`\n✓ Saved settings to ${envPath} (keep this file private).`);

    // ---------------------------------------------------------------- opening stock
    if (fresh && (await p.yes("\nEnter today's opening stock now? (You can also do it later with `count`)", false))) {
      console.log("Type what you have on the shelf. Enter skips an item.");
      const at = new Date().toISOString().slice(0, 19);
      for (const ing of db.prepare("SELECT code, name_en, unit FROM ingredients ORDER BY name_en").all() as any[]) {
        const unitHint = ing.unit === "g" ? "grams" : ing.unit === "ml" ? "ml" : "pieces";
        const v = await p.ask(`  ${ing.name_en} (${unitHint})`, "", (x) => (x === "" || Number(x) >= 0 ? null : "A number"));
        if (v !== "") recordCount(db, ing.code, Number(v), at);
      }
      console.log("✓ Opening stock recorded.");
    }

    // ---------------------------------------------------------------- test email
    const first = db.prepare("SELECT name, email FROM owners WHERE email IS NOT NULL ORDER BY id LIMIT 1").get() as any;
    if (first && pass && (await p.yes(`\nSend a test email to ${first.email}?`, true))) {
      try {
        await new EmailNotifier({ host, port: Number(port), user, pass, from: values.EMAIL_FROM }).send({
          to: first.email,
          subject: "The Liwan · setup complete",
          text: `☕ The Liwan · setup complete\n\nHi ${first.name}, the 9pm daily summary and the Sunday weekly report will arrive here.\n${values.DASHBOARD_URL}`,
        });
        console.log("✓ Test email sent. Check the inbox (and spam the first time).");
      } catch (e) {
        console.log(`✗ Email failed: ${(e as Error).message}\n  Check the address and App Password, then run: npm run setup`);
      }
    }
    db.close();

    console.log(`
All set. Next:
  npm start                      start the dashboard + 9pm / Sunday schedule (keep this computer on)
  open ${values.DASHBOARD_URL}
  Each day: export the Foodics order-items CSV into data/inbox/ before 20:55, or run
  npm run liwan -- import <file.csv>
To start automatically when the computer turns on, see docs/run-on-a-computer.md.
`);
  } finally {
    p.close();
  }
}
