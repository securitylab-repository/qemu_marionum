#!/bin/bash
# =============================================================================
# vwifi-gui.sh — Interface graphique pour vwifi.sh
#
# Mode unique : vwifi → appelle vwifi.sh (Debian/vwifi simulation WiFi)
# =============================================================================

CONFIG_MODE="vwifi"

# =============================================================================
# ÉTAPE 1 — Sélection du disque de base
# =============================================================================
DISK=$(zenity --file-selection \
  --title="Lab QEMU vwifi — Sélectionner le disque" \
  --file-filter="Disques QEMU | *.qcow2 *.img *.raw")

[ -z "$DISK" ] && exit 0

# =============================================================================
# ÉTAPE 2 — Formulaire commun (options partagées par les scripts)
# =============================================================================
DEFAULT_RAM=1024

RESULT=$(zenity --forms \
  --title="Lab QEMU vwifi — Options communes" \
  --text="Disque : $(basename "$DISK")  |  Mode : vwifi\nLaisser vide = conserver la valeur par défaut indiquée." \
  --add-entry="Nombre de VMs  [défaut: 2]" \
  --add-entry="RAM par VM MB  [défaut: $DEFAULT_RAM]" \
  --add-entry="CPUs par VM    [défaut: 2]" \
  --add-entry="Réseau VDE CIDR  [défaut: 192.168.100.0/24]" \
  --add-entry="IP de base — dernier octet  [défaut: 10]" \
  --add-entry="Port SSH de base  [défaut: 2222]" \
  --add-combo="Disk mode  [défaut: snapshot]" \
  --combo-values="snapshot|overlay|copy|shared" \
  --add-combo="NAT Internet  [défaut: VDE+NAT]" \
  --combo-values="VDE+NAT|VDE seul" \
  --add-combo="Mode switch  [défaut: SWITCH]" \
  --combo-values="SWITCH|HUB" \
  --add-entry="Fichier paquets  [défaut: aucun]" \
  --separator="|" \
  --width=620)

[ -z "$RESULT" ] && exit 0

# Parser les valeurs communes
COUNT=$(echo "$RESULT"    | cut -d'|' -f1)
RAM=$(echo "$RESULT"      | cut -d'|' -f2)
CPUS=$(echo "$RESULT"     | cut -d'|' -f3)
VDENET=$(echo "$RESULT"   | cut -d'|' -f4)
BASEIP=$(echo "$RESULT"   | cut -d'|' -f5)
BASESSH=$(echo "$RESULT"  | cut -d'|' -f6)
DISKMODE=$(echo "$RESULT" | cut -d'|' -f7)
NAT=$(echo "$RESULT"      | cut -d'|' -f8)
SWITCH=$(echo "$RESULT"   | cut -d'|' -f9)
PKGLIST=$(echo "$RESULT"  | cut -d'|' -f10)

# Valeurs par défaut communes
COUNT=${COUNT:-2}
VDENET=${VDENET:-192.168.100.0/24}
BASEIP=${BASEIP:-10}
BASESSH=${BASESSH:-2222}
DISKMODE=${DISKMODE:-snapshot}

# =============================================================================
# ÉTAPE 3 — Options spécifiques vwifi
# =============================================================================
RAM=${RAM:-1024}
CPUS=${CPUS:-2}

zenity --forms \
  --title="Lab QEMU — Options vwifi (Debian WiFi)" \
  --text="Options spécifiques au mode vwifi / Debian\nUne VM serveur vwifi sera lancée automatiquement.\nLaisser vide = conserver la valeur par défaut indiquée." \
  --add-entry="Mot de passe utilisateur debian  [défaut: aucun]" \
  --add-entry="Clé SSH publique  [défaut: ~/.ssh/id_ed25519.pub]" \
  --add-entry="Dossier seeds ISO  [défaut: /tmp/vde/seeds]" \
  --add-entry="Nombre d'interfaces wlan par VM  [défaut: 1]" \
  --separator="|" \
  --width=620 > /tmp/lab_gui_vwifi_extra.tmp
[ $? -ne 0 ] && exit 0   # annulation (bouton Annuler)

CLOUD_PASS=$(cat /tmp/lab_gui_vwifi_extra.tmp | cut -d'|' -f1)
SSH_KEY=$(cat /tmp/lab_gui_vwifi_extra.tmp    | cut -d'|' -f2)
SEEDS_DIR=$(cat /tmp/lab_gui_vwifi_extra.tmp  | cut -d'|' -f3)
WLAN_COUNT=$(cat /tmp/lab_gui_vwifi_extra.tmp | cut -d'|' -f4)
rm -f /tmp/lab_gui_vwifi_extra.tmp

WLAN_COUNT=${WLAN_COUNT:-1}

