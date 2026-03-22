#!/bin/bash
# =============================================================================
# vwifi.sh — Lab QEMU Debian vwifi (simulation WiFi)
# Réseau : VDE (inter-VMs) + NAT (Internet)
# Configuration VM : cloud-init via seed ISO (NoCloud datasource)
#
# Lance une VM serveur transparente (vwifi-server) + N VMs invités
# (vwifi-client + hostapd + wpasupplicant + mac80211_hwsim)
#
# Usage :
#   ./vwifi.sh [OPTIONS] disk.qcow2
#
# Options :
#   --count N        Nombre de VMs invités à lancer (défaut: 2)
#   --ram MB         RAM par VM invité (défaut: 1024)
#   --cpu N          CPUs par VM invité (défaut: 2)
#   --vde-net CIDR   Réseau VDE inter-VMs en notation CIDR (défaut: 192.168.100.0/24)
#   --base-ip N      Dernier octet de la première IP VDE invité (défaut: 10)
#   --base-ssh N     Premier port SSH hostfwd (défaut: 2222)
#   --no-nat         Désactiver l'interface NAT (VDE seul)
#   --hub            Lancer vde_switch en mode HUB (capture trafic complet)
#   --mirror         Activer le port mirroring pour capture Wireshark
#   --disk-mode M    Gestion des disques :
#                      snapshot — volatile, reset à chaque boot (défaut)
#                      overlay  — persistant, disque delta par VM (recommandé lab)
#                      copy     — copie complète par VM (totalement indépendant)
#                      shared   — disque partagé (risque corruption)
#   --seeds-dir D    Dossier pour les seeds ISO (défaut: /tmp/vde/seeds)
#   --pkg-list F     Fichier packages à installer dans les VMs (défaut: /tmp/packages)
#                    Format : un paquet par ligne, # pour les commentaires
#   --ssh-key F      Clé publique SSH à injecter (défaut: ~/.ssh/id_ed25519.pub)
#   --password P     Mot de passe en clair pour l'utilisateur debian (sera hashé)
#   --wlan-count N   Nombre d'interfaces wlan par VM invité (défaut: 1)
#   --recap          Ré-afficher le récapitulatif du lab en cours
#   --stop           Arrêter le lab (VMs + switch VDE)
#   --help           Afficher l'aide
#
# Exemples :
#   ./vwifi.sh --count 2 debian-lab.qcow2
#   ./vwifi.sh --count 3 --wlan-count 2 --disk-mode overlay debian-lab.qcow2
#   ./vwifi.sh --count 2 --password monpass debian-lab.qcow2
#   ./vwifi.sh --stop
# =============================================================================

set -e

# =============================================================================
# COULEURS ET HELPERS
# =============================================================================
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;36m'
NC='\033[0m'

info()    { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }
section() { echo -e "\n${BLUE}==== $1 ====${NC}"; }

# =============================================================================
# VALEURS PAR DÉFAUT
# =============================================================================
COUNT=2
RAM=1024
CPUS=2
VDE_NET="192.168.100.0/24"
BASE_IP=10
BASE_SSH=2222
USE_NAT=true
HUB_MODE=false
MIRROR=false
MIRROR_PIPE="/tmp/vde/vde.pipe"
MIRROR_PORT=""
DISK_MODE="snapshot"
SEEDS_DIR="/tmp/vde/seeds"
PKG_LIST="/tmp/packages"
SSH_KEY_FILE="${HOME}/.ssh/id_ed25519.pub"
CLOUD_PASS=""
VDE_SOCKET="/tmp/vde/switch"
VDE_MGMT="/tmp/vde/mgmt"
QEMU="qemu-system-x86_64"
DISK=""
STOP=false
RECAP=false
PIDS=()
VM_INFO=()

# Valeurs spécifiques vwifi
SERVER_RAM=512
SERVER_CPUS=1
SERVER_IP_LAST=2
SERVER_MAC_VDE="52:54:00:FF:00:01"
SERVER_MAC_NAT="52:54:00:FF:01:01"
WLAN_COUNT=1

# =============================================================================
# PARSE ARGUMENTS
# =============================================================================
parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --count)      COUNT="$2";         shift 2 ;;
            --ram)        RAM="$2";           shift 2 ;;
            --cpu)        CPUS="$2";          shift 2 ;;
            --vde-net)    VDE_NET="$2";       shift 2 ;;
            --base-ip)    BASE_IP="$2";       shift 2 ;;
            --base-ssh)   BASE_SSH="$2";      shift 2 ;;
            --no-nat)     USE_NAT=false;      shift ;;
            --hub)        HUB_MODE=true;      shift ;;
            --mirror)     MIRROR=true;        shift ;;
            --disk-mode)  DISK_MODE="$2";     shift 2 ;;
            --seeds-dir)  SEEDS_DIR="$2";     shift 2 ;;
            --pkg-list)   PKG_LIST="$2";      shift 2 ;;
            --ssh-key)    SSH_KEY_FILE="$2";  shift 2 ;;
            --password)   CLOUD_PASS="$2";    shift 2 ;;
            --wlan-count) WLAN_COUNT="$2";    shift 2 ;;
            --recap)      RECAP=true;         shift ;;
            --stop)       STOP=true;          shift ;;
            --help)
                sed -n '3,43p' "$0" | sed 's/^# \{0,1\}//' | sed "s/vwifi\.sh/$(basename "$0")/g"
                exit 0
                ;;
            *.qcow2|*.img|*.raw)
                DISK="$1"; shift ;;
            *)
                error "Argument inconnu : $1 (--help)" ;;
        esac
    done

    VDE_PREFIX=$(echo "$VDE_NET" | cut -d'/' -f1 | sed 's/\.[0-9]*$//')
    VDE_MASK=$(echo "$VDE_NET" | cut -d'/' -f2)
}

