/**
 * Email notifier over SMTP (works with Gmail/Google Workspace app passwords, Outlook, Zoho, SES …).
 * Gmail: SMTP_HOST=smtp.gmail.com, SMTP_PORT=465, SMTP_USER=you@gmail.com, SMTP_PASS=<16-char app password>.
 */
import nodemailer, { type Transporter } from "nodemailer";
import type { Notifier, OutboundMessage } from "../ports.js";

export interface EmailOptions {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  transport?: Transporter; // injectable for tests
}

export class EmailNotifier implements Notifier {
  readonly channel = "email" as const;
  private readonly t: Transporter;
  constructor(private readonly o: EmailOptions) {
    this.t = o.transport ?? nodemailer.createTransport({ host: o.host, port: o.port, secure: o.port === 465, auth: { user: o.user, pass: o.pass } });
  }

  async send(msg: OutboundMessage): Promise<void> {
    await this.t.sendMail({
      from: this.o.from,
      to: msg.to,
      subject: msg.subject ?? "The Liwan",
      text: msg.text.replace(/\*([^*\n]+)\*/g, "$1"),
      html: msg.html ?? textToEmailHtml(msg.text),
    });
  }
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const linkify = (s: string) => s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#8a5a1f">$1</a>');

/**
 * Turn a rendered report (WhatsApp-style text: *Heading*, "• item", plain lines) into a clean, email-safe HTML page
 * with inline styles. Arabic text is laid out right-to-left.
 */
export function textToEmailHtml(text: string, opts: { dashboardUrl?: string } = {}): string {
  const rtl = /[؀-ۿ]/.test(text.split("\n")[0] ?? "");
  const lines = text.split("\n");
  const title = lines.shift() ?? "";
  let body = "";
  let inList = false;
  const closeList = () => { if (inList) { body += "</ul>"; inList = false; } };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { closeList(); continue; }
    const heading = line.match(/^\*([^*]+)\*(.*)$/);
    if (heading) {
      closeList();
      body += `<h3 style="margin:20px 0 6px;font-size:15px;color:#5b3a24">${esc(heading[1])}<span style="font-weight:400;color:#7a6a5d">${esc(heading[2])}</span></h3>`;
    } else if (/^[•\-] /.test(line)) {
      if (!inList) { body += `<ul style="margin:0;padding-${rtl ? "right" : "left"}:18px">`; inList = true; }
      body += `<li style="margin:3px 0">${linkify(esc(line.slice(2)))}</li>`;
    } else {
      closeList();
      body += `<p style="margin:3px 0">${linkify(esc(line))}</p>`;
    }
  }
  closeList();
  const button = opts.dashboardUrl
    ? `<p style="margin:22px 0 0"><a href="${esc(opts.dashboardUrl)}" style="background:#5b3a24;color:#fffdf9;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600">${rtl ? "افتح لوحة التحكم" : "Open dashboard"}</a></p>`
    : "";
  return `<!doctype html><html lang="${rtl ? "ar" : "en"}" dir="${rtl ? "rtl" : "ltr"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f7f2ea;padding:16px;font:15px/1.5 -apple-system,'Segoe UI',Tahoma,Arial,sans-serif;color:#2b1d14">
<div style="max-width:600px;margin:0 auto;background:#fffdf9;border:1px solid #e8dccb;border-radius:14px;padding:20px">
<div style="font-size:13px;color:#b8862b;font-weight:700;letter-spacing:.4px">THE LIWAN · الليوان</div>
<h2 style="margin:4px 0 8px;font-size:19px">${esc(title.replace(/^[^\p{L}]+/u, ""))}</h2>
${body}${button}
</div>
<p style="text-align:center;color:#7a6a5d;font-size:12px">The Liwan Ops · Arcades, Abu Dhabi</p>
</body></html>`;
}
