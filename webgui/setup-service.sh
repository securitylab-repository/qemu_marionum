#!/bin/bash
# setup-service.sh — Installe qemu_marionum webgui comme service systemd
#
# Usage : sudo bash setup-service.sh [utilisateur]
#   utilisateur : le user qui lancera le service (defaut : l'utilisateur courant via SUDO_USER)

set -e

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# Verifier qu'on est root
[ "$(id -u)" -eq 0 ] || error "Ce script doit etre lance avec sudo"

# Determiner l'utilisateur
SERVICE_USER="${1:-${SUDO_USER:-$(logname 2>/dev/null || echo nobody)}}"
id "$SERVICE_USER" >/dev/null 2>&1 || error "Utilisateur '$SERVICE_USER' introuvable"

# Determiner le repertoire du projet (parent de webgui/)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
WEBGUI_DIR="$SCRIPT_DIR"

info "Utilisateur       : $SERVICE_USER"
info "Repertoire projet : $PROJECT_DIR"
info "Repertoire webgui : $WEBGUI_DIR"

# --- 1. Installer les dependances ---
info "Installation des dependances systeme..."
apt-get update -qq
apt-get install -y -qq python3-flask xterm socat vde2 qemu-system-x86 > /dev/null

info "Dependances installees"

# --- 2. Creer le service systemd ---
SERVICE_NAME="qemu-webgui"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

info "Creation du service systemd → $SERVICE_FILE"

cat > "$SERVICE_FILE" << EOF
[Unit]
Description=EFREI PARIS QEMU WIFI LAB — Web GUI
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$WEBGUI_DIR
ExecStart=/usr/bin/python3 $WEBGUI_DIR/app.py
Restart=on-failure
RestartSec=5
Environment=PYTHONDONTWRITEBYTECODE=1

[Install]
WantedBy=multi-user.target
EOF

# --- 3. Activer et demarrer le service ---
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl start "$SERVICE_NAME"

info "Service '$SERVICE_NAME' installe et demarre"
echo ""
echo "=================================================================="
echo -e "${GREEN}  Installation terminee${NC}"
echo "=================================================================="
echo ""
echo "  URL         : http://localhost:5000"
echo "  Service     : $SERVICE_NAME"
echo "  Utilisateur : $SERVICE_USER"
echo ""
echo "  Commandes utiles :"
echo "    sudo systemctl status $SERVICE_NAME    # voir l'etat"
echo "    sudo systemctl restart $SERVICE_NAME   # redemarrer"
echo "    sudo systemctl stop $SERVICE_NAME      # arreter"
echo "    sudo journalctl -u $SERVICE_NAME -f    # voir les logs"
echo ""
echo "  Desinstallation :"
echo "    sudo systemctl stop $SERVICE_NAME"
echo "    sudo systemctl disable $SERVICE_NAME"
echo "    sudo rm $SERVICE_FILE"
echo "    sudo systemctl daemon-reload"
echo "=================================================================="