# =============================================================================
# VÉRIFICATIONS
# =============================================================================
check_deps() {
    section "Vérifications"

    if $MIRROR; then
        [ -S "$VDE_SOCKET/ctl" ] || error "Aucun switch VDE actif → lancer d'abord le lab"
        [ -S "$VDE_MGMT" ]       || error "Socket management absent"
        command -v socat      >/dev/null || error "socat → sudo apt install socat"
        command -v vdecapture >/dev/null || error "vdecapture → compiler depuis github.com/virtualsquare/vdecapture"
        return
    fi

    [ -z "$DISK" ]      && error "Aucun disque spécifié. Usage : $0 --count N disk.qcow2"
    [ ! -f "$DISK" ]    && error "Disque introuvable : $DISK"
    [ "$COUNT" -lt 1 ]  && error "Le nombre de VMs doit être >= 1"
    [ "$COUNT" -gt 20 ] && warn  "Plus de 20 VMs — attention aux ressources système"
    [ "$WLAN_COUNT" -lt 1 ] && error "Le nombre d'interfaces wlan doit être >= 1"

    case "$DISK_MODE" in
        shared|snapshot|overlay|copy) ;;
        *) error "--disk-mode invalide : '$DISK_MODE'. Valeurs : shared | snapshot | overlay | copy" ;;
    esac

    command -v vde_switch    >/dev/null || error "vde_switch → sudo apt install vde2"
    command -v "$QEMU"       >/dev/null || error "$QEMU → sudo apt install qemu-system-x86"
    command -v xterm         >/dev/null || error "xterm → sudo apt install xterm"
    $QEMU -netdev help 2>&1 | grep -q vde || error "Ce QEMU n'a pas le support VDE compilé"

    # cloud-init : cloud-localds ou genisoimage (fallback)
    if ! command -v cloud-localds >/dev/null && ! command -v genisoimage >/dev/null; then
        error "cloud-localds ou genisoimage requis → sudo apt install cloud-image-utils genisoimage"
    fi

    if [ "$DISK_MODE" = "overlay" ] || [ "$DISK_MODE" = "copy" ]; then
        command -v qemu-img >/dev/null || error "qemu-img requis pour --disk-mode $DISK_MODE"
    fi

    # Avertir si aucun moyen d'authentification
    local has_auth=false
    [ -n "$CLOUD_PASS" ]       && has_auth=true
    [ -f "$SSH_KEY_FILE" ]     && has_auth=true
    if ! $has_auth; then
        warn "Aucune clé SSH ($SSH_KEY_FILE absente) et aucun --password fourni"
        warn "Mot de passe par défaut dans l'image : debian / debian"
        warn "Recommandé : ajouter --password ou --ssh-key pour la connexion SSH"
    fi

    local nat_status
    nat_status=$([ "$USE_NAT" = true ] && echo "VDE + NAT" || echo "VDE seul")
    info "$COUNT VM(s) invité(s) + 1 VM serveur | $(basename "$DISK") | RAM: ${RAM}MB | CPUs: $CPUS | $nat_status"
    info "Réseau VDE : $VDE_NET (base-ip: $BASE_IP) | Disk: $DISK_MODE | wlan: $WLAN_COUNT"
}

# =============================================================================
# HASH MOT DE PASSE
# =============================================================================
hash_password() {
    local plain="$1"
    if command -v python3 >/dev/null; then
        python3 -c "
import crypt, sys
print(crypt.crypt(sys.argv[1], crypt.mksalt(crypt.METHOD_SHA512)))
" "$plain"
    elif command -v mkpasswd >/dev/null; then
        mkpasswd --method=SHA-512 --rounds=4096 "$plain"
    else
        error "python3 ou mkpasswd requis pour hasher le mot de passe (sudo apt install whois)"
    fi
}

