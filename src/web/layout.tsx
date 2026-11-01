/** @jsxImportSource hono/jsx */
import type { Child } from "hono/jsx";

export type Lang = "en" | "ar";

export const L = {
  en: {
    today: "Today", stock: "Stock", sales: "Sales", logout: "Log out", net: "Net sales", orders: "Orders", avgTicket: "Avg ticket",
    gm: "Gross margin", op: "Operating profit", rent: "Rent", vsLw: "vs last week", best: "Best sellers", worst: "Slowest sellers",
    alerts: "Stock alerts", noAlerts: "No stock alerts", payback: "Capital payback", recovered: "recovered of", projected: "Projected",
    target: "Target", onTrack: "On track", behind: "Behind target", mtd: "Business month to date", ingredient: "Ingredient", onHand: "On hand",
    reorder: "Reorder at", cover: "Days cover", expiry: "Next expiry", supplier: "Supplier", value: "Stock value", item: "Item", qty: "Qty",
    margin: "Margin", share: "Share", peak: "Orders by hour", daily: "Daily net sales", menuMargins: "Margin per drink (current costs)",
    price: "Price", cost: "Recipe cost", noData: "No sales imported for this date yet.", low: "Low", out: "Out", ok: "OK",
    expiring: "Expiring", expired: "Expired", shortfall: "Sold beyond stock on record — count needed", lastImport: "Last import",
    login: "Sign in", owner: "Owner", pin: "PIN", wrongPin: "Wrong owner or PIN", noPins: "No owner PIN is set yet. On the server run:",
    week: "Last 7 days", vat: "VAT collected", cogs: "COGS", waste: "Waste & staff drinks", fixed: "Fixed costs",
  },
  ar: {
    today: "اليوم", stock: "المخزون", sales: "المبيعات", logout: "خروج", net: "صافي المبيعات", orders: "الطلبات", avgTicket: "متوسط الفاتورة",
    gm: "هامش الربح الإجمالي", op: "الربح التشغيلي", rent: "الإيجار", vsLw: "مقارنة بالأسبوع الماضي", best: "الأكثر مبيعاً", worst: "الأقل مبيعاً",
    alerts: "تنبيهات المخزون", noAlerts: "لا توجد تنبيهات", payback: "استرداد رأس المال", recovered: "مسترد من", projected: "المتوقع",
    target: "الهدف", onTrack: "على المسار", behind: "متأخر عن الهدف", mtd: "الشهر التشغيلي حتى اليوم", ingredient: "المكوّن", onHand: "المتوفر",
    reorder: "حد الطلب", cover: "أيام التغطية", expiry: "أقرب انتهاء", supplier: "المورّد", value: "قيمة المخزون", item: "الصنف", qty: "الكمية",
    margin: "الهامش", share: "الحصة", peak: "الطلبات حسب الساعة", daily: "صافي المبيعات اليومية", menuMargins: "هامش كل مشروب (بالتكلفة الحالية)",
    price: "السعر", cost: "تكلفة الوصفة", noData: "لم يتم استيراد مبيعات لهذا اليوم بعد.", low: "منخفض", out: "نفد", ok: "جيد",
    expiring: "ينتهي قريباً", expired: "منتهي", shortfall: "مبيعات تتجاوز المخزون المسجل — يلزم جرد", lastImport: "آخر استيراد",
    login: "تسجيل الدخول", owner: "الشريك", pin: "الرمز", wrongPin: "الشريك أو الرمز غير صحيح", noPins: "لم يتم تعيين رمز لأي شريك بعد. على الخادم شغّل:",
    week: "آخر ٧ أيام", vat: "الضريبة المحصلة", cogs: "تكلفة البضاعة", waste: "الهدر ومشروبات الموظفين", fixed: "التكاليف الثابتة",
  },
} as const;

export type Dict = Record<keyof (typeof L)["en"], string>;

