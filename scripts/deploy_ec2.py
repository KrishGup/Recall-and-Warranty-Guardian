"""Deploy Guardian to one EC2 instance with a public HTTPS URL. No AgentCore quota, no Docker, no domain needed.

    python scripts/deploy_ec2.py up          build the dashboard, upload a release, create role + security group + elastic
                                             IP + instance (Amazon Linux 2023, t3.small), wait until https answers
    python scripts/deploy_ec2.py update      build + upload a new release and reinstall it on the running instance
    python scripts/deploy_ec2.py status      instance state, URL, health, provider
    python scripts/deploy_ec2.py logs        bootstrap log + service journal (through SSM, no SSH key needed)
    python scripts/deploy_ec2.py run "<sh>"  run a shell command on the instance as root (SSM Run Command)
    python scripts/deploy_ec2.py down --yes  terminate the instance, release the address, delete the group and role

What it builds (all tagged Project=guardian, region from AWS_REGION, credentials from the AWS_PROFILE in .env):
  IAM role guardian-ec2         Bedrock invoke, the state bucket, SES send, SSM (for logs/updates without SSH)
  security group guardian-web   80 and 443 open to the world; nothing else (no SSH: SSM is the door)
  elastic IP                    a stable address; the hostname is guardian.<ip-with-dashes>.sslip.io
  the instance                  user-data downloads the release from S3 and runs deploy/ec2/install.sh, which installs
                                python + Caddy (automatic TLS) + systemd units, seeds the demo household once, and
                                schedules the nightly sweep at 06:00 UTC
  the runtime environment       written to s3://<state bucket>/config/env from your .env (model ids, budget, SES,
                                the API token that gates every action on the public dashboard)
Afterwards .env carries GUARDIAN_URL and GUARDIAN_API_TOKEN; open GUARDIAN_URL/?token=<token> once in a browser."""
from __future__ import annotations

import base64
import json
import os
import secrets
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import zipfile
from typing import Any

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import guardian  # noqa: E402,F401  (loads .env: AWS_PROFILE, AWS_REGION, GUARDIAN_S3_BUCKET, model ids, budget)

NAME = "guardian"
ROLE = "guardian-ec2"
SG = "guardian-web"
TAGS = [{"Key": "Name", "Value": NAME}, {"Key": "Project", "Value": NAME}]
RELEASE_INCLUDE = ["pyproject.toml", "README.md", "LICENSE", "guardian", "gren/pyproject.toml", "gren/README.md", "gren/CHANGELOG.md", "gren/gren", "demo", "web/dist", "deploy/ec2"]
EXCLUDE_DIRS = {"__pycache__", ".pytest_cache", "tests", ".venv", "node_modules", ".git"}
EXCLUDE_SUFFIX = (".pyc", ".pyo", ".log", ".zip")
ENV_PATH = os.path.join(ROOT, ".env")


def say(msg: str) -> None:
    print(msg, flush=True)


def region() -> str:
    return os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-1"


def session():
    import boto3  # type: ignore

    return boto3.session.Session(profile_name=os.environ.get("AWS_PROFILE") or None, region_name=region())


def bucket() -> str:
    b = os.environ.get("GUARDIAN_S3_BUCKET", "").strip()
    if not b:
        sys.exit("GUARDIAN_S3_BUCKET is not set (.env); create the private state bucket first: aws s3 mb s3://guardian-<account>-state")
    return b


# ----------------------------------------------------------------------------------------------- local .env
def set_env_line(key: str, value: str) -> None:
    """Upsert KEY=value in the repository's .env (gitignored) so later commands and the dashboard know the deployment."""
    lines = open(ENV_PATH, encoding="utf-8").read().splitlines() if os.path.isfile(ENV_PATH) else []
    out, done = [], False
    for ln in lines:
        if ln.split("=", 1)[0].strip() == key:
            out.append(f"{key}={value}")
            done = True
        else:
            out.append(ln)
    if not done:
        out.append(f"{key}={value}")
    with open(ENV_PATH, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(out) + "\n")
    os.environ[key] = value


def api_token() -> str:
    tok = os.environ.get("GUARDIAN_API_TOKEN", "").strip()
    if not tok:
        tok = secrets.token_urlsafe(24)
        set_env_line("GUARDIAN_API_TOKEN", tok)
        say("generated GUARDIAN_API_TOKEN into .env")
    return tok


