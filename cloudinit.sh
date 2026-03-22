#!/bin/bash
# =============================================================================
# setup-qemu-vde-debian.sh — Lab QEMU Debian debootstrap
# Réseau : VDE (inter-VMs) + NAT (Internet)
# Configuration VM : cloud-init via seed ISO (NoCloud datasource)
#
# Usage :
#   ./setup-qemu-vde-debian.sh [OPTIONS] disk.qcow2
#
# Options :
#   --count N        Nombre de VMs à lancer (défaut: 2)
#   --ram MB         RAM par VM (défaut: 1024)
#   --cpu N          CPUs par VM (défaut: 2)
#   --vde-net CIDR   Réseau VDE inter-VMs en notation CIDR (défaut: 192.168.100.0/24)
#   --base-ip N      Dernier octet de la première IP VDE (défaut: 10)
#   --base-ssh N     Premier port SSH hostfwd (défaut: 2222)
#   --no-nat         Désactiver l'interface NAT (VDE seul)
#   --hub            Lancer vde_switch en mode HUB (capture trafic complet)
#   --mirror         Activer le port mirroring pour capture Wireshark
#   --disk-mode M    Gestion des disques :
#                      snapshot — volatile, reset à chaque boot (défaut)
#                      overlay  — persistant, disque delta par VM (recommandé lab)
#                      copy     — copie complète par VM (totalement indépendant)
#                      shared   — disque partagé (⚠️ risque corruption)
#   --seeds-dir D    Dossier pour les seeds ISO (défaut: /tmp/vde/seeds)
#   --pkg-list F     Fichier packages à installer dans les VMs (défaut: /tmp/packages)
#                    Format : un paquet par ligne, # pour les commentaires
#   --ssh-key F      Clé publique SSH à injecter (défaut: ~/.ssh/id_ed25519.pub)
#   --password P     Mot de passe en clair pour l'utilisateur debian (sera hashé)
#   --stop           Arrêter le lab (VMs + switch VDE)
#   --help           Afficher l'aide
#
# Exemples :
#   ./setup-qemu-vde-debian.sh --count 2 debian-lab.qcow2
#   ./setup-qemu-vde-debian.sh --count 3 --disk-mode overlay debian-lab.qcow2
#   ./setup-qemu-vde-debian.sh --count 2 --password monpass debian-lab.qcow2
#   ./setup-qemu-vde-debian.sh --count 2 --ssh-key ~/.ssh/id_rsa.pub debian-lab.qcow2
#   ./setup-qemu-vde-debian.sh --count 4 --vde-net 10.10.0.0/24 --disk-mode overlay debian-lab.qcow2
#   ./setup-qemu-vde-debian.sh --count 2 --hub --mirror debian-lab.qcow2
#   ./setup-qemu-vde-debian.sh --stop
# =============================================================================

set -e

