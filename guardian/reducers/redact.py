# Node redact: card numbers never reach a model or storage. Luhn-valid 13-19 digit runs become "[card removed]".
import re

_CANDIDATE = re.compile(r"(?<!\d)(?:\d[ \-]?){13,19}(?!\d)")


def luhn_ok(digits: str) -> bool:
    total, alt = 0, False
    for ch in reversed(digits):
        d = int(ch)
        if alt:
            d = d * 2
            if d > 9:
                d -= 9
        total += d
        alt = not alt
    return total % 10 == 0


def redact(text: str) -> tuple[str, int]:
    n = 0

    def sub(m: re.Match) -> str:
        nonlocal n
        digits = re.sub(r"\D", "", m.group(0))
        if 13 <= len(digits) <= 19 and luhn_ok(digits):
            n += 1
            return "[card removed]"
        return m.group(0)

    return _CANDIDATE.sub(sub, text or ""), n


def reduce(input, args, ctx):
    text, n = redact(str(input.get("text") or ""))
    if n:
        ctx.log(f"{n} card number(s) stripped")
    return {"text": text, "stripped": n, "chars": len(text), "_stats": {"in": 1, "out": 1}}