# =============================================================================
# GÉNÉRATION SEED ISO — VM SERVEUR (vwifi-server)
# =============================================================================
generate_seed_server() {
    local static_ip=$1
    local mac_vde=$2
    local mac_nat=$3
    local seed_dir="$SEEDS_DIR/vmserver"
    local seed_iso="$SEEDS_DIR/seed-vmserver.iso"

    mkdir -p "$seed_dir"

    # ── meta-data ──────────────────────────────────────────────────────────────
    cat > "$seed_dir/meta-data" << EOF
instance-id: vmserver-$(date +%s)
local-hostname: vwifi-server
EOF

    # ── user-data ──────────────────────────────────────────────────────────────
    # Le serveur vwifi n'a pas besoin d'auth utilisateur complexe,
    # mais on configure quand même SSH pour le debug
    local ssh_block="" pass_block=""

    if [ -f "$SSH_KEY_FILE" ]; then
        local ssh_key
        ssh_key=$(cat "$SSH_KEY_FILE")
        ssh_block="    ssh_authorized_keys:
      - ${ssh_key}"
    fi

    if [ -n "$CLOUD_PASS" ]; then
        local hashed
        hashed=$(hash_password "$CLOUD_PASS")
        pass_block="    passwd: \"${hashed}\"
    lock_passwd: false"
    fi

    cat > "$seed_dir/user-data" << 'USERDATA_EOF'
#cloud-config

users:
  - name: debian
    groups: sudo
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
USERDATA_EOF

    # Ajouter les blocs d'authentification s'ils existent
    if [ -n "$ssh_block" ]; then
        echo "$ssh_block" >> "$seed_dir/user-data"
    fi
    if [ -n "$pass_block" ]; then
        echo "$pass_block" >> "$seed_dir/user-data"
    fi

    cat >> "$seed_dir/user-data" << USERDATA_EOF

packages:
  - iw
  - tcpdump
  - tmux

write_files:
  - path: /etc/motd
    content: |
      =============================================
        VWIFI EFREI PARIS
        Author : Boussad AIT SALEM
        VM     : vwifi-server
      =============================================

  - path: /etc/systemd/system/vwifi-server.service
    content: |
      [Unit]
      Description=vwifi server
      After=network-online.target
      Wants=network-online.target

      [Service]
      Type=simple
      ExecStart=/usr/local/bin/vwifi-server -t 8212
      Restart=on-failure
      RestartSec=3

      [Install]
      WantedBy=multi-user.target

  - path: /usr/local/bin/vwifi-capture
    permissions: '0755'
    content: |
      #!/bin/bash
      # vwifi-capture — Capture WiFi spy automatisée via vwifi
      # Lance vwifi-client en mode spy, configure wlan0 en monitor,
      # puis démarre tcpdump dans une session tmux nommée "capture".
      set -e

      cleanup() {
        echo "[vwifi-capture] Nettoyage..."
        [ -n "\$VWIFI_PID" ] && kill "\$VWIFI_PID" 2>/dev/null || true
        exit 0
      }
      trap cleanup EXIT INT TERM

      # 1. Charger mac80211_hwsim sans radio physique
      sudo modprobe mac80211_hwsim radios=0

      # 2. Lancer vwifi-client en mode spy (1 interface)
      vwifi-client -s -n 1 &
      VWIFI_PID=\$!
      echo "[vwifi-capture] vwifi-client spy lancé (PID \$VWIFI_PID)"

      # 3. Attendre que wlan0 apparaisse
      MAX_WAIT=30
      WAITED=0
      while [ ! -d /sys/class/net/wlan0 ]; do
        sleep 1
        WAITED=\$((WAITED + 1))
        if [ \$WAITED -ge \$MAX_WAIT ]; then
          echo "[vwifi-capture] ERREUR : wlan0 non détectée après \${MAX_WAIT}s" >&2
          exit 1
        fi
      done
      echo "[vwifi-capture] wlan0 détectée"

      # 4. Passer wlan0 en mode monitor
      ip link set wlan0 down
      iw dev wlan0 set monitor control
      ip link set wlan0 up
      echo "[vwifi-capture] wlan0 en mode monitor"

      # 5. Lancer tcpdump dans une session tmux
      tmux new-session -d -s capture "tcpdump -n -i wlan0"
      echo "[vwifi-capture] Capture démarrée dans tmux session 'capture'"
      echo "[vwifi-capture] → tmux attach -t capture  (pour voir la capture)"
      echo "[vwifi-capture] → Ctrl+B, D              (pour détacher sans arrêter)"

      # Attacher automatiquement à la session
      tmux attach -t capture

runcmd:
  - sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config
  - systemctl restart ssh
  - systemctl daemon-reload
  - systemctl enable --now vwifi-server
  - echo "vwifi-server ready at \$(date)" > /var/log/lab-ready.log

final_message: ""
USERDATA_EOF

    # ── network-config ─────────────────────────────────────────────────────────
    if $USE_NAT; then
        cat > "$seed_dir/network-config" << EOF
version: 2
ethernets:
  vde-iface:
    match:
      macaddress: "${mac_vde}"
    addresses:
      - ${static_ip}/${VDE_MASK}
  nat-iface:
    match:
      macaddress: "${mac_nat}"
    dhcp4: true
    dhcp4-overrides:
      route-metric: 100
EOF
    else
        cat > "$seed_dir/network-config" << EOF
version: 2
ethernets:
  vde-iface:
    match:
      macaddress: "${mac_vde}"
    addresses:
      - ${static_ip}/${VDE_MASK}
EOF
    fi

    # ── Génération de l'ISO (cidata) ───────────────────────────────────────────
    if command -v cloud-localds >/dev/null; then
        cloud-localds \
            --network-config "$seed_dir/network-config" \
            "$seed_iso" \
            "$seed_dir/user-data" \
            "$seed_dir/meta-data" \
            2>/dev/null
    else
        genisoimage \
            -output "$seed_iso" \
            -volid cidata \
            -joliet -rock \
            "$seed_dir/user-data" \
            "$seed_dir/meta-data" \
            "$seed_dir/network-config" \
            2>/dev/null
    fi

    info "Seed ISO serveur → $seed_iso  (vwifi-server | IP: ${static_ip}/${VDE_MASK})"
}

