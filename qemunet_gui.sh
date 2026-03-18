#!/bin/bash
# =============================================================================
# lab-gui.sh — Interface graphique pour les scripts setup-qemu-vde
#
# Deux modes :
#   fw_cfg     → appelle fwcfg.sh      (Alpine/fw_cfg)
#   cloud-init → appelle cloudinit.sh  (Debian/cloud-init)
# =============================================================================

# =============================================================================
# ÉTAPE 0 — Choisir le mode de configuration invité
# =============================================================================
CONFIG_MODE=$(zenity --list \
  --title="Lab QEMU — Mode de configuration" \
  --text="Choisissez le mécanisme de configuration du système invité :" \
  --radiolist \
  --column="" --column="Mode" --column="Description" \
  TRUE  "fw_cfg"     "Alpine Linux — configuration réseau via fw_cfg (fwcfg.sh)" \
  FALSE "cloud-init" "Debian cloud — configuration via cloud-init seed ISO (cloudinit.sh)" \
  --width=700 --height=220)

[ -z "$CONFIG_MODE" ] && exit 0

# =============================================================================
# ÉTAPE 1 — Sélection du disque de base
# =============================================================================
DISK=$(zenity --file-selection \
  --title="Lab QEMU — Sélectionner le disque ($CONFIG_MODE)" \
  --file-filter="Disques QEMU | *.qcow2 *.img *.raw")

[ -z "$DISK" ] && exit 0

# =============================================================================
# ÉTAPE 2 — Formulaire commun (options partagées par les deux scripts)
# =============================================================================
# Défaut RAM selon le mode (pour affichage dans les labels)
DEFAULT_RAM=512
[ "$CONFIG_MODE" = "cloud-init" ] && DEFAULT_RAM=1024

