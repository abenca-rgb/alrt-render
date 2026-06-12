import fs from "fs";
import { normalizeSetupGroup } from "../../src/services/clusterGuardrailService.js";

const SUPABASE_ENABLED = String(process.env.SUPABASE_ENABLED || "false").toLowerCase() === "true";
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

function ready() {
  return Boolean(SUPABASE_ENABLED && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function readStdin() {
  if (process.stdin.isTTY) return "";

  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input.trim();
}

async function readInputJson() {
  const file = argValue("--file");
  const raw = file ? fs.readFileSync(file, "utf8") : await readStdin();

  if (!raw) {
    throw new Error("Provide impact-analysis JSON via stdin or --file path");
  }

  return JSON.parse(raw);
}

function collectPairs(value, pairs = []) {
  if (!value) return pairs;

  if (Array.isArray(value)) {
    for (const item of value) collectPairs(item, pairs);
    return pairs;
  }

  if (typeof value !== "object") return pairs;

  const current = value.alertId || value.alert_id || value.currentAlertId || value.current_alert_id;
  const previous =
    value.matchedPreviousAlertId ||
    value.matched_previous_alert_id ||
    value.previousAlertId ||
    value.previous_alert_id;

  if (current && previous) {
    pairs.push({
      currentAlertId: String(current),
      previousAlertId: String(previous),
    });
  }

  for (const child of Object.values(value)) collectPairs(child, pairs);
  return pairs;
}

function uniquePairs(pairs) {
  const seen = new Set();
  return pairs.filter((pair) => {
    const key = `${pair.currentAlertId}|${pair.previousAlertId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function selectRows(table, query) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    method: "GET",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Supabase ${table} SELECT failed ${response.status}: ${text}`);
  }

  return response.json();
}

function inFilter(values) {
  return `in.(${values.map((value) => `"${String(value).replace(/"/g, '\\"')}"`).join(",")})`;
}