# =============================================================================
# GÉNÉRATION SEED ISO — VM INVITÉ (vwifi-client + hostapd + wpasupplicant)
# =============================================================================
generate_seed_guest() {
    local vm_num=$1
    local static_ip=$2
    local mac_vde=$3
    local mac_nat=$4
    local server_ip=$5
    local seed_dir="$SEEDS_DIR/vm${vm_num}"
    local seed_iso="$SEEDS_DIR/seed-vm${vm_num}.iso"

    mkdir -p "$seed_dir"

    # ── meta-data ──────────────────────────────────────────────────────────────
    cat > "$seed_dir/meta-data" << EOF
instance-id: vm${vm_num}-$(date +%s)
local-hostname: debian-vm${vm_num}
EOF

    # ── user-data ──────────────────────────────────────────────────────────────
    local ssh_block="" pass_block=""

    if [ -f "$SSH_KEY_FILE" ]; then
        local ssh_key
        ssh_key=$(cat "$SSH_KEY_FILE")
        ssh_block="    ssh_authorized_keys:
      - ${ssh_key}"
    fi

    if [ -n "$CLOUD_PASS" ]; then
        local hashed
        hashed=$(hash_password "$CLOUD_PASS")
        pass_block="    passwd: \"${hashed}\"
    lock_passwd: false"
    fi

    # Construction de la liste de packages
    local pkg_block="packages:
  - hostapd
  - wpasupplicant
  - tmux
  - iw"
    if [ -f "$PKG_LIST" ]; then
        while IFS= read -r line; do
            [[ "$line" =~ ^[[:space:]]*# ]] && continue
            [[ -z "${line//[[:space:]]/}" ]] && continue
            pkg_block="${pkg_block}
  - $(echo "$line" | xargs)"
        done < "$PKG_LIST"
    fi

    # MAC wlan unique par VM : 0a:0b:0c:XX:00:YY
    # XX = vm_num (hex), YY = wlan index (hex)
    local vm_hex
    vm_hex=$(printf "%02x" "$vm_num")

    cat > "$seed_dir/user-data" << 'USERDATA_EOF'
#cloud-config

users:
  - name: debian
    groups: sudo
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
USERDATA_EOF

    if [ -n "$ssh_block" ]; then
        echo "$ssh_block" >> "$seed_dir/user-data"
    fi
    if [ -n "$pass_block" ]; then
        echo "$pass_block" >> "$seed_dir/user-data"
    fi

    cat >> "$seed_dir/user-data" << USERDATA_EOF

${pkg_block}

write_files:
  - path: /etc/motd
    content: |
      =============================================
        VWIFI EFREI PARIS
        Author : Boussad AIT SALEM
        VM     : debian-vm${vm_num}
      =============================================

  - path: /usr/local/bin/vwifi-guest-setup.sh
    permissions: '0755'
    content: |
      #!/bin/bash
      # Charger mac80211_hwsim sans radio physique
      sudo modprobe mac80211_hwsim radios=0

      # Créer les interfaces wlan via vwifi-add-interfaces
      # Syntaxe : vwifi-add-interfaces <nombre> [préfixe_MAC_5_octets]
      vwifi-add-interfaces ${WLAN_COUNT} "0a:0b:0c:${vm_hex}:00"

      # Attendre que le serveur vwifi soit joignable (TCP 8212)
      SERVER="${server_ip}"
      PORT=8212
      MAX_WAIT=120
      WAITED=0
      while ! bash -c "echo > /dev/tcp/\$SERVER/\$PORT" 2>/dev/null; do
        sleep 2
        WAITED=\$((WAITED + 2))
        if [ \$WAITED -ge \$MAX_WAIT ]; then
          echo "vwifi-server non joignable après \${MAX_WAIT}s" >&2
          exit 1
        fi
      done

      # Lancer vwifi-client
      exec vwifi-client "\$SERVER"

  - path: /etc/systemd/system/vwifi-client.service
    content: |
      [Unit]
      Description=vwifi client
      After=network-online.target
      Wants=network-online.target

      [Service]
      Type=simple
      ExecStart=/usr/local/bin/vwifi-guest-setup.sh
      Restart=on-failure
      RestartSec=5

      [Install]
      WantedBy=multi-user.target

runcmd:
  - sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config
  - systemctl restart ssh
  - systemctl daemon-reload
  - systemctl enable --now vwifi-client
  - echo "Lab VM${vm_num} vwifi-client ready at \$(date)" > /var/log/lab-ready.log

final_message: ""
USERDATA_EOF

    # ── network-config ─────────────────────────────────────────────────────────
    if $USE_NAT; then
        cat > "$seed_dir/network-config" << EOF
version: 2
ethernets:
  vde-iface:
    match:
      macaddress: "${mac_vde}"
    addresses:
      - ${static_ip}/${VDE_MASK}
  nat-iface:
    match:
      macaddress: "${mac_nat}"
    dhcp4: true
    dhcp4-overrides:
      route-metric: 100
EOF
    else
        cat > "$seed_dir/network-config" << EOF
version: 2
ethernets:
  vde-iface:
    match:
      macaddress: "${mac_vde}"
    addresses:
      - ${static_ip}/${VDE_MASK}
EOF
    fi

    # ── Génération de l'ISO (cidata) ───────────────────────────────────────────
    if command -v cloud-localds >/dev/null; then
        cloud-localds \
            --network-config "$seed_dir/network-config" \
            "$seed_iso" \
            "$seed_dir/user-data" \
            "$seed_dir/meta-data" \
            2>/dev/null
    else
        genisoimage \
            -output "$seed_iso" \
            -volid cidata \
            -joliet -rock \
            "$seed_dir/user-data" \
            "$seed_dir/meta-data" \
            "$seed_dir/network-config" \
            2>/dev/null
    fi

    info "Seed ISO → $seed_iso  (VM${vm_num} | IP: ${static_ip}/${VDE_MASK} | wlan: $WLAN_COUNT)"
}

# =============================================================================
# VDE SWITCH
# =============================================================================
setup_vde() {
    section "Nettoyage"
    pkill -f "vde_switch.*$VDE_SOCKET" 2>/dev/null && { info "Ancien vde_switch arrêté"; sleep 1; } || true
    rm -rf /tmp/vde
    mkdir -p /tmp/vde "$SEEDS_DIR"
    info "/tmp/vde nettoyé"

    section "Switch VDE"
    if $HUB_MODE; then
        vde_switch -s "$VDE_SOCKET" -m 777 -M "$VDE_MGMT" --hub -d
        info "Switch VDE — mode HUB (tout le trafic visible par vdecapture)"
    else
        vde_switch -s "$VDE_SOCKET" -m 777 -M "$VDE_MGMT" -d
        info "Switch VDE — mode SWITCH (seuls les broadcasts visibles par vdecapture)"
    fi
    sleep 1

    [ -S "$VDE_SOCKET/ctl" ] || error "Socket VDE non créé : $VDE_SOCKET/ctl"
    [ -S "$VDE_MGMT" ]       || warn  "Socket management non créé : $VDE_MGMT"

    local owner
    owner=$(stat -c '%U' "$VDE_SOCKET/ctl")
    if [ "$owner" != "$(whoami)" ]; then
        warn "Socket appartient à $owner → correction des permissions"
        chmod 777 "$VDE_SOCKET/ctl"
    fi

    info "Switch VDE     → $VDE_SOCKET/ctl"
    info "Management     → $VDE_MGMT  (unixterm $VDE_MGMT)"
}

# =============================================================================
# GESTION DES DISQUES
# =============================================================================
prepare_disk() {
    local vm_id=$1

    case "$DISK_MODE" in
        shared)
            echo "-drive file=$DISK,format=qcow2,if=virtio"
            ;;
        snapshot)
            echo "-drive file=$DISK,format=qcow2,if=virtio,snapshot=on"
            ;;
        overlay)
            local overlay="/tmp/vde/vm${vm_id}-disk.qcow2"
            if [ ! -f "$overlay" ]; then
                qemu-img create -f qcow2 \
                    -b "$(realpath "$DISK")" \
                    -F qcow2 \
                    "$overlay" > /dev/null 2>&1
                info "Overlay créé → $overlay" >&2
            else
                info "Overlay existant réutilisé → $overlay" >&2
            fi
            echo "-drive file=$overlay,format=qcow2,if=virtio"
            ;;
        copy)
            local copy_disk="/tmp/vde/vm${vm_id}-disk.qcow2"
            if [ ! -f "$copy_disk" ]; then
                info "Copie du disque pour VM ${vm_id} (peut prendre du temps)..." >&2
                cp "$DISK" "$copy_disk"
                info "Copie créée → $copy_disk" >&2
            else
                info "Copie existante réutilisée → $copy_disk" >&2
            fi
            echo "-drive file=$copy_disk,format=qcow2,if=virtio"
            ;;
    esac
}