def runtime_env(host: str, token: str) -> str:
    e = os.environ
    pairs = [
        ("GUARDIAN_ENV_FILE", ""),
        ("GUARDIAN_DATA", "/var/lib/guardian/household"),
        ("GUARDIAN_RUNS", "/var/lib/guardian/runs"),
        ("GUARDIAN_FEEDS", e.get("GUARDIAN_DEPLOY_FEEDS", "live")),
        ("GREN_BRIDGE", e.get("GUARDIAN_DEPLOY_BRIDGE", "bedrock")),
        ("ANTHROPIC_API_KEY", e.get("ANTHROPIC_API_KEY", "")),  # only used when GUARDIAN_DEPLOY_BRIDGE=anthropic
        ("ANTHROPIC_BASE_URL", e.get("ANTHROPIC_BASE_URL", "")),  # a custom endpoint or gateway; the SDK reads it
        ("ANTHROPIC_AUTH_TOKEN", e.get("ANTHROPIC_AUTH_TOKEN", "")),  # bearer auth for gateways that use it
        ("AWS_REGION", region()),
        ("AWS_DEFAULT_REGION", region()),
        ("GREN_BEDROCK_HAIKU", e.get("GREN_BEDROCK_HAIKU", "")),
        ("GREN_BEDROCK_SONNET", e.get("GREN_BEDROCK_SONNET", "")),
        ("GREN_BEDROCK_OPUS", e.get("GREN_BEDROCK_OPUS", "")),
        ("GUARDIAN_DAILY_BUDGET_USD", e.get("GUARDIAN_DAILY_BUDGET_USD", "10")),
        ("TZ", e.get("GUARDIAN_DEPLOY_TZ", "America/New_York")),  # the household's clock: activity times, "today", the 08:00 snooze
        ("GUARDIAN_API_TOKEN", token),
        ("GUARDIAN_S3_BUCKET", bucket()),
        ("GUARDIAN_S3_PREFIX", e.get("GUARDIAN_S3_PREFIX", "guardian")),
        ("GUARDIAN_STATE_SYNC", "1"),
        ("GUARDIAN_SES_FROM", e.get("GUARDIAN_SES_FROM", "")),
        ("GUARDIAN_SES_TO_OVERRIDE", e.get("GUARDIAN_SES_TO_OVERRIDE", "")),
        ("GUARDIAN_PUBLIC_URL", f"https://{host}"),
        ("PYTHONUTF8", "1"),
    ]
    return "".join(f"{k}={v}\n" for k, v in pairs if v != "" or k in ("GUARDIAN_ENV_FILE",))


