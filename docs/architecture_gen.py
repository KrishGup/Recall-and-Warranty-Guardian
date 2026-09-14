"""Generate architecture.html (one SVG, computed coordinates) for the Guardian architecture diagram."""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
W, H = 1600, 1000
INK, PAPER, PRIMARY, ACCENT, CRIT, OK, INK2, LINE, SURF, TINT = "#000F08", "#F7F4F3", "#2274A5", "#FCBA04", "#960200", "#2E7D4F", "#4A5551", "#DDD7D4", "#FFFFFF", "#EFEBE9"
AMBER = "#D9A004"
KIND = {"code": INK2, "agent": PRIMARY, "verify": OK, "gate": AMBER}
HEAD = "'Roboto Slab', Georgia, serif"
BODY = "Lora, Georgia, serif"
UI = "Habibi, serif"
MONO = "ui-monospace, Consolas, monospace"

out = []


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def text(x, y, s, size=13, fam=BODY, fill=INK, weight="normal", anchor="start", style=""):
    out.append(f'<text x="{x}" y="{y}" font-family="{fam}" font-size="{size}" font-weight="{weight}" fill="{fill}" text-anchor="{anchor}" style="{style}">{esc(s)}</text>')


def lines(x, y, rows, size=12.5, fam=BODY, fill=INK2, lh=17):
    for i, r in enumerate(rows):
        text(x, y + i * lh, r, size, fam, fill)


def box(x, y, w, h, title, rows, border=LINE, bw=1.5, title_size=15, rows_size=12.5, lh=17):
    out.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="14" fill="{SURF}" stroke="{border}" stroke-width="{bw}"/>')
    text(x + 16, y + 26, title, title_size, HEAD, INK, "600")
    lines(x + 16, y + 46, rows, rows_size, BODY, INK2, lh)