# =============================================================================
# LANCEMENT VM SERVEUR (vwifi-server — transparente)
# =============================================================================
launch_server_vm() {
    section "Démarrage VM serveur vwifi"

    local server_ip="${VDE_PREFIX}.${SERVER_IP_LAST}"
    local ssh_port=$((BASE_SSH + 100))

    # Générer le seed cloud-init pour le serveur
    generate_seed_server "$server_ip" "$SERVER_MAC_VDE" "$SERVER_MAC_NAT"
    local seed_iso="$SEEDS_DIR/seed-vmserver.iso"

    # Préparer le disque
    local drive_arg
    drive_arg=$(prepare_disk "server")

    # Arguments réseau et seed ISO
    local vde_args nat_args seed_arg
    seed_arg="-drive file=$seed_iso,format=raw,if=virtio,readonly=on"
    vde_args="-netdev vde,id=vde0,sock=$VDE_SOCKET -device virtio-net-pci,netdev=vde0,mac=$SERVER_MAC_VDE,addr=0x4"
    nat_args=""
    $USE_NAT && nat_args="-netdev user,id=nat0,hostfwd=tcp::${ssh_port}-:22 -device virtio-net-pci,netdev=nat0,mac=$SERVER_MAC_NAT,addr=0x5"

    # Écrire la commande QEMU dans un fichier pour xterm
    local cmd_file="/tmp/vde/vmserver-cmd.sh"
    cat > "$cmd_file" << EOF
#!/bin/bash
$QEMU \
    -accel tcg,thread=multi -cpu qemu64 \
    -m $SERVER_RAM -smp $SERVER_CPUS \
    $drive_arg \
    $seed_arg \
    $vde_args \
    $nat_args \
    -nographic
EOF
    chmod +x "$cmd_file"

    # Écrire le wrapper xterm pour permettre le redémarrage individuel
    local xterm_file="/tmp/vde/vmserver-xterm.sh"
    cat > "$xterm_file" << EOF
#!/bin/bash
xterm -title "vwifi-server (auto) — ${server_ip}" \
      -geometry 90x24 \
      -fa "DejaVu Sans Mono" \
      -fs 10 \
      -tn xterm-256color \
      -bg "#1e1e1e" \
      -fg "#d4d4d4" \
      -xrm "XTerm*selectToClipboard: true" \
      -xrm "XTerm*translations: #override \\n Ctrl Shift <Key>C: copy-selection(CLIPBOARD) \\n Ctrl Shift <Key>V: insert-selection(CLIPBOARD)" \
      -e "$cmd_file"
EOF
    chmod +x "$xterm_file"

    info "vwifi-server | $SERVER_MAC_VDE | $server_ip/${VDE_MASK} | $DISK_MODE$([ "$USE_NAT" = true ] && echo " | SSH: localhost:$ssh_port" || echo '')"

    bash "$xterm_file" &

    local pid=$!
    PIDS+=("$pid")

    info "VM serveur démarrée (PID $pid) — attente 5s pour initialisation..."
    sleep 5
}

