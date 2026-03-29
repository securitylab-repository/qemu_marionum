#!/bin/bash
# prepare-image.sh — Script de preparation de l'image Alpine vwifi
#
# Ce script s'execute A L'INTERIEUR de la VM Alpine une fois l'installation
# de base terminee (setup-alpine + reboot).
#
# Prerequis : Alpine installee avec acces Internet (eth0 dhcp).
#
# Usage :
#   1. Booter la VM Alpine fraichement installee
#   2. Copier ce script + le dossier local.d/ dans la VM :
#      scp -P 2222 prepare-image.sh local.d/* root@localhost:/tmp/
#   3. Executer dans la VM :
#      sh /tmp/prepare-image.sh
#   4. Eteindre : poweroff
#
# Le resultat est une image alpine-vwifi.qcow2 supportant 3 modes :
#   - fwcfg classique (opt/setup-net.sh + opt/vm-ip)
#   - vwifi-server    (+ opt/vwifi-role = "server")
#   - vwifi-client    (+ opt/vwifi-role = "client" + opt/vwifi-server-ip + opt/vwifi-wlan-count)

set -e

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
error() { echo -e "${RED}[ERREUR]${NC} $1"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Etape 1 : Paquets runtime ─────────────────────────────────────────────────
info "Installation des paquets runtime..."
apk update
apk add iw hostapd wpa_supplicant tcpdump tmux bash netcat-openbsd

# ── Etape 2 : Verifier mac80211_hwsim ─────────────────────────────────────────
info "Verification du module mac80211_hwsim..."
if modprobe mac80211_hwsim radios=0 2>/dev/null; then
    rmmod mac80211_hwsim
    info "mac80211_hwsim OK"
else
    info "mac80211_hwsim non disponible avec le kernel actuel."
    info "Installation de linux-lts (necessaire pour mac80211_hwsim)..."
    apk add linux-lts
    # Supprimer le kernel virt si present
    if apk info -e linux-virt 2>/dev/null; then
        apk del linux-virt
    fi
    info "Reboot necessaire pour utiliser linux-lts."
    info "Apres reboot, relancez ce script pour continuer."
    exit 0
fi

# ── Etape 3 : Compiler vwifi ──────────────────────────────────────────────────
info "Installation des dependances de build..."
apk add cmake make g++ pkgconf libnl3-dev git linux-headers

info "Clonage et compilation de vwifi..."
cd /tmp
rm -rf vwifi
git clone https://github.com/Raizo62/vwifi.git
cd vwifi
mkdir -p build && cd build
cmake .. -DENABLE_VHOST=OFF
make -j"$(nproc)"

info "Installation des binaires vwifi..."
cp vwifi-server vwifi-client vwifi-add-interfaces vwifi-ctrl /usr/local/bin/
chmod +x /usr/local/bin/vwifi-*

info "Nettoyage des dependances de build..."
cd /
rm -rf /tmp/vwifi
apk del cmake make g++ pkgconf libnl3-dev git linux-headers

# ── Etape 4 : Installer les hooks de boot ─────────────────────────────────────
info "Installation des hooks dans /etc/local.d/..."

# Copier depuis le dossier local.d/ s'il existe a cote du script
LOCAL_D_SRC="$SCRIPT_DIR/local.d"
if [ -d "$LOCAL_D_SRC" ]; then
    cp "$LOCAL_D_SRC/setup-net.start" /etc/local.d/setup-net.start
    cp "$LOCAL_D_SRC/setup-pkg.start" /etc/local.d/setup-pkg.start
    cp "$LOCAL_D_SRC/vwifi.start"     /etc/local.d/vwifi.start
    info "Hooks copies depuis $LOCAL_D_SRC"
else
    # Sinon, chercher dans /tmp (copie manuelle)
    for f in setup-net.start setup-pkg.start vwifi.start; do
        if [ -f "/tmp/$f" ]; then
            cp "/tmp/$f" "/etc/local.d/$f"
        else
            error "Fichier $f introuvable dans $LOCAL_D_SRC ni /tmp/"
        fi
    done
    info "Hooks copies depuis /tmp/"
fi

chmod +x /etc/local.d/setup-net.start
chmod +x /etc/local.d/setup-pkg.start
chmod +x /etc/local.d/vwifi.start

# Activer le service local au boot
rc-update add local boot 2>/dev/null || true

# ── Etape 5 : Nettoyage final ─────────────────────────────────────────────────
info "Nettoyage du cache apk..."
rm -rf /var/cache/apk/*

# ── Resultat ───────────────────────────────────────────────────────────────────
echo ""
echo "=================================================================="
info "Image Alpine vwifi prete !"
echo "=================================================================="
echo ""
echo "  Binaires installes :"
ls -la /usr/local/bin/vwifi-* 2>/dev/null || echo "  (aucun)"
echo ""
echo "  Hooks de boot :"
ls -la /etc/local.d/*.start 2>/dev/null || echo "  (aucun)"
echo ""
echo "  Prochaine etape : poweroff"
echo "  L'image qcow2 est prete a etre utilisee avec le webgui."
echo "=================================================================="
