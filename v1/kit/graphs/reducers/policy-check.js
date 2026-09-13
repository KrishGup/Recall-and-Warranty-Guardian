// Deterministic policy check for a drafted support reply: refund limits per tier, forbidden phrases, absolute promises.
// input: { reply: {text, refund_usd?, escalate?}, label, tier, policies: { refund_limit_usd, tier_limits: {tier: usd}, forbidden_phrases: [] } }
export default async function policyCheck(input) {
  const p = input.policies ?? {};
  const reply = input.reply ?? {};
  const text = String(reply.text ?? reply.reply ?? (typeof reply === "string" ? reply : ""));
  const refund = Number(reply.refund_usd ?? input.refund_usd ?? 0) || 0;
  const tierLimit = Number(p.tier_limits?.[input.tier] ?? p.refund_limit_usd ?? 0);
  const violations = [];
  if (refund > tierLimit) violations.push(`refund $${refund} exceeds the $${tierLimit} limit for tier "${input.tier ?? "default"}"`);
  for (const phrase of p.forbidden_phrases ?? []) {
    if (text.toLowerCase().includes(String(phrase).toLowerCase())) violations.push(`forbidden phrase: "${phrase}"`);
  }
  if (/\b(guarantee|100%|will never happen again|legally)\b/i.test(text)) violations.push("reply makes an absolute or legal promise");
  const needs_human = violations.length > 0 || input.label === "legal" || reply.escalate === true;
  return { ok: violations.length === 0, violations, needs_human, refund_usd: refund, tier_limit_usd: tierLimit, label: input.label ?? null };
}
