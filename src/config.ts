/** Runtime configuration from environment variables (.env is loaded automatically if present). */
try {
  process.loadEnvFile();
} catch {
  /* no .env file — fine */
}

const env = (k: string, d = "") => process.env[k]?.trim() || d;

export const config = {
  dbPath: env("LIWAN_DB", "data/liwan.db"),
  model: env("LIWAN_MODEL", "claude-sonnet-5-5"),
  anthropicKeyPresent: Boolean(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN),
  port: Number(env("PORT", "8787")),
  dashboardUrl: env("DASHBOARD_URL", "http://localhost:8787"),
  sessionSecret: env("SESSION_SECRET", "dev-only-change-me"),
  whatsapp: {
    token: env("WHATSAPP_TOKEN"),
    phoneNumberId: env("WHATSAPP_PHONE_NUMBER_ID"),
    apiVersion: env("WHATSAPP_API_VERSION", "v21.0"),
    mode: env("WHATSAPP_MODE", "template") as "template" | "text",
    dailyTemplate: env("WHATSAPP_TEMPLATE_DAILY", "liwan_daily_summary"),
    weeklyTemplate: env("WHATSAPP_TEMPLATE_WEEKLY", "liwan_weekly_report"),
    templateLanguage: env("WHATSAPP_TEMPLATE_LANG", "en"),
  },
  email: {
    host: env("SMTP_HOST"),
    port: Number(env("SMTP_PORT", "465")),
    user: env("SMTP_USER"),
    pass: env("SMTP_PASS"),
    from: env("EMAIL_FROM", env("SMTP_USER") ? `The Liwan <${env("SMTP_USER")}>` : ""),
  },
};

export const emailConfigured = () => Boolean(config.email.host && config.email.user && config.email.pass);
export const whatsappConfigured = () => Boolean(config.whatsapp.token && config.whatsapp.phoneNumberId);
