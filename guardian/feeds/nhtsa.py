"""NHTSA: vPIC VIN decoding and recalls by vehicle (make, model, model year). No key.

A campaign returned for make/model/year applies to "certain" vehicles of that description; only a VIN-level lookup on
nhtsa.gov confirms one vehicle. Guardian therefore reports these as matches for the vehicle class and says so."""
from __future__ import annotations

import re
from typing import Any

from ..models import RecallContact, RecallProduct, RecallRecord, Vehicle
from ..policy.severity import classify
from .http import fixtures_mode, get_json, load_fixture

VPIC = "https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/{vin}"
RECALLS = "https://api.nhtsa.gov/recalls/recallsByVehicle"
_PHONE = re.compile(r"1-\d{3}-\d{3}-\d{4}|\(\d{3}\)\s?\d{3}-\d{4}")


def vehicle_key(make: str, model: str, year: int | str) -> str:
    return f"{str(make).strip().lower()}|{str(model).strip().lower()}|{year}"


def decode_vin(vin: str) -> Vehicle:
    vin = vin.strip().upper()
    if fixtures_mode():
        r = load_fixture("vpic_outback.json")
    else:
        data = get_json(VPIC.format(vin=vin), {"format": "json"})
        r = (data.get("Results") or [{}])[0]
    if not r.get("Make") or not r.get("ModelYear"):
        raise ValueError(f"vPIC could not decode VIN {vin}: {r.get('ErrorText')}")
    return Vehicle(vin=vin, year=int(r["ModelYear"]), make=str(r["Make"]).title(), model=str(r.get("Model") or "").strip(), trim=(r.get("Trim") or None))


def fetch_campaigns(make: str, model: str, year: int) -> list[dict[str, Any]]:
    if fixtures_mode():
        fx = load_fixture("nhtsa_subaru_outback_2019.json")
        if vehicle_key(make, model, year) == vehicle_key("subaru", "outback", 2019):
            return list(fx.get("results") or [])
        return []
    data = get_json(RECALLS, {"make": make, "model": model, "modelYear": year})
    return list(data.get("results") or [])


def _date(s: str | None) -> str:
    # NHTSA dates are DD/MM/YYYY
    m = re.match(r"(\d{2})/(\d{2})/(\d{4})", s or "")
    return f"{m.group(3)}-{m.group(2)}-{m.group(1)}" if m else ""


def normalize(raw: dict[str, Any], vehicle: Vehicle) -> RecallRecord:
    campaign = str(raw.get("NHTSACampaignNumber") or "")
    hazard = (raw.get("Consequence") or "").strip()
    remedy = (raw.get("Remedy") or "").strip()
    flags = {"parkIt": bool(raw.get("parkIt")), "parkOutSide": bool(raw.get("parkOutSide")), "overTheAirUpdate": bool(raw.get("overTheAirUpdate")), "component": raw.get("Component")}
    severity, reasons = classify(hazard, "nhtsa", flags)
    name = f"{vehicle.year} {vehicle.make} {vehicle.model}"
    phone = _PHONE.search(remedy)
    return RecallRecord(
        recall_id=f"nhtsa#{campaign}", source="nhtsa", native_id=campaign, title=f"{raw.get('Component') or 'Safety recall'}: {name} ({raw.get('Manufacturer') or 'manufacturer'})".strip(),
        published_at=_date(raw.get("ReportReceivedDate")), url=f"https://www.nhtsa.gov/recalls?nhtsaId={campaign}",
        products=[RecallProduct(name=name, brand=vehicle.make, model_numbers=[vehicle.model], retailers=[])],
        hazard_text=hazard, remedy_text=remedy, severity=severity, severity_reasons=reasons,
        contact=RecallContact(phone=phone.group(0) if phone else None, url="https://www.nhtsa.gov/recalls", text=(raw.get("Notes") or "").strip() or None),
        description=(raw.get("Summary") or "").strip(), vehicle_key=vehicle_key(vehicle.make, vehicle.model, vehicle.year), flags=flags,
    )