# ----------------------------------------------------------------------------------------------- release
def build_release() -> str:
    web = os.path.join(ROOT, "web")
    if not os.path.isdir(os.path.join(web, "node_modules")):
        say("npm ci (web)")
        subprocess.run("npm ci --no-audit --no-fund", cwd=web, shell=True, check=True)
    say("npm run build (web)")
    subprocess.run("npm run build", cwd=web, shell=True, check=True)
    out_dir = os.path.join(ROOT, "var", "release")
    os.makedirs(out_dir, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    path = os.path.join(out_dir, f"guardian-{stamp}.zip")
    files = 0
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for rel in RELEASE_INCLUDE:
            src = os.path.join(ROOT, rel)
            if os.path.isfile(src):
                z.write(src, rel)
                files += 1
                continue
            if not os.path.isdir(src):
                sys.exit(f"missing {rel} (build the dashboard first?)")
            for dirpath, dirnames, filenames in os.walk(src):
                dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
                for fn in filenames:
                    if fn.endswith(EXCLUDE_SUFFIX):
                        continue
                    full = os.path.join(dirpath, fn)
                    z.write(full, os.path.relpath(full, ROOT).replace(os.sep, "/"))
                    files += 1
    say(f"release {os.path.relpath(path, ROOT)}: {files} files, {os.path.getsize(path) / 1024 / 1024:.1f} MB")
    return path


def upload_release(s3, path: str, host: str, token: str) -> str:
    b = bucket()
    key = f"releases/{os.path.basename(path)}"
    s3.upload_file(path, b, key)
    s3.copy_object(Bucket=b, CopySource={"Bucket": b, "Key": key}, Key="releases/latest.zip")
    s3.put_object(Bucket=b, Key="config/env", Body=runtime_env(host, token).encode("utf-8"), ContentType="text/plain")
    say(f"uploaded s3://{b}/{key} (+ releases/latest.zip, config/env)")
    return key


def fetch_and_install(host: str) -> str:
    """The shell that turns a bare instance (or a running one) into the current release. Used by user-data and update."""
    return f"""export GUARDIAN_BUCKET={bucket()} GUARDIAN_HOST={host} AWS_DEFAULT_REGION={region()}
mkdir -p /opt/guardian
aws s3 cp s3://{bucket()}/releases/latest.zip /opt/guardian/release.zip || exit 1
rm -rf /opt/guardian/app.new && mkdir -p /opt/guardian/app.new && python3 -m zipfile -e /opt/guardian/release.zip /opt/guardian/app.new || exit 1
bash /opt/guardian/app.new/deploy/ec2/install.sh
"""


def user_data(host: str) -> str:
    return "#!/bin/bash\nexec > >(tee -a /var/log/guardian-bootstrap.log) 2>&1\necho \"guardian bootstrap $(date -u +%FT%TZ)\"\n" + fetch_and_install(host) + "echo \"guardian bootstrap exit $? $(date -u +%FT%TZ)\"\n"


# ----------------------------------------------------------------------------------------------- aws resources
def ensure_role(iam) -> None:
    trust = {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Principal": {"Service": "ec2.amazonaws.com"}, "Action": "sts:AssumeRole"}]}
    b = bucket()
    policy = {
        "Version": "2012-10-17",
        "Statement": [
            {"Effect": "Allow", "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:Converse", "bedrock:ConverseStream", "bedrock:ListInferenceProfiles", "bedrock:GetInferenceProfile"], "Resource": "*"},
            {"Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": f"arn:aws:s3:::{b}"},
            {"Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], "Resource": f"arn:aws:s3:::{b}/*"},
            {"Effect": "Allow", "Action": ["ses:SendEmail", "ses:SendRawEmail"], "Resource": "*"},
        ],
    }
    try:
        iam.get_role(RoleName=ROLE)
    except iam.exceptions.NoSuchEntityException:
        iam.create_role(RoleName=ROLE, AssumeRolePolicyDocument=json.dumps(trust), Description="Guardian EC2 runtime: Bedrock, state bucket, SES, SSM", Tags=TAGS)
        say(f"created role {ROLE}")
    iam.attach_role_policy(RoleName=ROLE, PolicyArn="arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore")
    iam.put_role_policy(RoleName=ROLE, PolicyName="guardian-runtime", PolicyDocument=json.dumps(policy))
    try:
        prof = iam.get_instance_profile(InstanceProfileName=ROLE)["InstanceProfile"]
    except iam.exceptions.NoSuchEntityException:
        prof = iam.create_instance_profile(InstanceProfileName=ROLE, Tags=TAGS)["InstanceProfile"]
        say(f"created instance profile {ROLE}")
    if not any(r["RoleName"] == ROLE for r in prof.get("Roles", [])):
        iam.add_role_to_instance_profile(InstanceProfileName=ROLE, RoleName=ROLE)
        time.sleep(10)  # IAM propagation before run_instances sees the profile


def default_vpc(ec2) -> str:
    vpcs = ec2.describe_vpcs(Filters=[{"Name": "is-default", "Values": ["true"]}])["Vpcs"]
    if not vpcs:
        sys.exit("no default VPC in this region; create one (VPC console -> Actions -> Create default VPC) and rerun")
    return vpcs[0]["VpcId"]


def ensure_sg(ec2, vpc: str) -> str:
    found = ec2.describe_security_groups(Filters=[{"Name": "group-name", "Values": [SG]}, {"Name": "vpc-id", "Values": [vpc]}])["SecurityGroups"]
    if found:
        return found[0]["GroupId"]
    gid = ec2.create_security_group(GroupName=SG, Description="Guardian: HTTP/HTTPS from anywhere, nothing else", VpcId=vpc, TagSpecifications=[{"ResourceType": "security-group", "Tags": TAGS}])["GroupId"]
    perms = []
    for port in (80, 443):
        perms.append({"IpProtocol": "tcp", "FromPort": port, "ToPort": port, "IpRanges": [{"CidrIp": "0.0.0.0/0"}], "Ipv6Ranges": [{"CidrIpv6": "::/0"}]})
    ec2.authorize_security_group_ingress(GroupId=gid, IpPermissions=perms)
    say(f"created security group {SG} ({gid}): 80, 443 open")
    return gid


def latest_al2023(ec2) -> str:
    imgs = ec2.describe_images(Owners=["amazon"], Filters=[{"Name": "name", "Values": ["al2023-ami-2023*-x86_64"]}, {"Name": "state", "Values": ["available"]}, {"Name": "architecture", "Values": ["x86_64"]}])["Images"]
    imgs = [i for i in imgs if "minimal" not in i["Name"]]
    if not imgs:
        sys.exit("no Amazon Linux 2023 image found")
    best = max(imgs, key=lambda i: i["CreationDate"])
    return best["ImageId"]


def ensure_eip(ec2) -> dict[str, Any]:
    addrs = ec2.describe_addresses(Filters=[{"Name": "tag:Name", "Values": [NAME]}])["Addresses"]
    if addrs:
        return addrs[0]
    a = ec2.allocate_address(Domain="vpc", TagSpecifications=[{"ResourceType": "elastic-ip", "Tags": TAGS}])
    say(f"allocated elastic IP {a['PublicIp']}")
    return a


def hostname(ip: str) -> str:
    return f"guardian.{ip.replace('.', '-')}.{os.environ.get('GUARDIAN_WILDCARD_DNS', 'sslip.io')}"


def find_instance(ec2) -> dict[str, Any] | None:
    res = ec2.describe_instances(Filters=[{"Name": "tag:Name", "Values": [NAME]}, {"Name": "instance-state-name", "Values": ["pending", "running", "stopping", "stopped"]}])
    for r in res["Reservations"]:
        for i in r["Instances"]:
            return i
    return None


def launch(ec2, ami: str, sg: str, host: str) -> str:
    itype = os.environ.get("GUARDIAN_EC2_TYPE", "t3.small")
    kwargs = dict(
        ImageId=ami, InstanceType=itype, MinCount=1, MaxCount=1, IamInstanceProfile={"Name": ROLE}, SecurityGroupIds=[sg], UserData=user_data(host),
        MetadataOptions={"HttpTokens": "required", "HttpEndpoint": "enabled"},
        BlockDeviceMappings=[{"DeviceName": "/dev/xvda", "Ebs": {"VolumeSize": 20, "VolumeType": "gp3", "DeleteOnTermination": True}}],
        TagSpecifications=[{"ResourceType": "instance", "Tags": TAGS}, {"ResourceType": "volume", "Tags": TAGS}],
    )
    last: Exception | None = None
    for attempt in range(12):
        try:
            inst = ec2.run_instances(**kwargs)["Instances"][0]
            say(f"launched {inst['InstanceId']} ({itype}, {ami})")
            return inst["InstanceId"]
        except Exception as e:  # noqa: BLE001 - the instance profile takes a few seconds to propagate
            last = e
            if "Invalid IAM Instance Profile" in str(e) or "iamInstanceProfile" in str(e):
                time.sleep(5)
                continue
            raise
    raise RuntimeError(f"run_instances kept failing: {last}")


# ----------------------------------------------------------------------------------------------- ssm + http helpers
def ssm_run(ssm, instance_id: str, script: str, timeout_s: int = 1800, wait_agent_s: int = 300) -> tuple[str, str, str]:
    """Run a shell script as root on the instance; returns (status, stdout, stderr)."""
    deadline = time.time() + wait_agent_s
    while True:
        try:
            cmd = ssm.send_command(InstanceIds=[instance_id], DocumentName="AWS-RunShellScript", Parameters={"commands": [script], "executionTimeout": [str(timeout_s)]}, TimeoutSeconds=120)["Command"]
            break
        except Exception as e:  # noqa: BLE001 - InvalidInstanceId until the SSM agent registers
            if time.time() > deadline:
                raise
            if "InvalidInstanceId" in str(e):
                time.sleep(10)
                continue
            raise
    cid = cmd["CommandId"]
    time.sleep(2)
    while True:
        try:
            inv = ssm.get_command_invocation(CommandId=cid, InstanceId=instance_id)
        except ssm.exceptions.InvocationDoesNotExist:
            time.sleep(2)
            continue
        if inv["Status"] in ("Success", "Failed", "TimedOut", "Cancelled", "Undeliverable", "Terminated"):
            return inv["Status"], inv.get("StandardOutputContent", ""), inv.get("StandardErrorContent", "")
        time.sleep(3)


def http_json(url: str, timeout: int = 8) -> Any:
    with urllib.request.urlopen(url, timeout=timeout) as r:  # noqa: S310 - our own https endpoint
        return json.loads(r.read().decode("utf-8"))


def wait_healthy(host: str, minutes: int = 15) -> bool:
    url = f"https://{host}/api/health"
    say(f"waiting for {url} (bootstrap: packages, pip, certificate; usually 4-7 minutes)")
    t0 = time.time()
    last = ""
    while time.time() - t0 < minutes * 60:
        try:
            if http_json(url).get("ok"):
                say(f"healthy after {int(time.time() - t0)} s")
                return True
        except Exception as e:  # noqa: BLE001
            msg = e.__class__.__name__
            if msg != last:
                say(f"  … {msg} ({int(time.time() - t0)} s)")
                last = msg
        time.sleep(10)
    return False


def resolve(host: str, ip: str) -> None:
    try:
        got = socket.gethostbyname(host)
    except OSError as e:
        say(f"warning: {host} does not resolve here ({e}); a wildcard-DNS outage would block the certificate")
        return
    if got != ip:
        say(f"warning: {host} resolves to {got}, expected {ip}")


# ----------------------------------------------------------------------------------------------- commands
def cmd_up() -> int:
    s = session()
    ec2, iam, s3, ssm = s.client("ec2"), s.client("iam"), s.client("s3"), s.client("ssm")
    existing = find_instance(ec2)
    eip = ensure_eip(ec2)
    host = hostname(eip["PublicIp"])
    token = api_token()
    resolve(host, eip["PublicIp"])
    if existing:
        say(f"instance {existing['InstanceId']} is {existing['State']['Name']} already; use `update` for a new release or `down` first")
        set_env_line("GUARDIAN_URL", f"https://{host}")
        return 0
    ensure_role(iam)
    vpc = default_vpc(ec2)
    sg = ensure_sg(ec2, vpc)
    ami = latest_al2023(ec2)
    upload_release(s3, build_release(), host, token)
    iid = launch(ec2, ami, sg, host)
    ec2.get_waiter("instance_running").wait(InstanceIds=[iid])
    ec2.associate_address(AllocationId=eip["AllocationId"], InstanceId=iid)
    say(f"attached {eip['PublicIp']} -> {host}")
    set_env_line("GUARDIAN_URL", f"https://{host}")
    ok = wait_healthy(host)
    if not ok:
        say("not healthy yet; bootstrap log tail:")
        status, out, err = ssm_run(ssm, iid, "tail -n 40 /var/log/guardian-bootstrap.log; systemctl --no-pager status guardian caddy | head -40", timeout_s=60)
        say(out or err)
        return 1
    print_ready(host, token)
    return 0


def print_ready(host: str, token: str) -> None:
    say("")
    say(f"Guardian is live:  https://{host}")
    say(f"open once (sets the action cookie):  https://{host}/?token={token}")
    say(f"API actions:  curl -X POST -H 'Authorization: Bearer {token}' https://{host}/api/sweep")
    say("nightly sweep: 06:00 UTC (guardian-sweep.timer). Logs: python scripts/deploy_ec2.py logs")


def cmd_update() -> int:
    s = session()
    ec2, s3, ssm = s.client("ec2"), s.client("s3"), s.client("ssm")
    inst = find_instance(ec2)
    if not inst:
        say("no instance; run `up`")
        return 1
    eip = ensure_eip(ec2)
    host = hostname(eip["PublicIp"])
    token = api_token()
    upload_release(s3, build_release(), host, token)
    say("installing on the instance (pip is quick when nothing changed)")
    status, out, err = ssm_run(ssm, inst["InstanceId"], fetch_and_install(host))
    say(out[-4000:])
    if err.strip():
        say(err[-2000:])
    if status != "Success":
        say(f"install {status}")
        return 1
    ok = wait_healthy(host, minutes=3)
    if ok:
        print_ready(host, token)
    return 0 if ok else 1


def cmd_status() -> int:
    s = session()
    ec2 = s.client("ec2")
    inst = find_instance(ec2)
    addrs = ec2.describe_addresses(Filters=[{"Name": "tag:Name", "Values": [NAME]}])["Addresses"]
    if not inst and not addrs:
        say("nothing deployed")
        return 0
    if addrs:
        host = hostname(addrs[0]["PublicIp"])
        say(f"address: {addrs[0]['PublicIp']}  url: https://{host}  attached: {addrs[0].get('InstanceId') or 'no'}")
    if inst:
        say(f"instance: {inst['InstanceId']} {inst['State']['Name']} {inst['InstanceType']} launched {inst['LaunchTime']:%Y-%m-%d %H:%M} UTC")
    if addrs:
        try:
            h = http_json(f"https://{host}/api/health")
            summ = http_json(f"https://{host}/api/summary")
            say(f"health: ok  bridge: {h.get('bridge')}  provider: {json.dumps(summ.get('provider'))}  runtime: {json.dumps(summ.get('runtime'))}")
            say(f"items: {summ.get('items_watched')}  pending decisions: {summ.get('decisions_pending')}  agent: {summ.get('agent_status')}  last sweep: {json.dumps(summ.get('last_sweep'))[:300]}")
        except Exception as e:  # noqa: BLE001
            say(f"health: not answering ({e})")
    return 0


def cmd_logs(lines: int = 80) -> int:
    s = session()
    ec2, ssm = s.client("ec2"), s.client("ssm")
    inst = find_instance(ec2)
    if not inst:
        say("no instance")
        return 1
    script = f"echo '== bootstrap'; tail -n {lines} /var/log/guardian-bootstrap.log 2>/dev/null; echo; echo '== guardian.service'; journalctl -u guardian -n {lines} --no-pager; echo; echo '== caddy.service'; journalctl -u caddy -n 20 --no-pager; echo; echo '== sweep timer'; systemctl list-timers guardian-sweep.timer --no-pager"
    status, out, err = ssm_run(ssm, inst["InstanceId"], script, timeout_s=60)
    say(out or err)
    return 0 if status == "Success" else 1


def cmd_run(script: str) -> int:
    s = session()
    ec2, ssm = s.client("ec2"), s.client("ssm")
    inst = find_instance(ec2)
    if not inst:
        say("no instance")
        return 1
    status, out, err = ssm_run(ssm, inst["InstanceId"], script, timeout_s=600)
    say(out)
    if err.strip():
        say(err)
    say(f"[{status}]")
    return 0 if status == "Success" else 1


def cmd_down(yes: bool) -> int:
    if not yes:
        say("this terminates the instance, releases the elastic IP (the URL dies) and deletes the security group and role; rerun with --yes")
        return 1
    s = session()
    ec2, iam = s.client("ec2"), s.client("iam")
    inst = find_instance(ec2)
    if inst:
        ec2.terminate_instances(InstanceIds=[inst["InstanceId"]])
        say(f"terminating {inst['InstanceId']}")
        ec2.get_waiter("instance_terminated").wait(InstanceIds=[inst["InstanceId"]])
    for a in ec2.describe_addresses(Filters=[{"Name": "tag:Name", "Values": [NAME]}])["Addresses"]:
        ec2.release_address(AllocationId=a["AllocationId"])
        say(f"released {a['PublicIp']}")
    for g in ec2.describe_security_groups(Filters=[{"Name": "group-name", "Values": [SG]}])["SecurityGroups"]:
        for _ in range(12):
            try:
                ec2.delete_security_group(GroupId=g["GroupId"])
                say(f"deleted security group {g['GroupId']}")
                break
            except Exception:  # noqa: BLE001 - the ENI lingers a little after termination
                time.sleep(5)
    try:
        iam.remove_role_from_instance_profile(InstanceProfileName=ROLE, RoleName=ROLE)
    except Exception:  # noqa: BLE001
        pass
    for fn in (lambda: iam.delete_instance_profile(InstanceProfileName=ROLE), lambda: iam.delete_role_policy(RoleName=ROLE, PolicyName="guardian-runtime"),
               lambda: iam.detach_role_policy(RoleName=ROLE, PolicyArn="arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"), lambda: iam.delete_role(RoleName=ROLE)):
        try:
            fn()
        except Exception:  # noqa: BLE001
            pass
    say(f"role {ROLE} removed. The state bucket and its contents are kept (delete with: aws s3 rb s3://{bucket()} --force)")
    return 0


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        say(__doc__)
        return 0
    cmd = argv[0]
    if cmd == "up":
        return cmd_up()
    if cmd == "update":
        return cmd_update()
    if cmd == "status":
        return cmd_status()
    if cmd == "logs":
        return cmd_logs(int(argv[1]) if len(argv) > 1 else 80)
    if cmd == "run":
        return cmd_run(" ".join(argv[1:]))
    if cmd == "down":
        return cmd_down("--yes" in argv)
    say(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
