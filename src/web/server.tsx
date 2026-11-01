/** @jsxImportSource hono/jsx */
/**
 * Mobile-first owner dashboard. Server-rendered (no client JS), EN/AR with RTL.
 * Phase 2 adds /approvals (approve or reject purchase orders and payments) and /pnl.
 */
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import { config } from "../config.js";
import type { DB } from "../db/index.js";
import { menuMargins, itemPerformance, peakHours, salesSummary, latestBusinessDate } from "../domain/sales.js";
import { stockStatus, expiryAlerts, shortfalls, type StockRow } from "../domain/inventory.js";
import { cashForecast, pnlBusinessMonthToDate, pnlRange, vatPosition } from "../domain/finance.js";
import { ApprovalError, approveAndExecute, decideAction, getAction, listActions, markPurchaseOrderSent, pendingCount, receivePurchaseOrder, type SupplierSender } from "../domain/approvals.js";
import { getPurchaseOrder, listPurchaseOrders, poNumber } from "../domain/purchasing.js";
import { formatAed } from "../domain/money.js";
import { addDays, todayInDubai } from "../domain/periods.js";
import { buildDailyReport } from "../reports/reports.js";
import { readSession, signSession, verifyPin } from "./auth.js";
import { L, Page, type Dict, type Lang } from "./layout.js";

type Env = { Variables: { ownerId: number; ownerName: string; lang: Lang; pending: number } };

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

