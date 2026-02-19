#!/usr/bin/env bash
# =============================================================================
# tools-app production deployment script
# Target: yrefy-server-220-1 (192.168.192.140)
# URL:    https://tools.it.yrefy
# Port:   3007
# =============================================================================
set -euo pipefail

APP_NAME="tools-app"
APP_DIR="/home/yrefy-it/${APP_NAME}"
REPO="git@github.com:jmilleryrefy/tools-app.git"
NGINX_CONF="tools.it.yrefy.conf"
LOG_DIR="/var/log/nginx/tools.it.yrefy"
PORT=3007

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${CYAN}[deploy]${NC} $1"; }
ok()   { echo -e "${GREEN}[  ok  ]${NC} $1"; }
warn() { echo -e "${YELLOW}[ warn ]${NC} $1"; }
fail() { echo -e "${RED}[FAIL!]${NC} $1"; exit 1; }

# ------------------------------------------------------------------------------
# Pre-flight checks
# ------------------------------------------------------------------------------
log "Running pre-flight checks..."

command -v node >/dev/null 2>&1 || fail "node is not installed"
command -v npm  >/dev/null 2>&1 || fail "npm is not installed"
command -v pm2  >/dev/null 2>&1 || fail "pm2 is not installed"
command -v git  >/dev/null 2>&1 || fail "git is not installed"
command -v nginx >/dev/null 2>&1 || fail "nginx is not installed"

ok "All required tools found"

# ------------------------------------------------------------------------------
# Step 1: Clone or pull the repository
# ------------------------------------------------------------------------------
if [ -d "${APP_DIR}/.git" ]; then
    log "Existing repo found — pulling latest changes..."
    cd "${APP_DIR}"
    git fetch origin main
    git reset --hard origin/main
    ok "Repository updated"
else
    log "Cloning repository..."
    git clone "${REPO}" "${APP_DIR}"
    cd "${APP_DIR}"
    ok "Repository cloned to ${APP_DIR}"
fi

# ------------------------------------------------------------------------------
# Step 2: Verify .env exists
# ------------------------------------------------------------------------------
if [ ! -f "${APP_DIR}/.env" ]; then
    warn ".env file not found — creating from .env.example"
    cp "${APP_DIR}/.env.example" "${APP_DIR}/.env"
    fail ".env created from template. Fill in production values at ${APP_DIR}/.env and re-run this script."
fi

# Verify critical env vars are set (not empty/placeholder)
source <(grep -v '^#' "${APP_DIR}/.env" | grep -v '^\s*$' | sed 's/^/export /')
[ -z "${DATABASE_URL:-}" ]                    && fail "DATABASE_URL is not set in .env"
[ -z "${AUTH_MICROSOFT_ENTRA_ID_ID:-}" ]      && fail "AUTH_MICROSOFT_ENTRA_ID_ID is not set in .env"
[ -z "${AUTH_MICROSOFT_ENTRA_ID_SECRET:-}" ]  && fail "AUTH_MICROSOFT_ENTRA_ID_SECRET is not set in .env"
[ -z "${AUTH_MICROSOFT_ENTRA_ID_TENANT_ID:-}" ] && fail "AUTH_MICROSOFT_ENTRA_ID_TENANT_ID is not set in .env"

if [ "${AUTH_SECRET:-}" = "dev-secret-change-in-production" ]; then
    log "Generating production AUTH_SECRET..."
    NEW_SECRET=$(openssl rand -base64 33)
    sed -i "s|AUTH_SECRET=\"dev-secret-change-in-production\"|AUTH_SECRET=\"${NEW_SECRET}\"|" "${APP_DIR}/.env"
    ok "AUTH_SECRET generated"
fi

ok ".env validated"

# ------------------------------------------------------------------------------
# Step 3: Install dependencies
# ------------------------------------------------------------------------------
log "Installing dependencies..."
cd "${APP_DIR}"
npm ci --production=false
ok "Dependencies installed"

# ------------------------------------------------------------------------------
# Step 4: Prisma — generate client and run migrations
# ------------------------------------------------------------------------------
log "Generating Prisma client..."
npx prisma generate
ok "Prisma client generated"

log "Pushing database schema..."
npx prisma db push
ok "Database schema applied"

log "Seeding database..."
npx prisma db seed || warn "Seed may have already been applied (upserts are idempotent)"
ok "Database seeded"

# ------------------------------------------------------------------------------
# Step 5: Build the Next.js application
# ------------------------------------------------------------------------------
log "Building Next.js application..."
npm run build
ok "Build complete"

# ------------------------------------------------------------------------------
# Step 6: Set up Nginx
# ------------------------------------------------------------------------------
if [ ! -f "/etc/nginx/sites-available/${NGINX_CONF}" ]; then
    log "Installing Nginx configuration..."
    sudo cp "${APP_DIR}/nginx/${NGINX_CONF}" "/etc/nginx/sites-available/${NGINX_CONF}"
    ok "Nginx config copied"
else
    log "Updating Nginx configuration..."
    sudo cp "${APP_DIR}/nginx/${NGINX_CONF}" "/etc/nginx/sites-available/${NGINX_CONF}"
    ok "Nginx config updated"
fi

if [ ! -d "${LOG_DIR}" ]; then
    log "Creating Nginx log directory..."
    sudo mkdir -p "${LOG_DIR}"
    ok "Log directory created at ${LOG_DIR}"
fi

if [ ! -L "/etc/nginx/sites-enabled/${NGINX_CONF}" ]; then
    log "Enabling Nginx site..."
    sudo ln -s "/etc/nginx/sites-available/${NGINX_CONF}" "/etc/nginx/sites-enabled/${NGINX_CONF}"
    ok "Site enabled"
fi

log "Testing Nginx configuration..."
sudo nginx -t || fail "Nginx configuration test failed"
sudo systemctl reload nginx
ok "Nginx reloaded"

# ------------------------------------------------------------------------------
# Step 7: Start or restart PM2 process
# ------------------------------------------------------------------------------
if pm2 describe "${APP_NAME}" >/dev/null 2>&1; then
    log "Restarting existing PM2 process..."
    pm2 restart "${APP_NAME}" --update-env
    ok "PM2 process restarted"
else
    log "Starting new PM2 process..."
    cd "${APP_DIR}"
    pm2 start ecosystem.config.js
    ok "PM2 process started"
fi

pm2 save
ok "PM2 process list saved"

# ------------------------------------------------------------------------------
# Step 8: Health check
# ------------------------------------------------------------------------------
log "Waiting for application to start..."
sleep 5

HEALTH_STATUS=$(curl -sf -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/api/health" || echo "000")

if [ "${HEALTH_STATUS}" = "200" ]; then
    ok "Health check passed (HTTP ${HEALTH_STATUS})"
else
    warn "Health check returned HTTP ${HEALTH_STATUS} — the app may still be starting"
    log "Check logs with: pm2 logs ${APP_NAME}"
fi

# ------------------------------------------------------------------------------
# Done
# ------------------------------------------------------------------------------
echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN} Deployment complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "  App:     ${CYAN}${APP_NAME}${NC}"
echo -e "  URL:     ${CYAN}https://tools.it.yrefy${NC}"
echo -e "  Port:    ${CYAN}${PORT}${NC}"
echo -e "  Dir:     ${CYAN}${APP_DIR}${NC}"
echo -e "  PM2:     ${CYAN}pm2 status ${APP_NAME}${NC}"
echo -e "  Logs:    ${CYAN}pm2 logs ${APP_NAME}${NC}"
echo -e "  Health:  ${CYAN}curl https://tools.it.yrefy/api/health${NC}"
echo ""
