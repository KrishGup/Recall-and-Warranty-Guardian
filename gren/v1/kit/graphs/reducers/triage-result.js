// Deterministic per-ticket result: needs_human is computed by code from the route, the policy check and the verifier.
// input: { ticket, label, trail, route, reply_survivors, reply_killed, policy }
export default async function triageResult(input) {
  const survivors = Array.isArray(input.reply_survivors) ? input.reply_survivors : [];
  const killed = Array.isArray(input.reply_killed) ? input.reply_killed : [];
  const policy = input.policy ?? {};
  const escalated = input.route === "escalate";
  const reply = survivors[0] ?? null;
  const reasons = [];
  if (escalated) reasons.push(`routed to escalate (label ${input.label?.label ?? input.label ?? "?"})`);
  if (policy.needs_human) reasons.push(...(policy.violations?.length ? policy.violations : ["policy check requires a human"]));
  if (!escalated && !reply) reasons.push(killed.length ? `reply rejected by verifier: ${(killed[0]?.reasons ?? []).join("; ")}` : "no reply drafted");
  return {
    ticket_id: input.ticket?.id ?? null,
    customer: input.ticket?.customer ?? null,
    tier: input.ticket?.tier ?? null,
    label: input.label?.label ?? input.label ?? null,
    confidence: input.label?.confidence ?? null,
    route: input.route ?? null,
    reply,
    refund_usd: reply?.refund_usd ?? 0,
    needs_human: reasons.length > 0,
    reasons,
    trail: input.trail ?? {},
    policy,
  };
}