# =============================================================================
# LANCEMENT VM INVITÉ
# =============================================================================
launch_vm() {
    local vm_num=$1

    # MACs uniques par VM et par interface
    local mac_suffix mac_vde mac_nat
    mac_suffix=$(printf "%02x" "$vm_num")
    mac_vde="52:54:00:12:34:$mac_suffix"
    mac_nat="52:54:00:AB:CD:$mac_suffix"

    # IP VDE et port SSH
    local ip_last static_ip ssh_port
    ip_last=$((BASE_IP + vm_num - 1))
    static_ip="${VDE_PREFIX}.${ip_last}"
    ssh_port=$((BASE_SSH + vm_num - 1))

    # IP du serveur vwifi
    local server_ip="${VDE_PREFIX}.${SERVER_IP_LAST}"

    # Générer le seed cloud-init pour cette VM invité
    generate_seed_guest "$vm_num" "$static_ip" "$mac_vde" "$mac_nat" "$server_ip"
    local seed_iso="$SEEDS_DIR/seed-vm${vm_num}.iso"

    # Préparer le disque
    local drive_arg
    drive_arg=$(prepare_disk "$vm_num")

    # Arguments réseau et seed ISO
    local vde_args nat_args seed_arg
    seed_arg="-drive file=$seed_iso,format=raw,if=virtio,readonly=on"
    vde_args="-netdev vde,id=vde0,sock=$VDE_SOCKET -device virtio-net-pci,netdev=vde0,mac=$mac_vde,addr=0x4"
    nat_args=""
    $USE_NAT && nat_args="-netdev user,id=nat0,hostfwd=tcp::${ssh_port}-:22 -device virtio-net-pci,netdev=nat0,mac=$mac_nat,addr=0x5"

    # Écrire la commande QEMU dans un fichier pour xterm
    local cmd_file="/tmp/vde/vm${vm_num}-cmd.sh"
    cat > "$cmd_file" << EOF
#!/bin/bash
$QEMU \
    -accel tcg,thread=multi -cpu qemu64 \
    -m $RAM -smp $CPUS \
    $drive_arg \
    $seed_arg \
    $vde_args \
    $nat_args \
    -nographic
EOF
    chmod +x "$cmd_file"

    info "VM${vm_num} | $mac_vde | $static_ip/${VDE_MASK} | $DISK_MODE | wlan: $WLAN_COUNT$([ "$USE_NAT" = true ] && echo " | SSH: localhost:$ssh_port" || echo '')"

    xterm -title "VM${vm_num} — ${static_ip} — vwifi-client" \
          -geometry 90x24 \
          -fa "DejaVu Sans Mono" \
          -fs 10 \
          -tn xterm-256color \
          -bg "#1e1e1e" \
          -fg "#d4d4d4" \
          -xrm "XTerm*selectToClipboard: true" \
          -xrm "XTerm*translations: #override \\n Ctrl Shift <Key>C: copy-selection(CLIPBOARD) \\n Ctrl Shift <Key>V: insert-selection(CLIPBOARD)" \
          -e "$cmd_file" &

    local pid=$!
    PIDS+=("$pid")
    VM_INFO+=("VM${vm_num}|$mac_vde|$static_ip|$ssh_port|$pid|$DISK_MODE")
}

# =============================================================================
# RÉSUMÉ
# =============================================================================
print_summary() {
    local server_ip="${VDE_PREFIX}.${SERVER_IP_LAST}"
    local server_ssh=$((BASE_SSH + 100))
    local summary_file="/tmp/vde/summary.txt"

    # Capturer le résumé dans un fichier et l'afficher en même temps
    _print_summary_content | tee "$summary_file"

    printf "%s\n" "${PIDS[@]}" > /tmp/vde/vm_pids.txt
    info "PIDs sauvegardés dans /tmp/vde/vm_pids.txt"
}