# ── Avertissement si aucune auth ────────────────────────────────────────
if [ -z "$CLOUD_PASS" ] && [ -z "$SSH_KEY" ] && [ ! -f "${HOME}/.ssh/id_ed25519.pub" ]; then
  zenity --warning \
    --title="Authentification manquante" \
    --text="Aucun mot de passe ni clé SSH fournis.\n\nSi ~/.ssh/id_ed25519.pub est absent, le login SSH sera impossible.\nLe mot de passe par défaut de l'image (debian/debian) peut ne pas fonctionner.\n\nContinuer quand même ?" \
    --ok-label="Continuer" \
    --width=480
  [ $? -ne 0 ] && exit 0
fi

# ── Construction de la commande vwifi ───────────────────────────────────
SCRIPT="./vwifi.sh"
CMD="$SCRIPT"
CMD="$CMD --count $COUNT"
CMD="$CMD --ram $RAM"
CMD="$CMD --cpu $CPUS"
CMD="$CMD --vde-net $VDENET"
CMD="$CMD --base-ip $BASEIP"
CMD="$CMD --base-ssh $BASESSH"
CMD="$CMD --disk-mode $DISKMODE"
CMD="$CMD --wlan-count $WLAN_COUNT"
[ "$NAT"    = "VDE seul" ] && CMD="$CMD --no-nat"
[ "$SWITCH" = "HUB"      ] && CMD="$CMD --hub"
[ -n "$PKGLIST"           ] && CMD="$CMD --pkg-list $PKGLIST"
[ -n "$CLOUD_PASS"        ] && CMD="$CMD --password $CLOUD_PASS"
[ -n "$SSH_KEY"           ] && CMD="$CMD --ssh-key $SSH_KEY"
[ -n "$SEEDS_DIR"         ] && CMD="$CMD --seeds-dir $SEEDS_DIR"
CMD="$CMD $DISK"

# =============================================================================
# ÉTAPE 4 — Vérification que le script cible existe
# =============================================================================
if [ ! -f "$SCRIPT" ]; then
  zenity --error \
    --title="Script introuvable" \
    --text="Le script backend est introuvable :\n\n  $SCRIPT\n\nAssurez-vous que le script est dans le même dossier que vwifi-gui.sh." \
    --width=460
  exit 1
fi

# =============================================================================
# ÉTAPE 5 — Confirmation avant lancement
# =============================================================================

SERVER_IP="${VDENET%.*}.2"
RESUME="Mode : Debian / vwifi (simulation WiFi)\nScript : $SCRIPT"
[ -n "$SEEDS_DIR"  ] && RESUME="$RESUME\nSeeds dir     : $SEEDS_DIR"
RESUME="$RESUME\nInterfaces wlan : $WLAN_COUNT par VM"
RESUME="$RESUME\n"
RESUME="$RESUME\n── VM serveur (automatique) ────────────────"
RESUME="$RESUME\n  vwifi-server sur $SERVER_IP (port TCP 8212)"
RESUME="$RESUME\n  RAM: 512MB | CPUs: 1"
RESUME="$RESUME\n"
RESUME="$RESUME\n── Accès SSH (VMs invités) ─────────────────"
RESUME="$RESUME\n  Login    : debian"
if [ -n "$CLOUD_PASS" ]; then
  RESUME="$RESUME\n  Password : ****  (mot de passe défini)"
elif [ -n "$SSH_KEY" ]; then
  RESUME="$RESUME\n  Auth     : clé SSH ($SSH_KEY)"
elif [ -f "${HOME}/.ssh/id_ed25519.pub" ]; then
  RESUME="$RESUME\n  Auth     : clé SSH (~/.ssh/id_ed25519.pub)"
else
  RESUME="$RESUME\n  Password : debian  (défaut image — peut échouer)"
fi
for i in $(seq 1 "$COUNT"); do
  PORT=$(( BASESSH + i - 1 ))
  IP="${VDENET%.*}.$(( BASEIP + i - 1 ))"
  RESUME="$RESUME\n  VM$i → ssh debian@localhost -p $PORT   (VDE: $IP)"
done

zenity --question \
  --title="Confirmer le lancement" \
  --text="$RESUME\n\nCommande :\n\n  $CMD" \
  --ok-label="Lancer" \
  --cancel-label="Annuler" \
  --width=620

[ $? -ne 0 ] && exit 0

# =============================================================================
# ÉTAPE 6 — Lancement dans un terminal visible
# =============================================================================

XTERM_TITLE="Lab QEMU vwifi — $(basename "$DISK")"

xterm -title "$XTERM_TITLE" -geometry 120x35 \
  -e "bash -c '$CMD; echo; echo \"--- Terminé (code: \$?) ---\"; read -p \"Appuyer sur Entrée pour fermer...\"'" &

