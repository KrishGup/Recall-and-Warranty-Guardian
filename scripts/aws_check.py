"""Check every AWS-side prerequisite from docs/AWS_SETUP.md with the credentials in .env (or the environment).

    .venv/Scripts/python scripts/aws_check.py            # prints one line per check: OK / MISSING / ERROR

Read-only except for one tiny Bedrock call (a few tokens on the cheapest model) that proves model access is granted."""
from __future__ import annotations

import json
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from guardian import load_env_file  # noqa: E402

loaded = load_env_file(os.path.join(ROOT, ".env"))

try:
    import boto3
    from botocore.exceptions import BotoCoreError, ClientError, NoCredentialsError
except ImportError:
    print("boto3 is not installed: run  .venv/Scripts/python -m pip install -e \".[aws]\"")
    sys.exit(2)

results: list[tuple[str, str, str]] = []


def rec(name: str, status: str, detail: str = "") -> None:
    results.append((name, status, detail))
    print(f"  {status:8s} {name}" + (f"  {detail}" if detail else ""), flush=True)


def main() -> int:
    print(f"env: loaded {len(loaded)} variable(s) from .env" if loaded else "env: no .env loaded (using the process environment)")
    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
    rec("AWS_REGION", "OK" if region else "MISSING", region or "set AWS_REGION in .env (us-east-1 or us-west-2)")
    region = region or "us-east-1"
    session = boto3.session.Session(region_name=region)

    # ---- identity
    try:
        ident = session.client("sts").get_caller_identity()
        rec("credentials", "OK", f"account {ident['Account']} · {ident['Arn']}")
    except NoCredentialsError:
        rec("credentials", "MISSING", "no AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, profile or SSO session")
        summary()
        return 1
    except (ClientError, BotoCoreError) as e:
        rec("credentials", "ERROR", str(e)[:200])
        summary()
        return 1

    # ---- Bedrock: model access + a tiny live call
    profiles: dict[str, str] = {}
    try:
        br = session.client("bedrock")
        page = br.list_inference_profiles(typeEquals="SYSTEM_DEFINED", maxResults=100)
        for p in page.get("inferenceProfileSummaries", []):
            pid = p.get("inferenceProfileId", "")
            for alias, needle in (("haiku", "haiku-4-5"), ("sonnet", "sonnet-5"), ("opus", "opus-5")):
                if needle in pid and (alias not in profiles or pid.startswith("global.")):
                    profiles[alias] = pid
        if profiles:
            rec("bedrock inference profiles", "OK", " · ".join(f"{k}={v}" for k, v in profiles.items()))
        else:
            rec("bedrock inference profiles", "MISSING", "no Claude Haiku 4.5 / Sonnet 5 / Opus 5 profiles listed in this region")
    except (ClientError, BotoCoreError) as e:
        rec("bedrock inference profiles", "ERROR", str(e)[:200])
    model = os.environ.get("GREN_BEDROCK_HAIKU") or profiles.get("haiku")
    if model:
        try:
            rt = session.client("bedrock-runtime")
            t0 = time.time()
            out = rt.converse(modelId=model, messages=[{"role": "user", "content": [{"text": "Reply with the single word: ok"}]}], inferenceConfig={"maxTokens": 8})
            text = "".join(c.get("text", "") for c in out["output"]["message"]["content"])
            rec("bedrock live call", "OK", f"{model} answered {text.strip()!r} in {time.time() - t0:.1f}s")
        except ClientError as e:
            code = e.response.get("Error", {}).get("Code", "")
            hint = " → request model access in the Bedrock console (Model access → Anthropic)" if code in ("AccessDeniedException",) else ""
            rec("bedrock live call", "ERROR", f"{code}: {str(e)[:160]}{hint}")
        except BotoCoreError as e:
            rec("bedrock live call", "ERROR", str(e)[:200])
    else:
        rec("bedrock live call", "MISSING", "no Haiku profile found; set GREN_BEDROCK_HAIKU")

    # ---- SES
    try:
        sesv2 = session.client("sesv2")
        acct = sesv2.get_account()
        prod = bool(acct.get("ProductionAccessEnabled"))
        sender = os.environ.get("GUARDIAN_SES_FROM")
        idents = {i["IdentityName"]: i for i in sesv2.list_email_identities(PageSize=100).get("EmailIdentities", [])}
        verified = [n for n, i in idents.items() if i.get("VerificationStatus") == "SUCCESS" or i.get("VerifiedForSendingStatus")]
        rec("ses account", "OK", f"{'production' if prod else 'SANDBOX (recipients must be verified identities too)'} · verified identities: {', '.join(verified) or 'none'}")
        if sender:
            ok = sender in verified or any(sender.endswith("@" + d) for d in verified)
            rec("GUARDIAN_SES_FROM", "OK" if ok else "MISSING", sender if ok else f"{sender} is not a verified identity in {region}")
        else:
            rec("GUARDIAN_SES_FROM", "MISSING", "optional: set it to a verified sender to send real email")
    except (ClientError, BotoCoreError) as e:
        rec("ses account", "ERROR", str(e)[:200])

    # ---- SNS SMS
    try:
        sns = session.client("sns")
        sandbox = sns.get_sms_sandbox_account_status().get("IsInSandbox")
        nums = sns.list_origination_numbers(MaxResults=30).get("PhoneNumbers", [])
        rec("sns sms", "OK", f"{'sandbox' if sandbox else 'production'} · origination numbers: {len(nums)}" + ("" if nums else " (US SMS needs a registered toll-free or 10DLC number; the outbox is the fallback)"))
    except (ClientError, BotoCoreError) as e:
        rec("sns sms", "ERROR", str(e)[:200])

    # ---- S3 (optional, for the evidence locker / store sync)
    bucket = os.environ.get("GUARDIAN_S3_BUCKET")
    if bucket:
        try:
            session.client("s3").head_bucket(Bucket=bucket)
            rec("GUARDIAN_S3_BUCKET", "OK", bucket)
        except (ClientError, BotoCoreError) as e:
            rec("GUARDIAN_S3_BUCKET", "ERROR", f"{bucket}: {str(e)[:120]}")
    else:
        rec("GUARDIAN_S3_BUCKET", "MISSING", "optional until the store moves off the local disk")

    # ---- AgentCore control plane permissions
    try:
        ac = session.client("bedrock-agentcore-control")
        rts = ac.list_agent_runtimes(maxResults=20).get("agentRuntimes", [])
        rec("agentcore control plane", "OK", f"{len(rts)} runtime(s) in {region}" + (": " + ", ".join(r.get("agentRuntimeName", "?") for r in rts) if rts else ""))
    except (ClientError, BotoCoreError) as e:
        code = getattr(e, "response", {}).get("Error", {}).get("Code", "") if hasattr(e, "response") else ""
        rec("agentcore control plane", "ERROR", f"{code or e.__class__.__name__}: {str(e)[:140]}")
    except Exception as e:  # noqa: BLE001
        rec("agentcore control plane", "ERROR", f"{e.__class__.__name__}: {str(e)[:140]} (boto3 too old for bedrock-agentcore-control?)")

    # ---- what gren will pick
    try:
        from gren.models.registry import ModelRegistry, default_bridge

        b = default_bridge()
        ok, why = ModelRegistry().available("bedrock")
        rec("gren default provider", "OK" if b.name == "bedrock" else "MISSING", f"{b.name} ({b.source}); bedrock available: {ok} ({why})")
    except Exception as e:  # noqa: BLE001
        rec("gren default provider", "ERROR", str(e)[:160])

    if profiles:
        print("\nSuggested .env lines (only if they differ from gren's defaults):")
        for alias, pid in profiles.items():
            print(f"  GREN_BEDROCK_{alias.upper()}={pid}")
    summary()
    return 0 if all(s != "ERROR" for _, s, _ in results) else 1


def summary() -> None:
    n_ok = sum(1 for _, s, _ in results if s == "OK")
    print(f"\n{n_ok}/{len(results)} OK · {sum(1 for _, s, _ in results if s == 'MISSING')} missing · {sum(1 for _, s, _ in results if s == 'ERROR')} errors")
    if os.environ.get("GUARDIAN_CHECK_JSON"):
        print(json.dumps([{"check": n, "status": s, "detail": d} for n, s, d in results], indent=1))


if __name__ == "__main__":
    sys.exit(main())