export function createApp(db: DB, deps: { supplierSender?: SupplierSender } = {}) {
  const app = new Hono<Env>();
  app.use("*", csrf());

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
    c.set("pending", pendingCount(db));
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
      <Page title={t.today} lang={lang} active="today" owner={c.get("ownerName")} pending={c.get("pending")}>
        <form class="datepick" method="get" action="/">
          <input type="date" name="date" value={date} aria-label="date" />
          <button type="submit">↻</button>
        </form>
        {r.sales.orders === 0 && <div class="card">{t.noData}</div>}
        {r.pendingApprovals.length > 0 && (
          <a href="/approvals" style="text-decoration:none;color:inherit"><div class="card" style="border-color:var(--accent)">
            <b>{`🧾 ${t.pendingTitle}: ${r.pendingApprovals.length}`}</b>
            <div class="meta">{r.pendingApprovals.map((a) => a.summary.split(" — ")[0]).join(" · ")}</div>
          </div></a>
        )}
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
      <Page title={t.stock} lang={lang} active="stock" owner={c.get("ownerName")} pending={c.get("pending")}>
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
      <Page title={t.sales} lang={lang} active="sales" owner={c.get("ownerName")} pending={c.get("pending")}>
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

  // ------------------------------------------------------------- Approvals
  app.get("/approvals", (c) => {
    const lang = c.get("lang");
    const t = L[lang];
    const pending = listActions(db, ["pending_approval"]);
    const inFlight = listPurchaseOrders(db, ["approved", "sent"], 20);
    const history = listActions(db, ["approved", "rejected", "executed", "failed"], 10);
    const flashId = Number(c.req.query("done"));
    const flash = flashId ? getAction(db, flashId) : null;
    const err = c.req.query("error");
    const money = (f: number) => formatAed(f);
    return c.html(
      <Page title={t.approvals} lang={lang} active="approvals" owner={c.get("ownerName")} pending={c.get("pending")}>
        <h1>{t.pendingTitle}</h1>
        <div class="sub">{t.anyOwner}</div>
        {flash && <div class="card"><b>{flash.status === "rejected" ? "✕" : flash.status === "failed" ? "⚠" : "✓"}</b> {flash.result ?? flash.status}</div>}
        {err && <div class="card err">{err}</div>}
        {pending.length === 0 && <div class="card">{t.nothingPending}</div>}
        {pending.map((a) => {
          const po = a.type === "send_purchase_order" ? getPurchaseOrder(db, a.payload.poId) : null;
          return (
            <div class="card">
              <h2>{po ? `${po.number} · ${po.supplier}` : a.summary}</h2>
              {po && (
                <table><tbody>
                  {po.lines.map((l) => <tr><td>{`${l.packs} × ${l.packDescription}`}<div class="meta">{l.reason}</div></td><td class="n">{money(l.packs * l.priceFils)}</td></tr>)}
                  <tr><td><b>{t.inclVat}</b></td><td class="n"><b>{money(po.totalFils + po.vatFils)}</b></td></tr>
                </tbody></table>
              )}
              {po?.note && <div class="warn">⚠ {po.note}</div>}
              <div class="meta">{`${t.proposedBy} ${a.proposedBy} · ${a.proposedAt.slice(0, 16).replace("T", " ")}`}</div>
              <div class="actions">
                <form method="post" action={`/approvals/${a.id}/approve`}><button type="submit">{t.approve}</button></form>
                <form method="post" action={`/approvals/${a.id}/reject`}><button type="submit" class="danger">{t.reject}</button></form>
              </div>
            </div>
          );
        })}

        {inFlight.length > 0 && <h1 style="margin-top:18px">{t.awaitingDelivery}</h1>}
        {inFlight.map((po) => (
          <div class="card">
            <h2>{`${po.number} · ${po.supplier} · ${money(po.totalFils + po.vatFils)}`}</h2>
            <div class="meta">{`${po.status}${po.sentVia ? ` (${po.sentVia})` : ""}${po.expectedAt ? ` · ${t.expected} ${po.expectedAt}` : ""}`}</div>
            {po.status === "approved" && po.message && (<><p class="meta">{t.sendYourself}</p><pre class="msg">{po.message}</pre></>)}
            <div class="actions">
              {po.status === "approved" && <form method="post" action={`/orders/${po.id}/sent`}><button type="submit" class="secondary">{t.markSent}</button></form>}
              <form method="post" action={`/orders/${po.id}/received`}><button type="submit">{t.markReceived}</button></form>
            </div>
          </div>
        ))}

        {history.length > 0 && (
          <div class="card">
            <h2>{t.history}</h2>
            <ul class="alerts">{history.map((a) => <li><b>{a.status}</b> {`${t.decidedBy} ${a.decidedBy ?? "—"} · ${a.summary.split(" · ").slice(0, 2).join(" · ")}`}{a.result && <div class="meta">{a.result}</div>}</li>)}</ul>
          </div>
        )}
      </Page>,
    );
  });

  const fail = (c: any, e: unknown) => {
    if (e instanceof ApprovalError) return c.redirect(`/approvals?error=${encodeURIComponent(e.message)}`);
    throw e;
  };

  app.post("/approvals/:id/approve", async (c) => {
    const id = Number(c.req.param("id"));
    try {
      await approveAndExecute(db, id, c.get("ownerId"), deps.supplierSender);
    } catch (e) { return fail(c, e); }
    return c.redirect(`/approvals?done=${id}`);
  });

  app.post("/approvals/:id/reject", (c) => {
    const id = Number(c.req.param("id"));
    try {
      decideAction(db, id, c.get("ownerId"), "reject", `Rejected by ${c.get("ownerName")} in the dashboard`);
    } catch (e) { return fail(c, e); }
    return c.redirect(`/approvals?done=${id}`);
  });

  app.post("/orders/:id/sent", (c) => {
    try { markPurchaseOrderSent(db, Number(c.req.param("id"))); } catch (e) { return fail(c, e); }
    return c.redirect("/approvals");
  });

  app.post("/orders/:id/received", (c) => {
    try { receivePurchaseOrder(db, Number(c.req.param("id")), new Date().toISOString().slice(0, 19)); } catch (e) { return fail(c, e); }
    return c.redirect("/stock");
  });

  // ------------------------------------------------------------- Finance
  app.get("/finance", (c) => {
    const lang = c.get("lang");
    const t = L[lang];
    const date = latestBusinessDate(db) ?? todayInDubai();
    const mtd = pnlBusinessMonthToDate(db, date);
    const vat = vatPosition(db, date);
    const f = cashForecast(db, date);
    const k = (x: number) => Math.round(x / 100).toLocaleString("en-US");
    return c.html(
      <Page title={t.finance} lang={lang} active="finance" owner={c.get("ownerName")} pending={c.get("pending")}>
        <h1>{t.finance}</h1>
        <div class="sub">{date}</div>
        <div class="two">
          <div class="card">
            <h2>{`${t.pnlMtd} · ${mtd.month.start} → ${mtd.month.end}`}</h2>
            <table><tbody>
              <tr><td>{t.net}</td><td class="n">{aed0(mtd.totals.netSalesFils)}</td></tr>
              <tr><td>{t.cogs}</td><td class="n">{aed0(-mtd.totals.cogsFils)}</td></tr>
              <tr><td>{t.waste}</td><td class="n">{aed0(-mtd.totals.wasteFils)}</td></tr>
              <tr><td><b>{t.grossProfit}</b> · {pct(mtd.totals.grossMarginPct)}</td><td class="n"><b>{aed0(mtd.totals.grossProfitFils)}</b></td></tr>
              <tr><td>{t.rent}</td><td class="n">{aed0(-mtd.totals.rentFils)}</td></tr>
              <tr><td>{t.fixed}</td><td class="n">{aed0(-mtd.totals.fixedCostsFils)}</td></tr>
              <tr><td><b>{t.op}</b></td><td class="n"><b>{aed0(mtd.totals.operatingProfitFils)}</b></td></tr>
            </tbody></table>
          </div>
          <div class="card">
            <h2>{`${t.vatQuarter} · ${vat.quarter.start} → ${vat.quarter.end}`}</h2>
            <table><tbody>
              <tr><td>{t.outputVat}</td><td class="n">{aed0(vat.outputVatFils)}</td></tr>
              <tr><td>{t.inputVat}</td><td class="n">{aed0(-vat.inputVatFils)}</td></tr>
              <tr><td><b>{t.netPayable}</b></td><td class="n"><b>{aed0(vat.netPayableFils)}</b></td></tr>
              <tr><td>{t.projectedQ}</td><td class="n">{aed0(vat.projectedNetPayableFils)}</td></tr>
              <tr><td>{t.dueOn}</td><td class="n">{vat.quarter.due}</td></tr>
            </tbody></table>
            <p class="meta">{vat.note}</p>
          </div>
        </div>
        <div class="card">
          <h2>{t.cashForecast}</h2>
          {!f.openingKnown && <p class="meta">{t.noOpening}</p>}
          <table>
            <thead><tr><th>{t.weekOf}</th><th class="n wide">{t.takings}</th><th class="n wide">{t.restock}</th><th class="n wide">{t.rent}</th><th class="n wide">{t.monthly}</th><th class="n">{t.netCash}</th><th class="n">{t.balance}</th></tr></thead>
            <tbody>{f.weeks.map((w) => (
              <tr>
                <td>{w.weekStart.slice(5)}{w.vatPaidFils > 0 && <span class="badge b-low" style="margin-inline-start:4px">VAT</span>}{w.fixedCostsFils > 0 && <span class="badge b-ok" style="margin-inline-start:4px">8th</span>}</td>
                <td class="n wide">{k(w.takingsFils)}</td><td class="n wide">{k(-w.purchasesFils)}</td><td class="n wide">{k(-w.rentFils)}</td>
                <td class="n wide">{k(-w.fixedCostsFils - w.vatPaidFils)}</td>
                <td class={`n ${w.netFils < 0 ? "down" : ""}`}>{k(w.netFils)}</td>
                <td class={`n ${w.closingFils < 0 ? "down" : ""}`}><b>{k(w.closingFils)}</b></td>
              </tr>
            ))}</tbody>
          </table>
          <p class="meta">{`${t.lowestPoint}: ${aed0(f.lowestFils)} (${f.lowestWeek})`}</p>
          <ul class="meta">{f.assumptions.map((a) => <li>{a}</li>)}</ul>
        </div>
      </Page>,
    );
  });

  return app;
}