const CSS = `
:root{--bg:#f7f2ea;--surface:#fffdf9;--ink:#2b1d14;--muted:#7a6a5d;--line:#e8dccb;--brand:#5b3a24;--accent:#b8862b;
--ok:#2f7d4f;--warn:#b7791f;--bad:#b42318;--okbg:#e6f4ea;--warnbg:#fdf3dc;--badbg:#fde8e6;--bar:#c9a46a}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#17110d;--surface:#211913;--ink:#f3e9dc;--muted:#b4a392;--line:#3a2d23;
--brand:#e2c49a;--accent:#d9a647;--okbg:#18301f;--warnbg:#3a2c12;--badbg:#3d1714;--ok:#6fcf97;--warn:#f2c14e;--bad:#f28b82;--bar:#a7814a}}
:root[data-theme="dark"]{--bg:#17110d;--surface:#211913;--ink:#f3e9dc;--muted:#b4a392;--line:#3a2d23;--brand:#e2c49a;--accent:#d9a647;
--okbg:#18301f;--warnbg:#3a2c12;--badbg:#3d1714;--ok:#6fcf97;--warn:#f2c14e;--bad:#f28b82;--bar:#a7814a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,"Segoe UI","Noto Sans Arabic",sans-serif}
header{position:sticky;top:0;background:var(--surface);border-bottom:1px solid var(--line);z-index:2}
.bar{max-width:960px;margin:0 auto;padding:10px 16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.logo{font-weight:700;color:var(--brand);letter-spacing:.3px;margin-inline-end:auto}.logo small{color:var(--accent);font-weight:600}
nav a{color:var(--muted);text-decoration:none;padding:6px 8px;border-radius:8px;white-space:nowrap}nav a.on{background:var(--bg);color:var(--ink);font-weight:600}
.tools a{color:var(--muted);font-size:13px;text-decoration:none;margin-inline-start:8px}
main{max-width:960px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:4px 0 2px}h2{font-size:15px;margin:0 0 10px;color:var(--brand)}.sub{color:var(--muted);font-size:13px;margin-bottom:14px}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-bottom:12px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:14px;margin-bottom:12px;overflow-x:auto}
.kpi .v{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums}.kpi .l{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.4px}
.kpi .d{font-size:12px;color:var(--muted)}.up{color:var(--ok)}.down{color:var(--bad)}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}th,td{padding:7px 6px;border-bottom:1px solid var(--line);text-align:start;white-space:nowrap}
th{font-size:12px;color:var(--muted);font-weight:600}td.n,th.n{text-align:end}td:first-child{white-space:normal;min-width:7em}
@media (max-width:600px){table{font-size:14px}th,td{padding:7px 4px}}
.badge{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;font-weight:600}
.b-ok{background:var(--okbg);color:var(--ok)}.b-low{background:var(--warnbg);color:var(--warn)}.b-out{background:var(--badbg);color:var(--bad)}
ul.alerts{list-style:none;margin:0;padding:0}ul.alerts li{padding:6px 0;border-bottom:1px solid var(--line)}ul.alerts li:last-child{border:0}
.progress{height:12px;background:var(--bg);border-radius:99px;overflow:hidden;border:1px solid var(--line)}.progress>i{display:block;height:100%;background:var(--accent)}
.hbar{display:grid;grid-template-columns:52px 1fr 44px;gap:8px;align-items:center;font-size:13px;margin:3px 0}
.hbar .t{height:14px;background:var(--bar);border-radius:4px;min-width:2px}.hbar .c{text-align:end;color:var(--muted);font-variant-numeric:tabular-nums}
.two{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(280px,1fr))}
form.login{max-width:340px;margin:40px auto}label{display:block;font-size:13px;color:var(--muted);margin:10px 0 4px}
select,input{width:100%;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--surface);color:var(--ink);font-size:16px}
button{margin-top:14px;width:100%;padding:11px;border:0;border-radius:10px;background:var(--brand);color:var(--surface);font-weight:700;font-size:15px}
.err{color:var(--bad);font-size:14px}code{background:var(--bg);padding:2px 6px;border-radius:6px}
@media (max-width:600px){.wide{display:none}}
.datepick{display:flex;gap:8px;align-items:center;margin-bottom:12px}.datepick input{width:auto;padding:6px 8px;font-size:14px}.datepick button{width:auto;margin:0;padding:7px 12px;font-size:13px}
`;

export function Page(props: { title: string; lang: Lang; active?: string; owner?: string | null; children: Child }) {
  const t = L[props.lang];
  const navItem = (href: string, key: "today" | "stock" | "sales") => (
    <a href={href} class={props.active === key ? "on" : ""}>{t[key]}</a>
  );
  return (
    <html lang={props.lang} dir={props.lang === "ar" ? "rtl" : "ltr"}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{`${props.title} · The Liwan`}</title>
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body>
        {props.owner !== undefined && (
          <header>
            <div class="bar">
              <span class="logo">The Liwan <small>الليوان</small></span>
              <nav>{navItem("/", "today")}{navItem("/stock", "stock")}{navItem("/sales", "sales")}</nav>
              <span class="tools">
                <a href={`/lang/${props.lang === "ar" ? "en" : "ar"}`}>{props.lang === "ar" ? "English" : "العربية"}</a>
                <a href="/logout">{t.logout}</a>
              </span>
            </div>
          </header>
        )}
        <main>{props.children}</main>
      </body>
    </html>
  );
}