def path(d, color=INK2, width=1.8, dash=None, marker=True):
    da = f' stroke-dasharray="{dash}"' if dash else ""
    mk = f' marker-end="url(#m-{color.strip("#")})"' if marker else ""
    out.append(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{width}"{da}{mk}/>')


# ---- graph geometry
GX, GY, GW, GH = 330, 150, 1216, 400
NW, NH = 156, 62
COLX = [352 + i * 172 for i in range(7)]
ROWY = {"A": 212, "B": 300, "C": 430}
NODES = {
    "feeds_refresh": (0, "A", "code", "code", "pull + normalize feeds"),
    "expiry_scan": (0, "B", "code", "code", "warranty windows · budget"),
    "candidate_gen": (1, "A", "code", "code", "stages 1–3: keys · lexical"),
    "warranty": (1, "B", "agent", "agent · map", "haiku · claim questions"),
    "matcher": (2, "A", "agent", "agent · map", "opus · ambiguous pairs only"),
    "verdicts": (3, "A", "code", "code", "confirmed · questions"),
    "triage": (4, "A", "agent", "agent", "opus · plan · SMS text"),
    "severity_check": (5, "A", "verify", "verify", "haiku · kill authority"),
    "digest": (5, "B", "code", "code", "standard hazards · weekly"),
    "household_decision": (6, "A", "gate", "human gate", "Strands interrupt · 72 h"),
    "answers": (6, "C", "code", "code", "approved decisions"),
    "remedy": (5, "C", "agent", "agent · map", "sonnet · ActionReport"),
    "followup": (4, "C", "code", "code · side effect", "send once · record · schedule"),
}


def nbox(name):
    c, r, *_ = NODES[name]
    return COLX[c], ROWY[r]


def right(name):
    x, y = nbox(name)
    return x + NW, y + NH / 2


def left(name):
    x, y = nbox(name)
    return x, y + NH / 2


def top(name):
    x, y = nbox(name)
    return x + NW / 2, y


def bottom(name):
    x, y = nbox(name)
    return x + NW / 2, y + NH


def h_arrow(a, b, color=INK2, dash=None, width=1.8):
    x1, y1 = right(a)
    x2, y2 = left(b)
    path(f"M{x1},{y1} L{x2 - 1},{y2}", color, width, dash)


# ---- page
out.append(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">')
out.append("<defs>")
for col in (INK2, PRIMARY, AMBER, CRIT):
    out.append(f'<marker id="m-{col.strip("#")}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{col}"/></marker>')
out.append('<pattern id="hatch" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="#D9A004" stroke-width="2"/></pattern>')
out.append("</defs>")
out.append(f'<rect width="{W}" height="{H}" fill="{PAPER}"/>')
text(54, 72, "Recall & Warranty Guardian", 30, HEAD, INK, "700")
text(54, 104, "A background agent for one household: gren graphs on the Strands Agents SDK, Claude on Amazon Bedrock, one human gate. Apache-2.0.", 15, BODY, INK2)

# inputs column
text(54, 168, "INPUTS", 12, UI, INK2, style="letter-spacing:.12em")
box(54, 178, 252, 100, "Recall feeds", ["CPSC SaferProducts · NHTSA recalls", "by vehicle (vPIC decode) · openFDA", "food enforcement. Pulled each night."])
box(54, 292, 252, 100, "Receipts, order emails, VINs", ["Forwarded to the household address,", "pasted, or typed. A VIN identifies a", "car through the NHTSA vPIC decoder."])
box(54, 406, 252, 70, "intake graph · 3 nodes", ["redact (code) → extract (agent, haiku)", "→ save_item (code)"], border=PRIMARY)

# graph container
out.append(f'<rect x="{GX}" y="{GY}" width="{GW}" height="{GH}" rx="20" fill="rgba(255,255,255,.55)" stroke="#B9B3B0" stroke-width="1.5" stroke-dasharray="6 5"/>')
text(GX + 20, GY + 32, "nightly-sweep graph", 15, HEAD, INK, "600")
text(GX + 190, GY + 31, "GREN · 13 NODES · ONE STRANDS GRAPH · BUDGET $3.00 / RUN", 11.5, UI, INK2, style="letter-spacing:.06em")
# legend
lx = GX + GW - 20
LY = GY + GH - 30
for label, col in reversed([("code", INK2), ("agent", PRIMARY), ("verifier", OK), ("human gate", AMBER)]):
    tw = 8 + len(label) * 6.6
    lx -= tw + 22
    out.append(f'<rect x="{lx}" y="{LY}" width="10" height="10" rx="2" fill="{col}"/>')
    text(lx + 15, LY + 10, label, 11.5, UI, INK2)

# nodes
for name, (c, r, kind, klabel, sub) in NODES.items():
    x, y = nbox(name)
    col = KIND[kind]
    stroke = ACCENT if kind == "gate" else LINE
    sw = 2 if kind == "gate" else 1.5
    out.append(f'<rect x="{x}" y="{y}" width="{NW}" height="{NH}" rx="12" fill="{SURF}" stroke="{stroke}" stroke-width="{sw}"/>')
    out.append(f'<path d="M{x + 1},{y + 12} a11,11 0 0 1 11,-11 h0 v60 h0 a11,11 0 0 1 -11,-11 z" fill="{col}" transform="translate(0,0)"/>')
    out.append(f'<rect x="{x + 1}" y="{y + 1}" width="6" height="{NH - 2}" rx="3" fill="{col}"/>')
    text(x + 16, y + 21, name, 13, HEAD, INK, "600")
    text(x + 16, y + 37, klabel.upper(), 9.5, UI, col, style="letter-spacing:.08em")
    text(x + 16, y + 53, sub, 11, UI, INK2)

# wires inside the graph
h_arrow("feeds_refresh", "candidate_gen")
h_arrow("expiry_scan", "warranty")
x1, y1 = right("expiry_scan"); x2, y2 = left("candidate_gen")
path(f"M{x1},{y1} C{x1 + 30},{y1} {x2 - 30},{y2 + 14} {x2 - 1},{y2 + 14}", INK2, 1.4)
h_arrow("candidate_gen", "matcher")
h_arrow("matcher", "verdicts")
x1, y1 = right("warranty"); x2, y2 = left("verdicts")
path(f"M{x1},{y1} C{x1 + 90},{y1} {x2 - 60},{y2 + 16} {x2 - 1},{y2 + 16}", INK2, 1.4)
h_arrow("verdicts", "triage")
h_arrow("triage", "severity_check")
h_arrow("severity_check", "household_decision", AMBER, "7 4", 2)
# severity_check -> digest (down)
x1, y1 = bottom("severity_check"); x2, y2 = top("digest")
path(f"M{x1},{y1} L{x2},{y2 - 1}", INK2)
# repair back-edge
x1, y1 = top("severity_check"); x2, y2 = top("triage")
path(f"M{x1 - 20},{y1} C{x1 - 40},{y1 - 34} {x2 + 40},{y2 - 34} {x2 + 20},{y2 - 1}", CRIT, 1.6, "4 3")
text((x1 + x2) / 2, y1 - 30, "repair ×1 · rejected plan", 10.5, UI, CRIT, anchor="middle")
# gate -> answers (down, dashed amber)
x1, y1 = bottom("household_decision"); x2, y2 = top("answers")
path(f"M{x1},{y1} L{x2},{y2 - 1}", AMBER, 2, "7 4")
text(x1 + 8, (y1 + y2) / 2 + 4, "the answer", 10.5, UI, AMBER)
text(x1 + 8, (y1 + y2) / 2 + 18, "resumes the run", 10.5, UI, AMBER)
# answers -> remedy -> followup (right to left)
x1, y1 = left("answers"); x2, y2 = right("remedy")
path(f"M{x1},{y1} L{x2 + 1},{y2}", INK2)
x1, y1 = left("remedy"); x2, y2 = right("followup")
path(f"M{x1},{y1} L{x2 + 1},{y2}", INK2)
# note inside the graph
lines(GX + 22, GY + 292, ["gren derives the edges from $nodes.* references. It enforces retries, timeouts,", "a quorum on fan-outs, and the spend cap. The run pauses on disk at the gate and", "resumes from the checkpoint. A quiet night skips every model node: zero calls."], 12.5, BODY, INK2, 18)

# inputs -> graph
path(f"M306,228 L{GX - 2},228", INK2)
path(f"M306,342 C330,342 320,{ROWY['B'] + 31} {COLX[0] - 12},{ROWY['B'] + 31} L{COLX[0] - 1},{ROWY['B'] + 31}", INK2, 1.4)

# ---- store / api / dashboard
SY = 600
box(330, SY, 380, 92, "Household store", ["items · recalls · matches · decisions · activity ·", "sweeps · outbox. One JSON file per entity", "(DynamoDB-shaped). Run store: state, events, artifacts."])
box(760, SY, 340, 92, "Guardian API", ["FastAPI + SSE. Surfaces gate decisions, records", "answers, resumes the graph. Mounts the gren run", "API at /gren. Token-gated actions."])
box(1150, SY, 396, 92, "Dashboard", ["Vite + React. Home · Decisions · Inventory · Activity ·", "Settings · Agent flow: the gren trace workbench (graph,", "timeline, events, metrics, gate, inspector, fork)."])
path(f"M520,{GY + GH} L520,{SY - 1}", INK2)          # graph -> store
path(f"M180,476 L180,646 L329,646", INK2)              # intake -> store
path(f"M710,646 L759,646", INK2)                       # store -> api
path(f"M1100,646 L1149,646", INK2)                     # api -> dashboard

# household / manufacturer
box(1300, 722, 246, 54, "Household", ["SMS link · dashboard · one decision, one tap"], border=AMBER, bw=2, title_size=14, rows_size=11.5)
box(1300, 790, 246, 54, "Manufacturer", ["remedy request by email (SES), receipt attached"], border=PRIMARY, title_size=14, rows_size=11.5)
gx, gy = right("household_decision")
path(f"M{gx},{gy} L1578,{gy} L1578,749 L1547,749", AMBER, 2, "7 4")
fx, fy = bottom("followup")
path(f"M{fx},{fy} L{fx},817 L1299,817", PRIMARY, 1.8)
text(1125, 815, "email", 10.5, UI, PRIMARY, anchor="end")

# ---- AWS band
AY = 852
out.append(f'<rect x="54" y="{AY}" width="1492" height="122" rx="16" fill="{SURF}" stroke="{LINE}" stroke-width="1.5"/>')
text(74, AY + 22, "AWS", 12, UI, INK2, style="letter-spacing:.12em")
cells = [
    ("Amazon Bedrock", ["Claude Haiku 4.5, Sonnet 5, Opus 5", "through global inference profiles.", "Structured output on every agent node."], None),
    ("Amazon S3", ["State bucket: the household store and", "the run store mirror after each change;", "releases and config."], None),
    ("Amazon SES", ["Sends the remedy request with the", "receipt attached. Outbox until the", "sender identity is verified."], None),
    ("Amazon EC2 + Caddy", ["One instance, automatic HTTPS, systemd", "timer at 06:00 UTC, deployed by", "scripts/deploy_ec2.py."], ("LIVE", ACCENT, INK)),
    ("Bedrock AgentCore", ["Runtime entrypoint built and tested", "locally. Deploys when the account", "quotas allow."], ("NEXT", TINT, INK2)),
    ("Strands Agents SDK", ["Every node is a Strands executor. Gates", "are Strands interrupts. The run resumes", "from the checkpoint."], None),
]
for i, (title, rows, pill) in enumerate(cells):
    cx = 74 + i * 246
    text(cx, AY + 52, title, 14, HEAD, INK, "600")
    if pill:
        px = cx + len(title) * 8.2 + 10
        out.append(f'<rect x="{px}" y="{AY + 40}" width="{len(pill[0]) * 7.5 + 14}" height="16" rx="8" fill="{pill[1]}"/>')
        text(px + 7, AY + 52, pill[0], 9.5, UI, pill[2], style="letter-spacing:.08em")
    lines(cx, AY + 72, rows, 11.5, BODY, INK2, 16)
# connectors to AWS
path(f"M{GX},500 L150,500 L150,{AY - 1}", PRIMARY, 1.5, "4 4")   # agents -> bedrock
path(f"M520,692 L520,{AY - 1}", INK2, 1.5, "4 4")                                # store -> s3
path(f"M1000,692 L1000,{AY - 1}", INK2, 1.5, "4 4")                              # api -> ec2
text(158, 640, "model calls", 10.5, UI, PRIMARY)
text(528, 760, "state mirror", 10.5, UI, INK2)
text(1008, 760, "hosts API + dashboard", 10.5, UI, INK2)
text(54, 992, "github.com/KrishGup/Recall-and-Warranty-Guardian · Agents for Humans hackathon · Everyday Agents track", 11.5, UI, INK2)
out.append("</svg>")

html = f"""<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Roboto+Slab:wght@400;600;700&family=Lora:ital,wght@0,400;0,500;1,400&family=Habibi&display=swap" rel="stylesheet">
<style>html,body{{margin:0;background:{PAPER}}}</style></head><body>{''.join(out)}</body></html>"""
with open(os.path.join(HERE, "architecture.html"), "w", encoding="utf-8") as f:
    f.write(html)
print("architecture.html written")