function parseTime(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function pickPayloadValue(payload, keys) {
  if (!payload || typeof payload !== "object") return null;

  for (const key of keys) {
    const value = payload[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") return String(value);
  }

  return null;
}

function payloadIds(payload) {
  return {
    alertId: pickPayloadValue(payload, ["alert_id", "signal_alert_id", "source_alert_id", "parent_alert_id"]),
    orderId: pickPayloadValue(payload, ["strategy_order_id", "order_id", "id"]),
    ref: pickPayloadValue(payload, ["ref_id", "ref", "reference", "alert_ref"]),
  };
}

function rawBarTimestamp(payload) {
  return pickPayloadValue(payload, ["time_close", "bar_close_time", "timestamp", "time"]);
}

function samePayloadIds(a, b) {
  const keys = ["alertId", "orderId", "ref"];
  return keys.some((key) => a?.[key] && b?.[key] && a[key] === b[key]);
}

function classifyPair({ current, previous, currentCandidate, previousCandidate, secondsDifference }) {
  const currentSetupGroup = normalizeSetupGroup(current?.setup_type);
  const previousSetupGroup = normalizeSetupGroup(previous?.setup_type);
  const currentPayloadIds = payloadIds(current?.raw_payload);
  const previousPayloadIds = payloadIds(previous?.raw_payload);
  const currentBarTime = rawBarTimestamp(current?.raw_payload);
  const previousBarTime = rawBarTimestamp(previous?.raw_payload);
  const currentCandidateKey = currentCandidate?.candidate_key || null;
  const previousCandidateKey = previousCandidate?.candidate_key || null;

  if (!Number.isFinite(secondsDifference) || secondsDifference <= 0) return "ANALYSIS_BUG";
  if (current?.symbol !== previous?.symbol || current?.direction !== previous?.direction) return "ANALYSIS_BUG";
  if (currentSetupGroup !== previousSetupGroup) return "ANALYSIS_BUG";

  if (currentCandidateKey && previousCandidateKey && currentCandidateKey === previousCandidateKey) {
    return "DUPLICATE_PROCESSING";
  }

  if (samePayloadIds(currentPayloadIds, previousPayloadIds)) {
    return "DUPLICATE_WEBHOOK";
  }

  if (currentBarTime && previousBarTime && currentBarTime === previousBarTime) {
    if ((current?.setup_type || "UNKNOWN") !== (previous?.setup_type || "UNKNOWN")) return "DIFFERENT_SETUP";
    return "TRUE_DUPLICATE";
  }

  if (secondsDifference <= 30 && (current?.setup_type || "UNKNOWN") !== (previous?.setup_type || "UNKNOWN")) {
    return "DIFFERENT_SETUP";
  }

  if (secondsDifference <= 30) return "TRUE_DUPLICATE";

  return "OTHER";
}

async function main() {
  if (!ready()) {
    console.error("Missing live Supabase env: SUPABASE_ENABLED=true, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
    process.exit(2);
  }

  const input = await readInputJson();
  const pairs = uniquePairs(collectPairs(input));

  if (!pairs.length) {
    throw new Error("No blocked alert pairs found in input JSON");
  }

  const ids = [...new Set(pairs.flatMap((pair) => [pair.currentAlertId, pair.previousAlertId]))];
  const alertRows = await selectRows(
    "alerts",
    `?select=alert_id,ref_id,symbol,direction,setup_type,signal_time_utc,raw_payload&alert_id=${encodeURIComponent(inFilter(ids))}&limit=10000`,
  );
  const candidateRows = await selectRows(
    "alert_candidates",
    `?select=alert_id,candidate_key,ref_id,event_time_utc,setup_type,raw_payload&alert_id=${encodeURIComponent(inFilter(ids))}&limit=10000`,
  );

  const alertsById = new Map(alertRows.map((row) => [String(row.alert_id), row]));
  const candidatesByAlertId = new Map(candidateRows.map((row) => [String(row.alert_id), row]));

  const investigations = pairs.map((pair) => {
    const current = alertsById.get(pair.currentAlertId) || null;
    const previous = alertsById.get(pair.previousAlertId) || null;
    const currentCandidate = candidatesByAlertId.get(pair.currentAlertId) || null;
    const previousCandidate = candidatesByAlertId.get(pair.previousAlertId) || null;
    const currentMs = parseTime(current?.signal_time_utc);
    const previousMs = parseTime(previous?.signal_time_utc);
    const secondsDifference =
      currentMs !== null && previousMs !== null
        ? Number(((currentMs - previousMs) / 1000).toFixed(3))
        : null;
    const classification = classifyPair({
      current,
      previous,
      currentCandidate,
      previousCandidate,
      secondsDifference,
    });

    return {
      currentAlertId: pair.currentAlertId,
      previousAlertId: pair.previousAlertId,
      currentSignalTimeUtc: current?.signal_time_utc || null,
      previousSignalTimeUtc: previous?.signal_time_utc || null,
      exactSecondsDifference: secondsDifference,
      symbol: current?.symbol || previous?.symbol || null,
      direction: current?.direction || previous?.direction || null,
      setupGroup: normalizeSetupGroup(current?.setup_type || previous?.setup_type),
      currentSetupType: current?.setup_type || null,
      previousSetupType: previous?.setup_type || null,
      currentCandidateKey: currentCandidate?.candidate_key || null,
      previousCandidateKey: previousCandidate?.candidate_key || null,
      currentRawTradingViewBarTimestamp: rawBarTimestamp(current?.raw_payload),
      previousRawTradingViewBarTimestamp: rawBarTimestamp(previous?.raw_payload),
      currentPayloadIds: payloadIds(current?.raw_payload),
      previousPayloadIds: payloadIds(previous?.raw_payload),
      rootCauseClassification: classification,
    };
  });

  const summary = investigations.reduce((acc, item) => {
    acc[item.rootCauseClassification] = (acc[item.rootCauseClassification] || 0) + 1;
    return acc;
  }, {
    TRUE_DUPLICATE: 0,
    DUPLICATE_WEBHOOK: 0,
    DUPLICATE_PROCESSING: 0,
    DIFFERENT_SETUP: 0,
    ANALYSIS_BUG: 0,
    OTHER: 0,
  });

  console.log(JSON.stringify({ investigations, summary }, null, 2));
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