# =============================================================================
# COULEURS ET HELPERS
# =============================================================================
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
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
PIDS=()
VM_INFO=()

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
            --stop)       STOP=true;          shift ;;
            --help)
                sed -n '3,35p' "$0" | sed 's/^# \{0,1\}//' | sed "s/setup-qemu-vde-debian\.sh/$(basename "$0")/g"
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
    info "$COUNT VM(s) | $(basename "$DISK") | RAM: ${RAM}MB | CPUs: $CPUS | $nat_status"
    info "Réseau VDE : $VDE_NET (base-ip: $BASE_IP) | Disk: $DISK_MODE"
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
# GÉNÉRATION SEED ISO CLOUD-INIT
# =============================================================================
# Structure d'un seed ISO cloud-init (label cidata) :
#
#   meta-data     → instance-id + hostname
#   user-data     → users, packages, runcmd (YAML #cloud-config)
#   network-config → configuration réseau Netplan v2
#
# cloud-init détecte automatiquement le seed si :
#   1. Le disque a le label "cidata" (genisoimage -volid cidata)
#   2. Le datasource NoCloud est dans datasource_list (configuré dans l'image)
# =============================================================================
generate_seed() {
    local vm_num=$1
    local static_ip=$2
    local mac_vde=$3
    local mac_nat=$4
    local seed_dir="$SEEDS_DIR/vm${vm_num}"
    local seed_iso="$SEEDS_DIR/seed-vm${vm_num}.iso"

    mkdir -p "$seed_dir"

    # ── meta-data ──────────────────────────────────────────────────────────────
    # instance-id unique à chaque création → cloud-init rejoue au boot suivant
    # (comportement cohérent avec snapshot : la config est toujours à jour)
    cat > "$seed_dir/meta-data" << EOF
instance-id: vm${vm_num}-$(date +%s)
local-hostname: debian-vm${vm_num}
EOF

    # ── user-data ──────────────────────────────────────────────────────────────
    # Construction de la section authentification
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
    local pkg_block=""
    if [ -f "$PKG_LIST" ]; then
        pkg_block="packages:"
        while IFS= read -r line; do
            # Ignorer commentaires et lignes vides
            [[ "$line" =~ ^[[:space:]]*# ]] && continue
            [[ -z "${line//[[:space:]]/}" ]] && continue
            pkg_block="${pkg_block}
  - $(echo "$line" | xargs)"
        done < "$PKG_LIST"
    fi

    cat > "$seed_dir/user-data" << EOF
#cloud-config

# Utilisateur principal — déjà créé dans l'image debootstrap
# cloud-init ajoute l'authentification (clé SSH et/ou mot de passe)
users:
  - name: debian
    groups: sudo
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
${ssh_block:+$ssh_block}
${pass_block:+$pass_block}

# Paquets à installer au premier boot (via apt)
${pkg_block}

# Commandes exécutées après installation des paquets
runcmd:
  - sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config
  - systemctl restart ssh
  - echo "Lab VM${vm_num} ready at \$(date)" > /var/log/lab-ready.log

# Désactiver le message de bienvenue cloud-init dans le MOTD
final_message: ""
EOF

    # ── network-config ─────────────────────────────────────────────────────────
    # Format Netplan v2 — identification par MAC au lieu du nom d'interface
    #
    # Le nom d'interface (ens3, ens4, enp0s3...) dépend du slot PCI et peut
    # varier selon la version de l'image. On utilise match: macaddress pour
    # cibler chaque interface de façon fiable indépendamment du nom assigné.
    #
    # mac_vde = 52:54:00:12:34:XX → IP statique (VDE inter-VMs)
    # mac_nat = 52:54:00:AB:CD:XX → DHCP (NAT Internet)

    # network-config : configure uniquement l'interface VDE par MAC
    # L'interface NAT (DHCP) est gérée par systemd-networkd via le fichier
    # 20-ens4.network déjà présent dans l'image — pas besoin de la déclarer
    # ici, ce qui évite le RuntimeError "not all expected physical devices"
    # quand cloud-init-local s'exécute avant que l'interface NAT soit visible.
    #
    # set-name est supprimé : le renommage d'interface échoue sur cloud-init
    # 22.x quand l'interface est déjà UP. On cible uniquement par MAC.
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
        # Fallback genisoimage — le label cidata est OBLIGATOIRE
        genisoimage \
            -output "$seed_iso" \
            -volid cidata \
            -joliet -rock \
            "$seed_dir/user-data" \
            "$seed_dir/meta-data" \
            "$seed_dir/network-config" \
            2>/dev/null
    fi

    info "Seed ISO → $seed_iso  (VM${vm_num} | IP: ${static_ip}/${VDE_MASK})"
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
# snapshot  : disque de base en lecture, écritures en RAM (volatile)
#             cloud-init rejoue à chaque boot (instance-id change)
#             → idéal pour labs reset-fréquent
#
# overlay   : fichier qcow2 delta par VM dans /tmp/vde/
#             stocke uniquement les différences par rapport au disque de base
#             cloud-init s'exécute une fois, état persisté dans l'overlay
#             → idéal pour labs avec état conservé
#
# copy      : copie complète du disque par VM
#             totalement indépendant — aucune dépendance au disque de base
#             → idéal pour VMs totalement isolées
#
# shared    : toutes les VMs sur le même disque ⚠️ risque de corruption
# =============================================================================
prepare_disk() {
    local vm_num=$1

    case "$DISK_MODE" in
        shared)
            echo "-drive file=$DISK,format=qcow2,if=virtio"
            ;;
        snapshot)
            # snapshot=on : QEMU gère la couche volatile en mémoire
            # Le fichier .qcow2 de base n'est jamais modifié
            echo "-drive file=$DISK,format=qcow2,if=virtio,snapshot=on"
            ;;
        overlay)
            local overlay="/tmp/vde/vm${vm_num}-disk.qcow2"
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
            local copy_disk="/tmp/vde/vm${vm_num}-disk.qcow2"
            if [ ! -f "$copy_disk" ]; then
                info "Copie du disque pour VM${vm_num} (peut prendre du temps)..." >&2
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
# LANCEMENT VM
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

    # Générer le seed cloud-init pour cette VM
    generate_seed "$vm_num" "$static_ip" "$mac_vde" "$mac_nat"
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

    # Wrapper xterm pour permettre le redémarrage individuel via webgui
    local xterm_file="/tmp/vde/vm${vm_num}-xterm.sh"
    cat > "$xterm_file" << EOF
#!/bin/bash
xterm -title "VM${vm_num} — ${static_ip} — $DISK_MODE" \
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

    info "VM${vm_num} | $mac_vde | $static_ip/${VDE_MASK} | $DISK_MODE$([ "$USE_NAT" = true ] && echo " | SSH: localhost:$ssh_port" || echo '')"

    bash "$xterm_file" &

    local pid=$!
    PIDS+=("$pid")
    VM_INFO+=("VM${vm_num}|$mac_vde|$static_ip|$ssh_port|$pid|$DISK_MODE")
}

# =============================================================================
# RÉSUMÉ
# =============================================================================
print_summary() {
    echo ""
    echo "=================================================================="
    echo -e "${GREEN}  Lab QEMU+VDE Debian — $COUNT VM(s) démarrée(s)${NC}"
    echo "=================================================================="
    echo ""
    echo "  Disque    : $(basename "$DISK") | Mode: $DISK_MODE"
    echo "  Switch VDE: $VDE_SOCKET ($($HUB_MODE && echo 'HUB' || echo 'SWITCH'))"
    echo "  Réseau VDE: $VDE_NET (inter-VMs)"
    $USE_NAT && echo "  NAT       : 10.0.2.0/24 | Gateway: 10.0.2.2 | DNS: 10.0.2.3"
    echo "  Seeds     : $SEEDS_DIR/"
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
    echo "  Arrêt propre :"
    echo "    ./$(basename "$0") --stop"
    echo "    # ou : pkill -f qemu-system-x86_64; pkill vde_switch; rm -rf /tmp/vde"
    echo "=================================================================="

    printf "%s\n" "${PIDS[@]}" > /tmp/vde/vm_pids.txt
    info "PIDs sauvegardés dans /tmp/vde/vm_pids.txt"
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
$MIRROR && check_deps && start_mirror && exit 0

check_deps
setup_vde

section "Génération des seeds cloud-init et démarrage des $COUNT VM(s) via xterm"
for i in $(seq 1 "$COUNT"); do
    launch_vm "$i"
    sleep 1
done

print_summary