_print_summary_content() {
    local server_ip="${VDE_PREFIX}.${SERVER_IP_LAST}"
    local server_ssh=$((BASE_SSH + 100))

    echo ""
    echo "=================================================================="
    echo -e "${GREEN}  Lab QEMU+VDE vwifi — 1 serveur + $COUNT VM(s) invité(s) démarrée(s)${NC}"
    echo "=================================================================="
    echo ""
    echo "  Disque    : $(basename "$DISK") | Mode: $DISK_MODE"
    echo "  Switch VDE: $VDE_SOCKET ($($HUB_MODE && echo 'HUB' || echo 'SWITCH'))"
    echo "  Réseau VDE: $VDE_NET (inter-VMs)"
    $USE_NAT && echo "  NAT       : 10.0.2.0/24 | Gateway: 10.0.2.2 | DNS: 10.0.2.3"
    echo "  Seeds     : $SEEDS_DIR/"
    echo ""

    # Info vwifi-server
    echo -e "  ${BLUE}── vwifi-server (automatique) ──${NC}"
    echo "  IP VDE    : ${server_ip}/${VDE_MASK}"
    echo "  Service   : vwifi-server -t 8212"
    echo "  Capture   : sudo vwifi-capture (spy WiFi + tcpdump dans tmux)"
    echo "  RAM       : ${SERVER_RAM}MB | CPUs: $SERVER_CPUS"
    $USE_NAT && echo "  SSH debug : ssh debian@localhost -p $server_ssh"
    echo ""

    # Info vwifi invités
    echo -e "  ${BLUE}── VMs invités (vwifi-client) ──${NC}"
    echo "  Interfaces wlan : $WLAN_COUNT par VM (mac80211_hwsim)"
    echo "  Packages : hostapd, wpasupplicant, tmux, iw"
    echo ""

    # Avertissement temps de boot
    echo -e "  ${YELLOW}⏳ Premier boot${NC} : cloud-init configure le réseau et installe les"
    echo    "     packages via apt (~3-8 min sans KVM en mode TCG)"
    echo -e "  ${GREEN}✅ SSH disponible${NC} une fois cloud-final.service terminé"
    echo    "     Surveiller dans la console xterm : cloud-init status --wait"
    echo ""

    if $USE_NAT; then
        printf "  %-6s %-20s %-20s %-16s %-10s %s\n" \
            "VM" "MAC ens3 (VDE)" "IP VDE" "SSH host" "Disk" "PID"
        printf "  %-6s %-20s %-20s %-16s %-10s %s\n" \
            "------" "--------------------" "--------------------" "----------------" "----------" "-------"
        for info_line in "${VM_INFO[@]}"; do
            IFS='|' read -r vm mac ip ssh_port pid disk_mode <<< "$info_line"
            printf "  %-6s %-20s %-20s %-16s %-10s %s\n" \
                "$vm" "$mac" "${ip}/${VDE_MASK}" "localhost:$ssh_port" "$disk_mode" "$pid"
        done
    else
        printf "  %-6s %-20s %-20s %-10s %s\n" \
            "VM" "MAC ens3 (VDE)" "IP VDE" "Disk" "PID"
        printf "  %-6s %-20s %-20s %-10s %s\n" \
            "------" "--------------------" "--------------------" "----------" "-------"
        for info_line in "${VM_INFO[@]}"; do
            IFS='|' read -r vm mac ip ssh_port pid disk_mode <<< "$info_line"
            printf "  %-6s %-20s %-20s %-10s %s\n" \
                "$vm" "$mac" "${ip}/${VDE_MASK}" "$disk_mode" "$pid"
        done
    fi

    echo ""

    # Accès SSH
    echo -e "  ${BLUE}── Accès SSH ──${NC}"
    echo "  Login    : debian"
    if [ -n "$CLOUD_PASS" ]; then
        echo "  Password : ****  (mot de passe défini)"
    elif [ -f "$SSH_KEY_FILE" ]; then
        echo "  Auth     : clé SSH ($SSH_KEY_FILE)"
    else
        echo "  Password : debian  (défaut image — peut échouer)"
    fi
    echo ""
    for info_line in "${VM_INFO[@]}"; do
        IFS='|' read -r vm mac ip ssh_port pid disk_mode <<< "$info_line"
        echo "  $vm → ssh debian@localhost -p $ssh_port   (VDE: ${ip}/${VDE_MASK})"
    done
    $USE_NAT && echo "  Serveur → ssh debian@localhost -p $server_ssh   (VDE: ${server_ip}/${VDE_MASK})"
    echo ""

    # Récupérer des fichiers
    echo -e "  ${BLUE}── Récupérer des fichiers (scp) ──${NC}"
    for info_line in "${VM_INFO[@]}"; do
        IFS='|' read -r vm mac ip ssh_port pid disk_mode <<< "$info_line"
        echo "  $vm → scp -P $ssh_port debian@localhost:/chemin/fichier ."
    done
    echo ""

    # Capture Wireshark
    echo -e "  ${BLUE}── Capture Wireshark (port mirroring) ──${NC}"
    echo "  Une fois les VMs démarrées, ouvrir un nouveau terminal :"
    echo ""
    echo "    ./$(basename "$0") --mirror"
    echo ""
    echo "  Puis lancer Wireshark :"
    echo ""
    echo "    sudo wireshark -k -i $MIRROR_PIPE"
    echo ""

    # Récapitulatif
    echo -e "  ${BLUE}── Récapitulatif ──${NC}"
    echo "    ./$(basename "$0") --recap"
    echo ""

    # Arrêt propre
    echo -e "  ${BLUE}── Arrêt propre ──${NC}"
    echo "    ./$(basename "$0") --stop"
    echo "    # ou : pkill -f qemu-system-x86_64; pkill vde_switch; rm -rf /tmp/vde"
    echo "=================================================================="
}

