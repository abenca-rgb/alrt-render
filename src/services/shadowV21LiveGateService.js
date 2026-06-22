const ALLOWED_MODES = new Set(["off", "free_only", "paid_only", "all"]);

function normalizeMode(mode) {
  const value = String(mode || "paid_only").toLowerCase();
  return ALLOWED_MODES.has(value) ? value : "paid_only";
}

function passesV21(evaluation) {
  return ["A+", "A"].includes(evaluation?.proposedGrade);
}

export function createShadowV21LiveGateService({
  enabled = false,
  mode = "paid_only",
  shadowScoringService,
} = {}) {
  const normalizedMode = normalizeMode(mode);
  const active = Boolean(enabled) && normalizedMode !== "off";

  function evaluate({ context, quality } = {}) {
    const evaluation = shadowScoringService?.evaluateCandidateV21?.({ context, quality }) || null;
    const passed = passesV21(evaluation);
    const reason = passed
      ? "shadow_v21_live_gate_passed"
      : `shadow_v21_live_gate_blocked:${evaluation?.proposedGrade || "UNKNOWN"}`;

    return {
      enabled: active,
      mode: normalizedMode,
      evaluation,
      passed,
      reason,
      shouldBlockPaid: active && !passed && ["paid_only", "all"].includes(normalizedMode),
      shouldBlockFree: active && !passed && ["free_only", "all"].includes(normalizedMode),
    };
  }

  return {
    enabled: active,
    mode: normalizedMode,
    evaluate,
  };
}
