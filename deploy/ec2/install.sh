#!/bin/bash
# Install or update Guardian on one Amazon Linux 2023 instance. Run as root; idempotent, so the same script serves the
# first boot (from user-data) and every later release (scripts/deploy_ec2.py update runs it through SSM).
#
# Expects an unpacked release at /opt/guardian/app.new and these variables:
#   GUARDIAN_BUCKET   private S3 bucket holding config/env (the runtime environment) and releases/
#   GUARDIAN_HOST     public hostname Caddy serves with a Let's Encrypt/ZeroSSL certificate (guardian.<ip>.sslip.io)
#
# Layout it produces:
#   /opt/guardian/app       the release (guardian/, gren/, demo/, web/dist/)      /opt/guardian/venv  python + deps
#   /var/lib/guardian       household store + gren run store (also mirrored to S3 by GUARDIAN_STATE_SYNC=1)
#   /etc/guardian/env       runtime environment (token, bucket, model ids)        /etc/caddy/Caddyfile
#   systemd: guardian.service (API + dashboard on 127.0.0.1:8787), caddy.service (443 -> 8787), guardian-sweep.timer
set -uo pipefail
APP=/opt/guardian/app
VENV=/opt/guardian/venv
STATE=/var/lib/guardian
ENVF=/etc/guardian/env
: "${GUARDIAN_BUCKET:?GUARDIAN_BUCKET is required}"
: "${GUARDIAN_HOST:?GUARDIAN_HOST is required}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}"

log() { echo "[install $(date -u +%H:%M:%S)] $*"; }
fail() { log "FAILED: $*"; exit 1; }

# ---- 1. packages: python 3.12 (3.11 fallback), unzip, sudo
log "packages"
if ! command -v python3.12 >/dev/null 2>&1 && ! command -v python3.11 >/dev/null 2>&1; then
  dnf install -y -q python3.12 python3.12-pip >/dev/null 2>&1 || dnf install -y -q python3.11 python3.11-pip >/dev/null 2>&1 || fail "no python 3.11+ package"
fi
dnf install -y -q unzip sudo >/dev/null 2>&1 || true
PY=$(command -v python3.12 || command -v python3.11) || fail "python 3.11+ not found"
log "python: $($PY --version)"

# ---- 2. users and directories
id guardian >/dev/null 2>&1 || useradd --system --home-dir $STATE --create-home --shell /sbin/nologin guardian
id caddy >/dev/null 2>&1 || useradd --system --home-dir /var/lib/caddy --create-home --shell /sbin/nologin caddy
mkdir -p $STATE/household $STATE/runs /etc/guardian /etc/caddy /var/lib/caddy /opt/guardian
chown -R guardian:guardian $STATE
chown -R caddy:caddy /var/lib/caddy

# ---- 3. swap in the new release
[ -d /opt/guardian/app.new ] || fail "no unpacked release at /opt/guardian/app.new"
rm -rf $APP.old
[ -d $APP ] && mv $APP $APP.old
mv /opt/guardian/app.new $APP
chown -R root:guardian $APP
chmod -R g+rX $APP
log "release: $(ls $APP)"

# ---- 4. runtime environment (uploaded by the deploy script; an existing file is kept if the download fails)
if aws s3 cp "s3://$GUARDIAN_BUCKET/config/env" $ENVF.new >/dev/null 2>&1; then
  mv $ENVF.new $ENVF
else
  [ -f $ENVF ] || fail "could not download s3://$GUARDIAN_BUCKET/config/env and no $ENVF exists"
  log "kept the existing $ENVF"
fi
chown root:guardian $ENVF && chmod 640 $ENVF

# ---- 5. python environment (editable installs: the dashboard, demo files and graphs are served from $APP)
[ -x $VENV/bin/python ] || $PY -m venv $VENV || fail "venv"
$VENV/bin/pip install -q --upgrade pip >/dev/null 2>&1
log "pip install (a few minutes the first time)"
$VENV/bin/pip install -q -e "$APP/gren" -e "$APP[aws]" "botocore[crt]" || fail "pip install"
log "installed: $($VENV/bin/pip list 2>/dev/null | grep -Ei '^(guardian|gren|strands-agents|boto3) ' | tr '\n' ' ')"

