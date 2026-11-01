/** @jsxImportSource hono/jsx */
/**
 * Mobile-first owner dashboard. Server-rendered (no client JS), EN/AR with RTL.
 * Phase 2 adds /approvals (approve or reject purchase orders and payments) and /pnl.
 */
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { config } from "../config.js";
import type { DB } from "../db/index.js";
import { menuMargins, itemPerformance, peakHours, salesSummary, latestBusinessDate } from "../domain/sales.js";
import { stockStatus, expiryAlerts, shortfalls, type StockRow } from "../domain/inventory.js";
import { pnlRange } from "../domain/finance.js";
import { formatAed } from "../domain/money.js";
import { addDays, todayInDubai } from "../domain/periods.js";
import { buildDailyReport } from "../reports/reports.js";
import { readSession, signSession, verifyPin } from "./auth.js";
import { L, Page, type Dict, type Lang } from "./layout.js";

type Env = { Variables: { ownerId: number; ownerName: string; lang: Lang } };

const aed0 = (f: number) => formatAed(f, { decimals: 0 });
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const isDate = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
const qty = (q: number, unit: string) => (unit === "pc" ? `${Math.round(q)}` : q >= 1000 || q <= -1000 ? `${(q / 1000).toFixed(2)} ${unit === "g" ? "kg" : "L"}` : `${Math.round(q * 10) / 10} ${unit}`);

function Delta({ now, before, t }: { now: number; before: number; t: Dict }) {
  if (!before) return <span class="d">—</span>;
  const ch = (now - before) / before;
  return <span class={`d ${ch >= 0 ? "up" : "down"}`}>{`${ch >= 0 ? "▲" : "▼"} ${Math.abs(ch * 100).toFixed(0)}% ${t.vsLw}`}</span>;
}

function StateBadge({ s, t }: { s: StockRow["state"]; t: Dict }) {
  return <span class={`badge b-${s}`}>{t[s]}</span>;
}

