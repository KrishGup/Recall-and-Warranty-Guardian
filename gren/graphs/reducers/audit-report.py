# Deterministic markdown audit report from inventory, verified issues, fix plans and dismissed issues.
# input: { repo, inventory, route, issues (verified, prioritised), fixes (survivors), dismissed (killed), unverified_fixes (killed fix plans), stats }
import json


def reduce(input, args, ctx):
    inv = input.get("inventory") or {}
    issues = input.get("issues") if isinstance(input.get("issues"), list) else []
    fixes = input.get("fixes") if isinstance(input.get("fixes"), list) else []
    dismissed = input.get("dismissed") if isinstance(input.get("dismissed"), list) else []
    bad_fixes = input.get("unverified_fixes") if isinstance(input.get("unverified_fixes"), list) else []
    L: list[str] = [f"# Codebase audit: {input.get('repo') or inv.get('root') or 'repository'}", ""]
    mods = inv.get("modules")
    L += [f"> {inv.get('file_count', '?')} files · {inv.get('total_lines', '?')} lines · {len(mods) if isinstance(mods, list) else '?'} modules · route: {input.get('route') or '?'} · {len(issues)} verified issues · {len(dismissed)} dismissed by the verifier · {len(fixes)} fix plans survived review", ""]
    if isinstance(input.get("stats"), dict):
        L += ["> " + " · ".join(f"{k}: {json.dumps(v) if isinstance(v, (dict, list)) else v}" for k, v in input["stats"].items()), ""]
    L += ["## Verified issues (prioritised)", ""]
    if not issues:
        L += ["_No issue survived verification._", ""]
    for it in issues:
        L += [f"### {it.get('rank', '')}. [{str(it.get('severity')).upper()}] {it.get('title')}", "", f"**Where:** `{it.get('file')}{':' + str(it['line']) if it.get('line') else ''}` · **Category:** {it.get('category')}", "", str(it.get("description") or "").strip(), ""]
        if it.get("evidence"):
            L += ["```", str(it["evidence"]).strip(), "```", ""]
        if it.get("suggested_fix"):
            L += [f"**Suggested fix:** {it['suggested_fix']}", ""]
    L += ["## Fix plans (survived adversarial review)", ""]
    if not fixes:
        L += ["_No fix plan survived review._", ""]
    for f in fixes:
        L += [f"### {f.get('issue_ref') or f.get('title') or 'fix'}", "", str(f.get("plan") or "").strip(), ""]
        if f.get("patch"):
            L += ["```diff", str(f["patch"]).strip(), "```", ""]
        if f.get("risk"):
            L += [f"**Risk:** {f['risk']}", ""]
        if isinstance(f.get("tests_to_add"), list) and f["tests_to_add"]:
            L += ["**Tests to add:**"] + [f"- {t}" for t in f["tests_to_add"]] + [""]
    if bad_fixes:
        L += ["## Fix plans rejected by review", ""]
        for k in bad_fixes:
            item = k.get("item") or {}
            L.append(f"- {item.get('issue_ref') or item.get('title') or '#' + str(k.get('index'))}: {'; '.join(k.get('reasons') or [])}")
        L.append("")
    if dismissed:
        L += ["## Reported issues dismissed by the verifier", ""]
        for k in dismissed:
            item = k.get("item") or {}
            L.append(f"- `{item.get('file') or '?'}` {item.get('title') or ''}: {'; '.join(k.get('reasons') or [])}")
        L.append("")
    ctx.log(f"audit report: {len(issues)} issues, {len(fixes)} fixes, {len(dismissed)} dismissed")
    return {"markdown": "\n".join(L), "issues": len(issues), "fixes": len(fixes), "dismissed": len(dismissed), "_stats": {"in": len(issues) + len(dismissed), "out": len(issues)}}