RESULT=$(zenity --forms \
  --title="Lab QEMU — Options communes" \
  --text="Disque : $(basename "$DISK")  |  Mode : $CONFIG_MODE\nLaisser vide = conserver la valeur par défaut indiquée." \
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
# ÉTAPE 3 — Options spécifiques au mode choisi
# =============================================================================
if [ "$CONFIG_MODE" = "fw_cfg" ]; then

  # ── Defaults Alpine/fw_cfg ──────────────────────────────────────────────
  RAM=${RAM:-512}
  CPUS=${CPUS:-2}

  # Options supplémentaires spécifiques à fw_cfg
  zenity --forms \
    --title="Lab QEMU — Options fw_cfg (Alpine)" \
    --text="Options spécifiques au mode fw_cfg / Alpine\nLaisser vide = conserver la valeur par défaut indiquée." \
    --add-entry="Script réseau custom  [défaut: /tmp/setup-net.sh]" \
    --separator="|" \
    --width=620 > /tmp/lab_gui_fw_extra.tmp
  [ $? -ne 0 ] && exit 0   # annulation (bouton Annuler)

  NET_SCRIPT=$(cat /tmp/lab_gui_fw_extra.tmp | cut -d'|' -f1)
  rm -f /tmp/lab_gui_fw_extra.tmp

  # ── Construction de la commande fw_cfg ─────────────────────────────────
  SCRIPT="./fwcfg.sh"
  CMD="$SCRIPT"
  CMD="$CMD --count $COUNT"
  CMD="$CMD --ram $RAM"
  CMD="$CMD --cpu $CPUS"
  CMD="$CMD --vde-net $VDENET"
  CMD="$CMD --base-ip $BASEIP"
  CMD="$CMD --base-ssh $BASESSH"
  CMD="$CMD --disk-mode $DISKMODE"
  [ "$NAT"    = "VDE seul" ] && CMD="$CMD --no-nat"
  [ "$SWITCH" = "HUB"      ] && CMD="$CMD --hub"
  [ -n "$PKGLIST"           ] && CMD="$CMD --pkg-list $PKGLIST"
  [ -n "$NET_SCRIPT"        ] && CMD="$CMD --net-script $NET_SCRIPT"
  CMD="$CMD $DISK"

else  # cloud-init

  # ── Defaults Debian/cloud-init ──────────────────────────────────────────
  RAM=${RAM:-1024}
  CPUS=${CPUS:-2}

  # Options supplémentaires spécifiques à cloud-init
  zenity --forms \
    --title="Lab QEMU — Options cloud-init (Debian)" \
    --text="Options spécifiques au mode cloud-init / Debian\nLaisser vide = conserver la valeur par défaut indiquée." \
    --add-entry="Mot de passe utilisateur debian  [défaut: aucun]" \
    --add-entry="Clé SSH publique  [défaut: ~/.ssh/id_ed25519.pub]" \
    --add-entry="Dossier seeds ISO  [défaut: /tmp/vde/seeds]" \
    --separator="|" \
    --width=620 > /tmp/lab_gui_ci_extra.tmp
  [ $? -ne 0 ] && exit 0   # annulation (bouton Annuler)

  CLOUD_PASS=$(cat /tmp/lab_gui_ci_extra.tmp | cut -d'|' -f1)
  SSH_KEY=$(cat /tmp/lab_gui_ci_extra.tmp    | cut -d'|' -f2)
  SEEDS_DIR=$(cat /tmp/lab_gui_ci_extra.tmp  | cut -d'|' -f3)
  rm -f /tmp/lab_gui_ci_extra.tmp

  # ── Avertissement si aucune auth ────────────────────────────────────────
  if [ -z "$CLOUD_PASS" ] && [ -z "$SSH_KEY" ] && [ ! -f "${HOME}/.ssh/id_ed25519.pub" ]; then
    zenity --warning \
      --title="Authentification manquante" \
      --text="⚠️  Aucun mot de passe ni clé SSH fournis.\n\nSi ~/.ssh/id_ed25519.pub est absent, le login SSH sera impossible.\nLe mot de passe par défaut de l'image (debian/debian) peut ne pas fonctionner.\n\nContinuer quand même ?" \
      --ok-label="Continuer" \
      --width=480
    [ $? -ne 0 ] && exit 0
  fi

  # ── Construction de la commande cloud-init ──────────────────────────────
  SCRIPT="./cloudinit.sh"
  CMD="$SCRIPT"
  CMD="$CMD --count $COUNT"
  CMD="$CMD --ram $RAM"
  CMD="$CMD --cpu $CPUS"
  CMD="$CMD --vde-net $VDENET"
  CMD="$CMD --base-ip $BASEIP"
  CMD="$CMD --base-ssh $BASESSH"
  CMD="$CMD --disk-mode $DISKMODE"
  [ "$NAT"    = "VDE seul" ] && CMD="$CMD --no-nat"
  [ "$SWITCH" = "HUB"      ] && CMD="$CMD --hub"
  [ -n "$PKGLIST"           ] && CMD="$CMD --pkg-list $PKGLIST"
  [ -n "$CLOUD_PASS"        ] && CMD="$CMD --password $CLOUD_PASS"
  [ -n "$SSH_KEY"           ] && CMD="$CMD --ssh-key $SSH_KEY"
  [ -n "$SEEDS_DIR"         ] && CMD="$CMD --seeds-dir $SEEDS_DIR"
  CMD="$CMD $DISK"

fi

# =============================================================================
# ÉTAPE 4 — Vérification que le script cible existe
# =============================================================================
if [ ! -f "$SCRIPT" ]; then
  zenity --error \
    --title="Script introuvable" \
    --text="Le script backend est introuvable :\n\n  $SCRIPT\n\nAssurez-vous que le script est dans le même dossier que lab-gui.sh." \
    --width=460
  exit 1
fi

# =============================================================================
# ÉTAPE 5 — Confirmation avant lancement
# =============================================================================

# Résumé lisible selon le mode
if [ "$CONFIG_MODE" = "fw_cfg" ]; then
  RESUME="Mode : Alpine / fw_cfg\nScript : $SCRIPT"
  [ -n "$NET_SCRIPT" ] && RESUME="$RESUME\nScript réseau : $NET_SCRIPT"
  # Accès SSH Alpine : login root, pas de mot de passe par défaut
  RESUME="$RESUME\n"
  RESUME="$RESUME\n── Accès SSH ──────────────────────────────"
  RESUME="$RESUME\n  Login    : root"
  RESUME="$RESUME\n  Password : (celui configuré dans l'image Alpine)"
  for i in $(seq 1 "$COUNT"); do
    PORT=$(( BASESSH + i - 1 ))
    IP="${VDENET%.*}.$(( BASEIP + i - 1 ))"
    RESUME="$RESUME\n  VM$i → ssh root@localhost -p $PORT   (VDE: $IP)"
  done
else
  RESUME="Mode : Debian / cloud-init\nScript : $SCRIPT"
  [ -n "$SEEDS_DIR"  ] && RESUME="$RESUME\nSeeds dir     : $SEEDS_DIR"
  # Accès SSH Debian
  RESUME="$RESUME\n"
  RESUME="$RESUME\n── Accès SSH ──────────────────────────────"
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
fi

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

# Masquer le mot de passe dans le titre du xterm si présent
XTERM_TITLE="Lab QEMU — $CONFIG_MODE — $(basename "$DISK")"

xterm -title "$XTERM_TITLE" -geometry 120x35 \
  -e "bash -c '$CMD; echo; echo \"--- Terminé (code: \$?) ---\"; read -p \"Appuyer sur Entrée pour fermer...\"'" &

# =============================================================================
# ÉTAPE 7 — Afficher les instructions post-lancement (mirror Wireshark)
# =============================================================================

# Construire la commande mirror et le login selon le mode
MIRROR_CMD="./$( basename "$SCRIPT" ) --mirror"
STOP_CMD="./$( basename "$SCRIPT" ) --stop"

if [ "$CONFIG_MODE" = "fw_cfg" ]; then
  SSH_USER="root"
  if [ -n "$CLOUD_PASS" ]; then
    SSH_AUTH="Password : ****  (mot de passe défini)"
  else
    SSH_AUTH="Password : (celui configuré dans l'image Alpine)"
  fi
else
  SSH_USER="debian"
  if [ -n "$CLOUD_PASS" ]; then
    SSH_AUTH="Password : ****  (mot de passe défini)"
  elif [ -n "$SSH_KEY" ]; then
    SSH_AUTH="Auth     : clé SSH ($SSH_KEY)"
  elif [ -f "${HOME}/.ssh/id_ed25519.pub" ]; then
    SSH_AUTH="Auth     : clé SSH (~/.ssh/id_ed25519.pub)"
  else
    SSH_AUTH="Password : debian  (défaut image — peut échouer)"
  fi
fi

# Construire la liste des VMs avec port et IP
SSH_LINES=""
for i in $(seq 1 "$COUNT"); do
  PORT=$(( BASESSH + i - 1 ))
  IP="${VDENET%.*}.$(( BASEIP + i - 1 ))"
  SSH_LINES="$SSH_LINES\n  VM$i → ssh ${SSH_USER}@localhost -p $PORT   (VDE: $IP)"
done

zenity --info \
  --title="Lab démarré — Instructions" \
  --text="✅  Le lab est en cours de démarrage dans le terminal.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔑  Accès SSH aux VMs
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Login    : $SSH_USER
  $SSH_AUTH
$SSH_LINES

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔍  Activer la capture Wireshark (port mirroring)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Une fois les VMs démarrées, ouvrir un nouveau terminal
et exécuter dans le même dossier :

  $MIRROR_CMD

Puis dans un 3ème terminal, lancer Wireshark :

  wireshark -k -i /tmp/vde/vde.pipe

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🛑  Arrêter le lab
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  $STOP_CMD
" \
  --ok-label="Compris" \
  --width=620 --height=560 &