# ---- 6. Caddy: automatic HTTPS for the public hostname, reverse proxy to the API (SSE streams flush immediately)
if [ ! -x /usr/local/bin/caddy ]; then
  log "downloading caddy"
  curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=amd64" -o /usr/local/bin/caddy.new || fail "caddy download"
  chmod 755 /usr/local/bin/caddy.new && mv /usr/local/bin/caddy.new /usr/local/bin/caddy
fi
cat > /etc/caddy/Caddyfile <<EOF
$GUARDIAN_HOST {
	encode gzip
	reverse_proxy 127.0.0.1:8787 {
		flush_interval -1
	}
}
EOF
cat > /etc/systemd/system/caddy.service <<'EOF'
[Unit]
Description=Caddy (HTTPS for Guardian)
After=network-online.target
Wants=network-online.target

[Service]
User=caddy
Group=caddy
Environment=HOME=/var/lib/caddy XDG_DATA_HOME=/var/lib/caddy XDG_CONFIG_HOME=/var/lib/caddy/config
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

# ---- 7. the service and the nightly sweep (02:00 America/New_York is 06:00 UTC; the timer catches up after downtime)
cat > /etc/systemd/system/guardian.service <<EOF
[Unit]
Description=Recall & Warranty Guardian (API + dashboard)
After=network-online.target
Wants=network-online.target

[Service]
User=guardian
Group=guardian
WorkingDirectory=$APP
EnvironmentFile=$ENVF
ExecStart=$VENV/bin/guardian serve --host 127.0.0.1 --port 8787
Restart=always
RestartSec=3
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/guardian-sweep.service <<EOF
[Unit]
Description=Guardian nightly sweep
After=guardian.service
Requires=guardian.service

[Service]
Type=oneshot
EnvironmentFile=$ENVF
ExecStart=/usr/bin/curl -fsS -X POST -H "Authorization: Bearer \${GUARDIAN_API_TOKEN}" -H "content-type: application/json" -d '{"window_days": 45, "trigger": "schedule"}' http://127.0.0.1:8787/api/sweep
EOF
cat > /etc/systemd/system/guardian-sweep.timer <<'EOF'
[Unit]
Description=Run the Guardian sweep every night at 06:00 UTC (02:00 New York)

[Timer]
OnCalendar=*-*-* 06:00:00
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload

# ---- 8. state: pull the bucket copy (GUARDIAN_STATE_SYNC=1), then seed the demo household only when the store is empty
log "state pull"
(set -a; . $ENVF; set +a; cd $APP && sudo -E -u guardian $VENV/bin/python -c "from guardian.service import Guardian; Guardian.build(with_gren_app=False)") || log "state pull failed (continuing)"
if [ ! -f $STATE/household/items.json ]; then
  log "seeding the demo household"
  (set -a; . $ENVF; set +a; cd $APP && sudo -E -u guardian $VENV/bin/guardian seed) || log "seed failed (continuing)"
fi

# ---- 9. wait until this instance answers on the hostname's address (the elastic IP is attached right after launch),
#         so the certificate request does not fail its first attempts
WANT=$(echo "$GUARDIAN_HOST" | sed -E 's/^[a-z0-9-]+\.([0-9]+-[0-9]+-[0-9]+-[0-9]+)\..*$/\1/' | tr - .)
for i in $(seq 1 60); do
  TOKEN=$(curl -sX PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
  HAVE=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4)
  [ "$HAVE" = "$WANT" ] && break
  sleep 5
done
log "public ip: ${HAVE:-none} (expected $WANT)"

# ---- 10. start everything
systemctl enable caddy guardian guardian-sweep.timer >/dev/null 2>&1
systemctl restart guardian
systemctl restart caddy
systemctl restart guardian-sweep.timer   # enable alone only arms it at the next boot
for i in $(seq 1 45); do
  if curl -fsS http://127.0.0.1:8787/api/health >/dev/null 2>&1; then break; fi
  sleep 2
done
curl -fsS http://127.0.0.1:8787/api/health || fail "the service did not come up: journalctl -u guardian -n 50"
echo
log "done: https://$GUARDIAN_HOST"
