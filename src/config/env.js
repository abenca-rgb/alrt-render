import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { getAllowedSymbolsFromEnv } from "./symbols.js";

dotenv.config();

const thisFile = fileURLToPath(import.meta.url);
const thisDir = path.dirname(thisFile);

export const ROOT_DIR = path.resolve(thisDir, "../..");
export const PORT = process.env.PORT || 3000;
export const APP_VERSION = "v25.5.16-trade-math-utils";

export const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
export const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
export const FREE_CHAT_ID = process.env.FREE_TELEGRAM_CHAT_ID || "";
export const PAID_TELEGRAM_CHAT_ID = process.env.PAID_TELEGRAM_CHAT_ID || CHAT_ID;

export const PUBLIC_SITE_URL = (process.env.PUBLIC_SITE_URL || "https://dalrt.com").replace(/\/+$/, "");
export const APP_BASE_URL = (process.env.APP_BASE_URL || "").replace(/\/+$/, "");
export const CHART_IMAGE_TEMPLATE = process.env.CHART_IMAGE_TEMPLATE || "";

export const SUPABASE_ENABLED = String(process.env.SUPABASE_ENABLED || "false").toLowerCase() === "true";
export const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
export const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

export const SUMMARY_ADMIN_TOKEN = process.env.SUMMARY_ADMIN_TOKEN || "";

export const DAILY_SUMMARY_ENABLED =
  String(process.env.DAILY_SUMMARY_ENABLED || "true").toLowerCase() !== "false";
export const DAILY_SUMMARY_UTC_HOUR = Number(process.env.DAILY_SUMMARY_UTC_HOUR || 23);
export const DAILY_SUMMARY_UTC_MINUTE = Number(process.env.DAILY_SUMMARY_UTC_MINUTE || 59);

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
export const ALLOWED_SYMBOLS = getAllowedSymbolsFromEnv(process.env.ALLOWED_SYMBOLS || "");

// State.json wint altijd als daar een hogere nextRef in staat.
export const REF_START_FLOOR = Number(process.env.NEXT_REF_START || 100127);
