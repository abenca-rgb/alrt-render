import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { getAllowedSymbolsFromEnv } from "./symbols.js";

dotenv.config();

const thisFile = fileURLToPath(import.meta.url);
const thisDir = path.dirname(thisFile);

export const ROOT_DIR = path.resolve(thisDir, "../..");
export const PORT = process.env.PORT || 3000;
export const APP_VERSION = "v25.5.48-deploy-safe-summaries";

export const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
export const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
export const FREE_CHAT_ID = process.env.FREE_TELEGRAM_CHAT_ID || "";
export const PAID_TELEGRAM_CHAT_ID = process.env.PAID_TELEGRAM_CHAT_ID || "";

function parseCsv(value = "") {
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export const TELEGRAM_MIRROR_CHAT_IDS = Array.from(new Set([
  ...parseCsv(process.env.TELEGRAM_MIRROR_CHAT_IDS || ""),
  ...parseCsv(process.env.STAGING_TELEGRAM_CHAT_ID || ""),
]));
export const TELEGRAM_MIRROR_BOT_TOKEN =
  process.env.TELEGRAM_MIRROR_BOT_TOKEN ||
  process.env.STAGING_TELEGRAM_BOT_TOKEN ||
  "";

export const PUBLIC_SITE_URL = (process.env.PUBLIC_SITE_URL || "https://dalrt.com").replace(/\/+$/, "");
export const APP_BASE_URL = (process.env.APP_BASE_URL || "").replace(/\/+$/, "");
export const CHART_IMAGE_TEMPLATE = process.env.CHART_IMAGE_TEMPLATE || "";

export const SUPABASE_ENABLED = String(process.env.SUPABASE_ENABLED || "false").toLowerCase() === "true";
export const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
export const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
export const WORDPRESS_SYNC_ENABLED =
  String(process.env.WORDPRESS_SYNC_ENABLED || "false").toLowerCase() === "true";
export const WORDPRESS_SYNC_BASE_URL = (process.env.WORDPRESS_SYNC_BASE_URL || "").replace(/\/+$/, "");
export const WORDPRESS_SYNC_TOKEN = process.env.WORDPRESS_SYNC_TOKEN || "";
export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
export const LEARNING_LOGGING_ENABLED =
  String(process.env.LEARNING_LOGGING_ENABLED || "true").toLowerCase() !== "false";
export const CANDIDATE_LOGGING_ENABLED =
  String(process.env.CANDIDATE_LOGGING_ENABLED || "true").toLowerCase() !== "false";
export const SHADOW_SCORING_ENABLED =
  String(process.env.SHADOW_SCORING_ENABLED || "false").toLowerCase() === "true";
export const OPTIMIZER_REPORTS_ENABLED =
  String(process.env.OPTIMIZER_REPORTS_ENABLED || "true").toLowerCase() !== "false";
export const SHADOW_VALIDATION_ENABLED =
  String(process.env.SHADOW_VALIDATION_ENABLED || "true").toLowerCase() !== "false";
export const SHADOW_V21_LIVE_GATE_ENABLED =
  String(process.env.SHADOW_V21_LIVE_GATE_ENABLED || "false").toLowerCase() === "true";
const SHADOW_V21_LIVE_GATE_MODE_RAW = String(process.env.SHADOW_V21_LIVE_GATE_MODE || "paid_only").toLowerCase();
export const SHADOW_V21_LIVE_GATE_MODE =
  ["off", "free_only", "paid_only", "all"].includes(SHADOW_V21_LIVE_GATE_MODE_RAW)
    ? SHADOW_V21_LIVE_GATE_MODE_RAW
    : "paid_only";

export const SUMMARY_ADMIN_TOKEN = process.env.SUMMARY_ADMIN_TOKEN || "";

export const DAILY_SUMMARY_ENABLED =
  String(process.env.DAILY_SUMMARY_ENABLED || "true").toLowerCase() !== "false";
export const DAILY_SUMMARY_UTC_HOUR = Number(process.env.DAILY_SUMMARY_UTC_HOUR || 23);
export const DAILY_SUMMARY_UTC_MINUTE = Number(process.env.DAILY_SUMMARY_UTC_MINUTE || 59);
export const SUMMARY_DISPATCH_SCOPE =
  process.env.SUMMARY_DISPATCH_SCOPE ||
  process.env.RENDER_SERVICE_NAME ||
  APP_BASE_URL ||
  PUBLIC_SITE_URL ||
  "default";

export const DATA_DIR = process.env.RENDER_DISK_PATH || process.env.DATA_DIR || "/var/data";
export const STATE_FILE = path.join(DATA_DIR, "state.json");

export const MAX_TRADE_AGE_MS = 24 * 60 * 60 * 1000;
export const HIT_DEDUP_TTL_MS = 36 * 60 * 60 * 1000;
export const LOSS_GUARD_SYMBOL_COOLDOWN_MS =
  Number(process.env.LOSS_GUARD_SYMBOL_COOLDOWN_MINUTES || 180) * 60 * 1000;
export const LOSS_GUARD_MARKET_WINDOW_MS =
  Number(process.env.LOSS_GUARD_MARKET_WINDOW_MINUTES || 120) * 60 * 1000;
export const LOSS_GUARD_MARKET_COOLDOWN_MS =
  Number(process.env.LOSS_GUARD_MARKET_COOLDOWN_MINUTES || 90) * 60 * 1000;
export const LOSS_GUARD_MARKET_LIMIT = Number(process.env.LOSS_GUARD_MARKET_LIMIT || 3);
export const LOSS_GUARD_RETENTION_MS = Math.max(
  LOSS_GUARD_SYMBOL_COOLDOWN_MS,
  LOSS_GUARD_MARKET_WINDOW_MS + LOSS_GUARD_MARKET_COOLDOWN_MS,
  24 * 60 * 60 * 1000,
);

export const FREE_REF_TTL_MS = 48 * 60 * 60 * 1000;
export const FREE_DAILY_LIMIT = 2;

export const MIN_RR_TO_SEND = Number(process.env.MIN_RR_TO_SEND || 0);
export const MAX_OPEN_TRADES_PER_SYMBOL = Number(process.env.MAX_OPEN_TRADES_PER_SYMBOL || 1);
export const MAX_OPEN_TRADES_PER_SIDE = Number(process.env.MAX_OPEN_TRADES_PER_SIDE || 1);
export const DAILY_SL_CIRCUIT_BREAKER = Number(process.env.DAILY_SL_CIRCUIT_BREAKER || 2);

export const ALERT_QUALITY_FILTER_ENABLED =
  String(process.env.ALERT_QUALITY_FILTER_ENABLED || "false").toLowerCase() === "true";
export const CANDIDATE_QUALITY_FILTER_ENABLED =
  String(process.env.CANDIDATE_QUALITY_FILTER_ENABLED || "true").toLowerCase() !== "false";
export const HISTORICAL_QUALITY_ADJUSTMENTS_ENABLED =
  String(process.env.HISTORICAL_QUALITY_ADJUSTMENTS_ENABLED || "false").toLowerCase() === "true";
export const DUPLICATE_SUPPRESSION_ENABLED =
  String(process.env.DUPLICATE_SUPPRESSION_ENABLED || "false").toLowerCase() === "true";
export const ALERT_DUPLICATE_GUARD_ENABLED =
  String(process.env.ALERT_DUPLICATE_GUARD_ENABLED || "true").toLowerCase() !== "false";
export const ALERT_DUPLICATE_GUARD_WINDOW_MS =
  Number(process.env.ALERT_DUPLICATE_GUARD_WINDOW_MINUTES || 10) * 60 * 1000;
export const ALERT_DUPLICATE_GUARD_TTL_MS =
  Number(process.env.ALERT_DUPLICATE_GUARD_TTL_HOURS || 36) * 60 * 60 * 1000;
export const QUALITY_OPTIMIZER_ENABLED =
  String(process.env.QUALITY_OPTIMIZER_ENABLED || "true").toLowerCase() !== "false";
export const QUALITY_OPTIMIZER_UTC_HOUR = Number(process.env.QUALITY_OPTIMIZER_UTC_HOUR || 2);
export const QUALITY_OPTIMIZER_UTC_MINUTE = Number(process.env.QUALITY_OPTIMIZER_UTC_MINUTE || 10);
export const AUTO_TUNING =
  String(process.env.AUTO_TUNING || "false").toLowerCase() === "true";
export const ALLOWED_SYMBOLS = getAllowedSymbolsFromEnv(process.env.ALLOWED_SYMBOLS || "");

export const CLUSTER_GUARDRAIL_ENABLED =
  String(process.env.CLUSTER_GUARDRAIL_ENABLED || "false").toLowerCase() === "true";
export const CLUSTER_GUARDRAIL_WINDOW_MINUTES = Number(process.env.CLUSTER_GUARDRAIL_WINDOW_MINUTES || 60);
export const CLUSTER_GUARDRAIL_MODE = process.env.CLUSTER_GUARDRAIL_MODE || "conservative";
export const CLUSTER_GUARDRAIL_VERSION = process.env.CLUSTER_GUARDRAIL_VERSION || "v1";
export const CLUSTER_GUARDRAIL_ROLLBACK_ENABLED =
  String(process.env.CLUSTER_GUARDRAIL_ROLLBACK_ENABLED || "true").toLowerCase() !== "false";

// State.json wint altijd als daar een hogere nextRef in staat.
export const REF_START_FLOOR = Number(process.env.NEXT_REF_START || 100127);
