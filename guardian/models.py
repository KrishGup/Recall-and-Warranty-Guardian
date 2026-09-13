"""Guardian entities. The household store persists these as JSON; the gren graphs exchange the LLM-facing
shapes (MatchVerdict, CoverageAssessment, SurfacePlan, ActionReport) whose JSON schemas live in the graph YAML.
`tests/test_schemas.py` keeps the YAML schemas and these models in step."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, Field

Category = Literal["Juvenile", "Kitchen", "Appliance", "Vehicle", "Tools", "Food", "Electronics", "Toys", "Home", "Other"]
CATEGORIES: tuple[str, ...] = ("Juvenile", "Kitchen", "Appliance", "Vehicle", "Tools", "Food", "Electronics", "Toys", "Home", "Other")
Severity = Literal["critical", "standard"]
Source = Literal["cpsc", "nhtsa", "fda_food", "fda_drug", "fda_device"]
SOURCE_LABEL = {"cpsc": "CPSC", "nhtsa": "NHTSA", "fda_food": "openFDA", "fda_drug": "openFDA", "fda_device": "openFDA"}


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{datetime.now(timezone.utc).microsecond // 1000:03d}Z"


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:10]}"


class Warranty(BaseModel):
    term_months: int | None = None
    ends_on: str | None = None
    source: Literal["receipt", "category_default", "manufacturer", "none"] = "none"
    extended: bool = False


class Vehicle(BaseModel):
    vin: str
    year: int
    make: str
    model: str
    trim: str | None = None


class InventoryItem(BaseModel):
    id: str = Field(default_factory=lambda: new_id("itm"))
    name: str
    brand: str = ""
    model_number: str | None = None
    upc: str | None = None
    serial: str | None = None
    category: Category = "Other"
    purchase_date: str
    price: float | None = None
    currency: str = "USD"
    retailer: str | None = None
    receipt_ref: str | None = None
    receipt_text: str | None = None
    warranty: Warranty = Field(default_factory=Warranty)
    vehicle: Vehicle | None = None
    status: Literal["watched", "resolved", "disposed"] = "watched"
    sweeps: int = 0
    source: Literal["manual", "csv", "intake", "seed"] = "manual"
    created_at: str = Field(default_factory=now_iso)
    notes: str | None = None


class RecallProduct(BaseModel):
    name: str
    brand: str | None = None
    model_numbers: list[str] = Field(default_factory=list)
    upcs: list[str] = Field(default_factory=list)
    lot_codes: list[str] = Field(default_factory=list)
    sold_from: str | None = None  # YYYY-MM
    sold_to: str | None = None
    retailers: list[str] = Field(default_factory=list)
    units: str | None = None


class RecallContact(BaseModel):
    phone: str | None = None
    email: str | None = None
    url: str | None = None
    text: str | None = None


class RecallRecord(BaseModel):
    recall_id: str  # "cpsc#26530" | "nhtsa#19V493000" | "fda_food#H-1166-2026"
    source: Source
    native_id: str
    title: str
    published_at: str  # YYYY-MM-DD
    url: str | None = None
    products: list[RecallProduct] = Field(default_factory=list)
    hazard_text: str = ""
    remedy_text: str = ""
    severity: Severity = "standard"
    severity_reasons: list[str] = Field(default_factory=list)
    contact: RecallContact = Field(default_factory=RecallContact)
    description: str = ""
    vehicle_key: str | None = None  # "subaru|outback|2019"
    flags: dict[str, Any] = Field(default_factory=dict)
    fetched_at: str = Field(default_factory=now_iso)

    @property
    def source_label(self) -> str:
        return SOURCE_LABEL[self.source]

    def all_upcs(self) -> list[str]:
        return [u for p in self.products for u in p.upcs]

    def all_models(self) -> list[str]:
        return [m for p in self.products for m in p.model_numbers]

    def sold_window(self) -> tuple[str | None, str | None]:
        froms = [p.sold_from for p in self.products if p.sold_from]
        tos = [p.sold_to for p in self.products if p.sold_to]
        return (min(froms) if froms else None, max(tos) if tos else None)


class MatchCandidate(BaseModel):
    id: str  # "<item_id>~<recall_id>"
    item_id: str
    recall_id: str
    stage: int  # 1 exact key, 2 lexical, 3 date window, 4 LLM adjudication
    key: str
    score: float
    verdict: Literal["certain", "yes", "no", "unsure", "dropped", "pending"] = "pending"
    confidence: float | None = None
    rationale: str = ""
    missing_info: list[str] = Field(default_factory=list)
    state: Literal["open", "surfaced", "closed"] = "open"
    severity: Severity = "standard"
    run_id: str | None = None
    created_at: str = Field(default_factory=now_iso)
    updated_at: str = Field(default_factory=now_iso)


# ---- LLM-facing structured outputs (mirrored as JSON schemas in guardian/graphs/*.yaml) ----


class MatchVerdict(BaseModel):
    match_id: str
    is_match: Literal["yes", "no", "unsure"]
    confidence: float = Field(ge=0, le=1)
    rationale: str
    missing_info: list[str] = Field(default_factory=list)


class CoverageAssessment(BaseModel):
    item_id: str
    covered: bool
    ask: bool
    question: str
    ask_on: str
    reason: str


class SurfaceDecision(BaseModel):
    kind: Literal["recall_remedy", "warranty_checkin"]
    match_id: str | None = None
    item_id: str
    recall_id: str | None = None
    severity: Severity
    headline: str
    message: str
    remedy_label: str


class DigestLine(BaseModel):
    match_id: str | None = None
    item_id: str
    recall_id: str | None = None
    line: str


class QueuedQuestion(BaseModel):
    item_id: str
    ask_on: str
    reason: str


class SurfacePlan(BaseModel):
    channel: Literal["sms_now", "digest", "none"]
    severity: Severity
    decisions: list[SurfaceDecision] = Field(default_factory=list)
    digest: list[DigestLine] = Field(default_factory=list)
    digest_count: int = 0
    queued: list[QueuedQuestion] = Field(default_factory=list)
    rationale: str = ""


class ActionReport(BaseModel):
    decision_id: str
    item_id: str
    recall_id: str | None = None
    type: Literal["email_remedy_request", "email_warranty_claim", "phone_script", "discard_checklist"]
    to: str | None = None
    subject: str
    body: str
    attachments: list[str] = Field(default_factory=list)
    next_check_days: int = 10


# ---- Guardian-level records ----

DecisionChoice = Literal["request_remedy", "no_longer_own", "not_mine", "snooze", "fine", "report_problem", "done"]


class DecisionOption(BaseModel):
    key: DecisionChoice
    label: str
    style: Literal["critical", "primary", "outline", "text"]


class Decision(BaseModel):
    id: str = Field(default_factory=lambda: new_id("dec"))
    kind: Literal["recall_remedy", "warranty_checkin", "advisory"]
    severity: Severity
    state: Literal["pending", "answered", "expired", "snoozed"] = "pending"
    created_at: str = Field(default_factory=now_iso)
    expires_at: str | None = None
    run_id: str | None = None
    gate: str | None = None
    plan_index: int = 0
    item_id: str | None = None
    item_name: str = ""
    match_id: str | None = None
    recall_id: str | None = None
    headline: str = ""
    summary: str = ""
    message: str = ""
    remedy_label: str = ""
    options: list[DecisionOption] = Field(default_factory=list)
    answer: dict[str, Any] | None = None  # {choice, by, at, comment}
    outcome: dict[str, Any] | None = None  # {title, subtitle, steps[]}
    snooze_until: str | None = None
    action: dict[str, Any] | None = None  # ActionReport after remedy ran
    notified: dict[str, Any] | None = None  # {channel, to, at, outbox}


class Activity(BaseModel):
    id: str = Field(default_factory=lambda: new_id("act"))
    at: str = Field(default_factory=now_iso)
    source: str = "Guardian"  # CPSC | NHTSA | FDA | Triage | Intake | Warranty | Remedy | Household | Guardian | Matcher | Verifier
    text: str
    result: str | None = None
    tone: Literal["ok", "critical", "muted", "warn"] = "muted"
    run_id: str | None = None
    item_id: str | None = None
    decision_id: str | None = None


class Sensitivities(BaseModel):
    infant: bool = False
    pregnancy: bool = False
    elderly: bool = False
    allergens: list[str] = Field(default_factory=list)


class Preferences(BaseModel):
    budget: Literal["critical_only", "weekly", "daily"] = "weekly"
    value_threshold: float = 200
    quiet_categories: list[str] = Field(default_factory=lambda: ["Kitchen", "Tools"])
    phone: str = ""
    forwarding_address: str = "receipts@guardian.house"
    sensitivities: Sensitivities = Field(default_factory=Sensitivities)
    auto_request_standard: bool = False


class Household(BaseModel):
    id: str = "hh_default"
    name: str = "Home"
    created_at: str = Field(default_factory=now_iso)
    timezone: str = "local"


class SweepRecord(BaseModel):
    run_id: str
    started_at: str
    ended_at: str | None = None
    status: str = "running"
    summary: str = ""
    cost_usd: float = 0.0
    recalls_pulled: int = 0
    certain: int = 0
    candidates: int = 0
    surfaced: int = 0
    bridge: str = ""