export function createApp(db: DB) {
  const app = new Hono<Env>();

  app.get("/health", (c) => c.json({ ok: true, latestSalesDate: latestBusinessDate(db) }));

  app.use("*", async (c, next) => {
    const lang = (getCookie(c, "lang") === "ar" ? "ar" : "en") as Lang;
    c.set("lang", lang);
    const path = new URL(c.req.url).pathname;
    if (path === "/login" || path.startsWith("/lang/")) return next();
    const id = readSession(getCookie(c, "sid"), config.sessionSecret);
    const owner = id ? (db.prepare("SELECT id, name FROM owners WHERE id = ?").get(id) as any) : null;
    if (!owner) return c.redirect("/login");
    c.set("ownerId", owner.id);
    c.set("ownerName", owner.name);
    return next();
  });

  app.get("/lang/:l", (c) => {
    setCookie(c, "lang", c.req.param("l") === "ar" ? "ar" : "en", { path: "/", maxAge: 31_536_000, sameSite: "Lax" });
    return c.redirect(c.req.header("referer") ?? "/");
  });

  app.get("/login", (c) => {
    const lang = c.get("lang");
    const t = L[lang];
    const owners = db.prepare("SELECT name, pin_hash IS NOT NULL AS has_pin FROM owners ORDER BY id").all() as any[];
    const anyPin = owners.some((o) => o.has_pin);
    return c.html(
      <Page title={t.login} lang={lang}>
        <form class="login card" method="post" action="/login">
          <h1>The Liwan · الليوان</h1>
          {c.req.query("e") && <p class="err">{t.wrongPin}</p>}
          {!anyPin && <p class="sub">{t.noPins} <code>npm run liwan -- owner --name "Partner 1" --pin 1234</code></p>}
          <label for="owner">{t.owner}</label>
          <select id="owner" name="owner">{owners.map((o) => <option value={o.name}>{o.name}</option>)}</select>
          <label for="pin">{t.pin}</label>
          <input id="pin" name="pin" type="password" inputmode="numeric" autocomplete="current-password" required />
          <button type="submit">{t.login}</button>
          <p class="sub" style="text-align:center;margin-top:14px"><a href={`/lang/${lang === "ar" ? "en" : "ar"}`}>{lang === "ar" ? "English" : "العربية"}</a></p>
        </form>
      </Page>,
    );
  });

  app.post("/login", async (c) => {
    const body = await c.req.parseBody();
    const o = db.prepare("SELECT id, pin_hash FROM owners WHERE name = ?").get(String(body.owner ?? "")) as any;
    if (!o || !verifyPin(String(body.pin ?? ""), o.pin_hash)) return c.redirect("/login?e=1");
    setCookie(c, "sid", signSession(o.id, config.sessionSecret), {
      path: "/", httpOnly: true, sameSite: "Lax", secure: config.dashboardUrl.startsWith("https"), maxAge: 30 * 86_400,
    });
    return c.redirect("/");
  });

  app.get("/logout", (c) => {
    deleteCookie(c, "sid", { path: "/" });
    return c.redirect("/login");
  });

  // ------------------------------------------------------------- Today
  app.get("/", (c) => {
    const lang = c.get("lang");
    const t = L[lang];
    const date = isDate(c.req.query("date")) ? c.req.query("date")! : latestBusinessDate(db) ?? todayInDubai();
    const r = buildDailyReport(db, date);
    const name = (i: { nameEn: string; nameAr: string }) => (lang === "ar" ? i.nameAr : i.nameEn);
    const last = db.prepare("SELECT file_name, imported_at FROM sales_imports ORDER BY id DESC LIMIT 1").get() as any;
    const p = r.payback;
    return c.html(
      <Page title={t.today} lang={lang} active="today" owner={c.get("ownerName")}>
        <form class="datepick" method="get" action="/">
          <input type="date" name="date" value={date} aria-label="date" />
          <button type="submit">↻</button>
        </form>
        {r.sales.orders === 0 && <div class="card">{t.noData}</div>}
        <div class="grid">
          <div class="card kpi"><div class="l">{t.net}</div><div class="v">{aed0(r.sales.netExVatFils)}</div><Delta now={r.sales.netExVatFils} before={r.sameDayLastWeek.netExVatFils} t={t} /></div>
          <div class="card kpi"><div class="l">{t.orders}</div><div class="v">{r.sales.orders}</div><Delta now={r.sales.orders} before={r.sameDayLastWeek.orders} t={t} /></div>
          <div class="card kpi"><div class="l">{t.avgTicket}</div><div class="v">{formatAed(r.sales.avgTicketInclVatFils)}</div></div>
          <div class="card kpi"><div class="l">{t.gm}</div><div class="v">{pct(r.pnl.grossMarginPct)}</div></div>
          <div class="card kpi"><div class="l">{t.rent}</div><div class="v">{aed0(r.pnl.rentFils)}</div></div>
          <div class="card kpi"><div class="l">{t.op}</div><div class="v">{aed0(r.pnl.operatingProfitFils)}</div></div>
        </div>

        <div class="card">
          <h2>{t.payback}</h2>
          <div class="progress" role="progressbar" aria-valuenow={Math.round(p.pctRecovered * 100)} aria-valuemin={0} aria-valuemax={100}>
            <i style={`width:${Math.min(100, p.pctRecovered * 100).toFixed(1)}%`} />
          </div>
          <p class="sub" style="margin:8px 0 0">
            {`${aed0(p.recoveredFils)} ${t.recovered} ${aed0(p.capitalFils)} (${pct(p.pctRecovered)}) · ${t.projected}: ${p.projectedPaybackDate ?? "—"} · ${t.target}: ${p.targetDate} · `}
            <b class={p.onTrack ? "up" : "down"}>{p.onTrack ? t.onTrack : t.behind}</b>
          </p>
        </div>

        <div class="two">
          <div class="card">
            <h2>{t.alerts}</h2>
            <ul class="alerts">
              {r.lowStock.map((s) => <li><StateBadge s={s.state} t={t} /> {name(s)} — {qty(Math.max(0, s.onHand), s.unit)}{s.daysOfCover !== null ? ` · ${s.daysOfCover} ${t.cover.toLowerCase()}` : ""}</li>)}
              {r.expiring.map((e) => <li><span class="badge b-out">{e.expired ? t.expired : t.expiring}</span> {name(e)} — {qty(e.qtyRemaining, e.unit)} · {e.expiresAt}</li>)}
              {r.shortfalls.map((s) => <li><span class="badge b-out">!</span> {t.shortfall}: {name(s)} {qty(s.qty, s.unit)}</li>)}
              {r.lowStock.length + r.expiring.length + r.shortfalls.length === 0 && <li>{t.noAlerts}</li>}
            </ul>
          </div>
          <div class="card">
            <h2>{t.best}</h2>
            <table><tbody>{r.best.map((i) => <tr><td>{name(i)}</td><td class="n">{i.qty}</td><td class="n">{aed0(i.netExVatFils)}</td></tr>)}</tbody></table>
            <h2 style="margin-top:14px">{t.worst}</h2>
            <table><tbody>{r.worst.map((i) => <tr><td>{name(i)}</td><td class="n">{i.qty}</td><td class="n">{aed0(i.netExVatFils)}</td></tr>)}</tbody></table>
          </div>
        </div>

        <div class="card">
          <h2>{`${t.mtd} · ${r.monthToDate.start} → ${r.monthToDate.end}`}</h2>
          <table><tbody>
            <tr><td>{t.net}</td><td class="n">{aed0(r.monthToDate.totals.netSalesFils)}</td></tr>
            <tr><td>{t.cogs}</td><td class="n">{aed0(r.monthToDate.totals.cogsFils)}</td></tr>
            <tr><td>{t.waste}</td><td class="n">{aed0(r.monthToDate.totals.wasteFils)}</td></tr>
            <tr><td>{t.rent}</td><td class="n">{aed0(r.monthToDate.totals.rentFils)}</td></tr>
            <tr><td>{t.fixed}</td><td class="n">{aed0(r.monthToDate.totals.fixedCostsFils)}</td></tr>
            <tr><td><b>{t.op}</b></td><td class="n"><b>{aed0(r.monthToDate.totals.operatingProfitFils)}</b></td></tr>
            <tr><td>{t.vat}</td><td class="n">{aed0(r.monthToDate.totals.vatCollectedFils)}</td></tr>
          </tbody></table>
        </div>
        {last && <p class="sub">{`${t.lastImport}: ${last.file_name} · ${last.imported_at.slice(0, 16).replace("T", " ")}`}</p>}
      </Page>,
    );
  });

  // ------------------------------------------------------------- Stock
  app.get("/stock", (c) => {
    const lang = c.get("lang");
    const t = L[lang];
    const date = latestBusinessDate(db) ?? todayInDubai();
    const rows = stockStatus(db, date).sort((a, b) => ["out", "low", "ok"].indexOf(a.state) - ["out", "low", "ok"].indexOf(b.state));
    const exp = expiryAlerts(db, date);
    const sf = shortfalls(db, addDays(date, -6), date);
    const total = rows.reduce((s, r) => s + r.valueFils, 0);
    const name = (i: { nameEn: string; nameAr: string }) => (lang === "ar" ? i.nameAr : i.nameEn);
    return c.html(
      <Page title={t.stock} lang={lang} active="stock" owner={c.get("ownerName")}>
        <h1>{t.stock}</h1>
        <div class="sub">{`${date} · ${t.value}: ${aed0(total)}`}</div>
        {(exp.length > 0 || sf.length > 0) && (
          <div class="card"><ul class="alerts">
            {exp.map((e) => <li><span class="badge b-out">{e.expired ? t.expired : t.expiring}</span> {name(e)} — {qty(e.qtyRemaining, e.unit)} · {e.expiresAt}</li>)}
            {sf.map((s) => <li><span class="badge b-out">!</span> {t.shortfall}: {name(s)} {qty(s.qty, s.unit)}</li>)}
          </ul></div>
        )}
        <div class="card">
          <table>
            <thead><tr><th>{t.ingredient}</th><th></th><th class="n">{t.onHand}</th><th class="n wide">{t.reorder}</th><th class="n">{t.cover}</th><th class="wide">{t.expiry}</th><th class="wide">{t.supplier}</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr>
                <td>{name(r)}</td>
                <td><StateBadge s={r.state} t={t} /></td>
                <td class="n">{qty(r.onHand, r.unit)}</td>
                <td class="n wide">{qty(r.reorderPoint, r.unit)}</td>
                <td class="n">{r.daysOfCover ?? "—"}</td>
                <td class="wide">{r.nextExpiry ?? "—"}</td>
                <td class="wide">{r.supplier ?? "—"}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </Page>,
    );
  });

  // ------------------------------------------------------------- Sales
  app.get("/sales", (c) => {
    const lang = c.get("lang");
    const t = L[lang];
    const to = isDate(c.req.query("to")) ? c.req.query("to")! : latestBusinessDate(db) ?? todayInDubai();
    const from = addDays(to, -6);
    const s = salesSummary(db, from, to);
    const items = itemPerformance(db, from, to);
    const hours = peakHours(db, from, to);
    const days = pnlRange(db, from, to).days;
    const margins = menuMargins(db);
    const maxH = Math.max(1, ...hours.map((h) => h.orders));
    const maxD = Math.max(1, ...days.map((d) => d.netSalesFils));
    const name = (i: { nameEn: string; nameAr: string }) => (lang === "ar" ? i.nameAr : i.nameEn);
    return c.html(
      <Page title={t.sales} lang={lang} active="sales" owner={c.get("ownerName")}>
        <h1>{t.sales} · {t.week}</h1>
        <form class="datepick" method="get" action="/sales">
          <span class="sub" style="margin:0">{from} →</span>
          <input type="date" name="to" value={to} aria-label="end date" />
          <button type="submit">↻</button>
        </form>
        <div class="grid">
          <div class="card kpi"><div class="l">{t.net}</div><div class="v">{aed0(s.netExVatFils)}</div></div>
          <div class="card kpi"><div class="l">{t.orders}</div><div class="v">{s.orders}</div></div>
          <div class="card kpi"><div class="l">{t.avgTicket}</div><div class="v">{formatAed(s.avgTicketInclVatFils)}</div></div>
          <div class="card kpi"><div class="l">{t.vat}</div><div class="v">{aed0(s.vatFils)}</div></div>
        </div>
        <div class="two">
          <div class="card">
            <h2>{t.daily}</h2>
            {days.map((d) => <div class="hbar"><span>{d.date.slice(5)}</span><span class="t" style={`width:${(d.netSalesFils / maxD) * 100}%`} /><span class="c">{Math.round(d.netSalesFils / 100)}</span></div>)}
          </div>
          <div class="card">
            <h2>{t.peak}</h2>
            {hours.map((h) => <div class="hbar"><span>{`${String(h.hour).padStart(2, "0")}:00`}</span><span class="t" style={`width:${(h.orders / maxH) * 100}%`} /><span class="c">{h.orders}</span></div>)}
          </div>
        </div>
        <div class="card">
          <table>
            <thead><tr><th>{t.item}</th><th class="n">{t.qty}</th><th class="n">{t.net}</th><th class="n">{t.margin}</th><th class="n wide">{t.share}</th></tr></thead>
            <tbody>{items.map((i) => <tr><td>{name(i)}</td><td class="n">{i.qty}</td><td class="n">{aed0(i.netExVatFils)}</td><td class="n">{pct(i.marginPct)}</td><td class="n wide">{pct(i.shareOfNet)}</td></tr>)}</tbody>
          </table>
        </div>
        <div class="card">
          <h2>{t.menuMargins}</h2>
          <table>
            <thead><tr><th>{t.item}</th><th class="n">{t.price}</th><th class="n">{t.cost}</th><th class="n">{t.margin}</th></tr></thead>
            <tbody>{margins.map((m) => <tr><td>{name(m)}</td><td class="n">{formatAed(m.priceInclVatFils)}</td><td class="n">{formatAed(m.recipeCostFils)}</td><td class="n">{pct(m.marginPct)}</td></tr>)}</tbody>
          </table>
        </div>
      </Page>,
    );
  });

  return app;
}