# =============================================================================
# PORT MIRRORING — capture Wireshark sans mode HUB global
# =============================================================================
start_mirror() {
    section "Port mirroring — capture Wireshark"

    command -v vdecapture >/dev/null || \
        error "vdecapture introuvable → compiler depuis https://github.com/virtualsquare/vdecapture"
    command -v socat >/dev/null || \
        error "socat introuvable → sudo apt install socat"

    # Créer le pipe nommé pour Wireshark
    rm -f "$MIRROR_PIPE"
    mkfifo "$MIRROR_PIPE" || error "Impossible de créer le pipe : $MIRROR_PIPE"
    info "Pipe créé → $MIRROR_PIPE"

    # Lancer vdecapture (se connecte au switch comme un client VDE)
    vdecapture "$VDE_SOCKET" - > "$MIRROR_PIPE" 2>/tmp/vde/vdecapture.log &
    local vcap_pid=$!
    info "vdecapture démarré (PID $vcap_pid)"

    sleep 1
    if ! kill -0 "$vcap_pid" 2>/dev/null; then
        error "vdecapture a planté — log : $(cat /tmp/vde/vdecapture.log)"
    fi

    echo ""
    echo "=================================================================="
    echo -e "${YELLOW}  Action requise — lancer Wireshark${NC}"
    echo "=================================================================="
    echo -e "  ${GREEN}sudo wireshark -k -i $MIRROR_PIPE${NC}"
    echo ""
    read -r -p "Appuyer sur [Entrée] une fois Wireshark lancé et prêt..."

    # Identifier le port vdecapture dans le switch et le passer en mode HUB
    info "Récupération du port vdecapture..."
    local max_wait=10 waited=0
    while [ $waited -lt $max_wait ]; do
        local port_output
        port_output=$(echo "port/print" | socat - UNIX-CONNECT:"$VDE_MGMT" 2>/tmp/vde/mirror_err)
        MIRROR_PORT=$(echo "$port_output" \
            | grep "^Port" | tail -1 | awk '{print $2}' | sed 's/^0*//')
        [ -n "$MIRROR_PORT" ] && break
        sleep 1; waited=$((waited+1))
    done

    [ -z "$MIRROR_PORT" ] && \
        error "Port vdecapture introuvable après ${max_wait}s — log : $(cat /tmp/vde/vdecapture.log)"

    info "Port détecté : $MIRROR_PORT"

    echo "port/sethub $MIRROR_PORT 1" \
        | socat - UNIX-CONNECT:"$VDE_MGMT" 2>/tmp/vde/mirror_err \
        || error "port/sethub échoué : $(cat /tmp/vde/mirror_err)"

    echo "$vcap_pid" >> /tmp/vde/vm_pids.txt
    info "Port $MIRROR_PORT en mode HUB → mirror actif"
    info "Tout le trafic inter-VMs est visible dans Wireshark"
}

# =============================================================================
# ARRÊT PROPRE
# =============================================================================
stop_lab() {
    section "Arrêt du lab"

    if [ -f /tmp/vde/vm_pids.txt ]; then
        info "Arrêt des processus (PIDs sauvegardés)..."
        while read -r pid; do
            if kill -0 "$pid" 2>/dev/null; then
                kill "$pid" 2>/dev/null
                info "PID $pid arrêté"
            else
                warn "PID $pid déjà arrêté"
            fi
        done < /tmp/vde/vm_pids.txt
    fi

    if pgrep -f "qemu-system-x86_64" > /dev/null 2>&1; then
        pkill -f "qemu-system-x86_64" 2>/dev/null
        sleep 1
        pgrep -f "qemu-system-x86_64" > /dev/null 2>&1 && \
            pkill -9 -f "qemu-system-x86_64" 2>/dev/null && \
            warn "QEMU forcé (SIGKILL)"
        info "Processus QEMU arrêtés"
    else
        warn "Aucun processus QEMU trouvé"
    fi

    pgrep -f vdecapture > /dev/null 2>&1 && pkill -f vdecapture && info "vdecapture arrêté" || true
    pgrep -f wireshark  > /dev/null 2>&1 && pkill -f wireshark  && info "Wireshark arrêté"  || true

    if pgrep -f "vde_switch.*$VDE_SOCKET" > /dev/null 2>&1; then
        pkill -f "vde_switch.*$VDE_SOCKET"
        info "vde_switch arrêté"
    else
        warn "vde_switch déjà arrêté"
    fi

    rm -rf /tmp/vde
    info "Dossier /tmp/vde supprimé"

    echo ""
    echo "=================================================================="
    echo -e "${GREEN}  Lab arrêté proprement${NC}"
    echo "=================================================================="
}

# =============================================================================
# MAIN
# =============================================================================
parse_args "$@"

$STOP   && stop_lab   && exit 0
$RECAP  && { [ -f /tmp/vde/summary.txt ] && cat /tmp/vde/summary.txt || error "Aucun récapitulatif trouvé — le lab n'est pas démarré"; } && exit 0
$MIRROR && check_deps && start_mirror && exit 0

check_deps
setup_vde

section "Démarrage VM serveur vwifi + $COUNT VM(s) invité(s) via xterm"
launch_server_vm

for i in $(seq 1 "$COUNT"); do
    launch_vm "$i"
    sleep 1
done

print_summary
