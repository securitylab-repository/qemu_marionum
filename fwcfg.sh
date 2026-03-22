#!/bin/bash
# =============================================================================
# setup-qemu-vde.sh — Réseau QEMU multi-VM : VDE (inter-VMs) + NAT (Internet)
# Lancement automatique via xterm, configuration réseau via fw_cfg
#
# Usage :
#   ./setup-qemu-vde.sh [OPTIONS] disk.qcow2
#
# Options :
#   --count N        Nombre de VMs à lancer (défaut: 2)
#   --ram MB         RAM par VM (défaut: 512)
#   --cpu N          CPUs par VM (défaut: 2)
#   --vde-net CIDR   Réseau VDE inter-VMs en notation CIDR (défaut: 192.168.100.0/24)
#   --base-ip N      Dernier octet de la première IP VDE (défaut: 10)
#   --base-ssh N     Premier port SSH hostfwd (défaut: 2222)
#   --no-nat         Désactiver l'interface NAT (VDE seul)
#   --hub            Lancer vde_switch en mode HUB (tout le trafic visible par vdecapture)
#   --mirror         Activer le port mirroring pour capture Wireshark
#                    Lance vdecapture + configure le port hub + ouvre Wireshark
#                    Compatible avec le mode SWITCH (pas besoin de --hub)
#   --net-script F   Script réseau à passer via fw_cfg (défaut: /tmp/setup-net.sh)
#   --pkg-list F     Fichier liste de paquets à installer dans les VMs (défaut: /tmp/packages)
#                    Format : un paquet par ligne, # pour les commentaires
#   --disk-mode M    Gestion des disques :
#                      shared   — toutes les VMs partagent le même disque (risque corruption)
#                      snapshot — disque partagé en lecture, état en mémoire (défaut)
#                      overlay  — disque overlay qcow2 léger par VM (persistant)
#                      copy     — copie complète du disque par VM (indépendant)
#   --stop            Arrêter le lab (VMs + switch VDE)
#   --help           Afficher l'aide
#
# Exemples :
#   ./setup-qemu-vde.sh --count 2 --mirror alpine.qcow2
#   ./setup-qemu-vde.sh --count 2 --mirror --disk-mode overlay alpine.qcow2
#   ./setup-qemu-vde.sh --count 3 alpine.qcow2
#   ./setup-qemu-vde.sh --count 2 --disk-mode overlay alpine.qcow2
#   ./setup-qemu-vde.sh --count 2 --pkg-list /tmp/packages alpine.qcow2
#   ./setup-qemu-vde.sh --count 4 --vde-net 10.10.0.0/24 --base-ip 5 alpine.qcow2
#   ./setup-qemu-vde.sh --count 2 --no-nat alpine.qcow2
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
RAM=512
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
NET_SCRIPT="/tmp/setup-net.sh"
PKG_LIST="/tmp/packages"
PKG_SCRIPT="/tmp/setup-pkg.sh"
VDE_SOCKET="/tmp/vde/switch"
VDE_MGMT="/tmp/vde/mgmt"
QEMU="qemu-system-x86_64"
DISK=""
STOP=false
PIDS=()
VM_INFO=()

# =============================================================================
# FONCTIONS
# =============================================================================

# -----------------------------------------------------------------------------
# parse_args — lecture des arguments de la ligne de commande
# -----------------------------------------------------------------------------
parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --count)      COUNT="$2";      shift 2 ;;
            --ram)        RAM="$2";        shift 2 ;;
            --cpu)        CPUS="$2";       shift 2 ;;
            --vde-net)    VDE_NET="$2";    shift 2 ;;
            --base-ip)    BASE_IP="$2";    shift 2 ;;
            --base-ssh)   BASE_SSH="$2";   shift 2 ;;
            --no-nat)     USE_NAT=false;   shift ;;
            --hub)        HUB_MODE=true;   shift ;;
            --mirror)     MIRROR=true;     shift ;;
            --disk-mode)  DISK_MODE="$2";  shift 2 ;;
            --net-script) NET_SCRIPT="$2"; shift 2 ;;
            --pkg-list)   PKG_LIST="$2";   shift 2 ;;
            --stop)       STOP=true;       shift ;;
            --help)
                sed -n '3,28p' "$0" \
                    | sed 's/^# \{0,1\}//' \
                    | sed "s|setup-qemu-vde\.sh|$(basename $0)|g"
                exit 0
                ;;
            *.qcow2|*.img|*.raw)
                DISK="$1"; shift ;;
            *)
                error "Argument inconnu : $1 (utilisez --help)" ;;
        esac
    done

    # Extraire le préfixe réseau et le masque depuis VDE_NET
    VDE_PREFIX=$(echo "$VDE_NET" | cut -d'/' -f1 | sed 's/\.[0-9]*$//')
    VDE_MASK=$(echo "$VDE_NET" | cut -d'/' -f2)
}

# -----------------------------------------------------------------------------
# check_deps — vérification des dépendances et arguments
# -----------------------------------------------------------------------------
check_deps() {
    section "Vérifications"

    # En mode mirror — vérifier uniquement que le lab est actif
    if $MIRROR; then
        info "Mode mirror — vérification du lab existant"
        [ -S "$VDE_SOCKET/ctl" ] || error "Aucun switch VDE actif → lancer d'abord le lab"
        [ -S "$VDE_MGMT" ]       || error "Socket management absent → relancer le lab"
        command -v socat >/dev/null || error "socat introuvable → sudo apt install socat"
        return
    fi

    [ -z "$DISK" ]     && error "Aucun disque spécifié. Usage : $0 --count N disk.qcow2"
    [ ! -f "$DISK" ]   && error "Disque introuvable : $DISK"
    [ "$COUNT" -lt 1 ] && error "Le nombre de VMs doit être >= 1"
    [ "$COUNT" -gt 20 ] && warn "Plus de 20 VMs — attention aux ressources système"

    case "$DISK_MODE" in
        shared|snapshot|overlay|copy) ;;
        *) error "--disk-mode invalide : '$DISK_MODE'. Valeurs : shared | snapshot | overlay | copy" ;;
    esac

    if [ "$DISK_MODE" = "overlay" ] || [ "$DISK_MODE" = "copy" ]; then
        command -v qemu-img >/dev/null || \
            error "qemu-img introuvable (requis pour --disk-mode $DISK_MODE)"
    fi

    command -v vde_switch >/dev/null || error "vde_switch introuvable → sudo apt install vde2"
    command -v "$QEMU"    >/dev/null || error "$QEMU introuvable → sudo apt install qemu-system-x86"
    command -v xterm      >/dev/null || error "xterm introuvable → sudo apt install xterm"
    $QEMU -netdev help 2>&1 | grep -q vde || error "Ce QEMU n'a pas le support VDE compilé"

    local nat_status
    nat_status=$([ "$USE_NAT" = true ] && echo "VDE + NAT" || echo "VDE seul")
    info "$COUNT VM(s) | Disque: $(basename "$DISK") | RAM: ${RAM}MB | CPUs: ${CPUS} | Mode: $nat_status"
    info "Réseau VDE : $VDE_NET (base-ip: $BASE_IP) | Disk mode: $DISK_MODE"
}

# -----------------------------------------------------------------------------
# generate_net_script — génère /tmp/setup-net.sh si absent
# -----------------------------------------------------------------------------
generate_net_script() {
    [ -f "$NET_SCRIPT" ] && { info "Script réseau existant conservé → $NET_SCRIPT"; return; }

    section "Génération de $NET_SCRIPT"

    if $USE_NAT; then
        cat > "$NET_SCRIPT" << 'EOF'
#!/bin/sh
# Script réseau généré automatiquement par setup-qemu-vde.sh
STATIC_IP=$(cat /sys/firmware/qemu_fw_cfg/by_name/opt/vm-ip/raw 2>/dev/null)

ip link set eth0 up
[ -n "$STATIC_IP" ] && ip addr add "$STATIC_IP" dev eth0

ip link set eth1 up
udhcpc -i eth1
ip route add default via 10.0.2.2 dev eth1
EOF
    else
        cat > "$NET_SCRIPT" << 'EOF'
#!/bin/sh
# Script réseau généré automatiquement — mode VDE seul
STATIC_IP=$(cat /sys/firmware/qemu_fw_cfg/by_name/opt/vm-ip/raw 2>/dev/null)

ip link set eth0 up
[ -n "$STATIC_IP" ] && ip addr add "$STATIC_IP" dev eth0
EOF
    fi

    chmod 644 "$NET_SCRIPT"
    info "Script réseau généré → $NET_SCRIPT"
}

# -----------------------------------------------------------------------------
# generate_pkg_script — génère /tmp/setup-pkg.sh depuis le fichier packages
# -----------------------------------------------------------------------------
generate_pkg_script() {
    # Si pas de fichier de paquets → pas de script
    if [ ! -f "$PKG_LIST" ]; then
        info "Aucun fichier de paquets trouvé ($PKG_LIST) → pas d'installation automatique"
        PKG_SCRIPT=""
        return
    fi

    section "Génération de $PKG_SCRIPT"

    # Lire les paquets — ignorer lignes vides et commentaires (#)
    local packages
    packages=$(grep -v '^\s*#' "$PKG_LIST" | grep -v '^\s*$' | tr '\n' ' ')

    if [ -z "$packages" ]; then
        warn "Fichier $PKG_LIST vide ou sans paquets valides → pas d'installation"
        PKG_SCRIPT=""
        return
    fi

    cat > "$PKG_SCRIPT" << EOF
#!/bin/sh
# Script d'installation généré automatiquement depuis $(basename "$PKG_LIST")
apk update
apk add $packages
EOF

    chmod 644 "$PKG_SCRIPT"
    info "Script paquets généré → $PKG_SCRIPT"
    info "Paquets à installer : $packages"
}

# -----------------------------------------------------------------------------
# setup_vde — nettoyage et démarrage du switch VDE
# -----------------------------------------------------------------------------
setup_vde() {
    section "Nettoyage"
    pkill -f "vde_switch.*$VDE_SOCKET" 2>/dev/null && { info "Ancien vde_switch arrêté"; sleep 1; } || true
    rm -rf /tmp/vde
    mkdir -p /tmp/vde
    info "Dossier /tmp/vde nettoyé"

    section "Switch VDE"
    if $HUB_MODE; then
        vde_switch -s "$VDE_SOCKET" -m 777 -M "$VDE_MGMT" --hub -d
        info "Switch VDE démarré en mode HUB → tout le trafic visible par vdecapture"
    else
        vde_switch -s "$VDE_SOCKET" -m 777 -M "$VDE_MGMT" -d
        info "Switch VDE démarré en mode SWITCH → seuls les broadcasts visibles par vdecapture"
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
    info "Management     → $VDE_MGMT"
    info "Commandes live → unixterm $VDE_MGMT"
}

# -----------------------------------------------------------------------------
# prepare_disk VM_NUM — retourne le chemin du disque selon DISK_MODE
# Les messages info sont redirigés vers stderr pour ne pas polluer le retour
# -----------------------------------------------------------------------------
prepare_disk() {
    local vm_num=$1

    case "$DISK_MODE" in
        shared)
            echo "-drive file=$DISK,format=qcow2,if=virtio"
            ;;
        snapshot)
            echo "-drive file=$DISK,format=qcow2,if=virtio,snapshot=on"
            ;;
        overlay)
            local overlay="/tmp/vde/vm${vm_num}-disk.qcow2"
            if [ ! -f "$overlay" ]; then
                qemu-img create -f qcow2 -b "$(realpath "$DISK")" -F qcow2 "$overlay" \
                    > /dev/null 2>&1
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

# -----------------------------------------------------------------------------
# launch_vm VM_NUM — prépare et lance une VM dans un xterm
# -----------------------------------------------------------------------------
launch_vm() {
    local vm_num=$1

    # MACs uniques par VM et par interface
    local mac_suffix mac_vde mac_nat
    mac_suffix=$(printf "%02x" "$vm_num")
    mac_vde="52:54:00:12:34:$mac_suffix"
    mac_nat="52:54:00:AB:CD:$mac_suffix"

    # IP et port SSH
    local ip_last static_ip ssh_port
    ip_last=$((BASE_IP + vm_num - 1))
    static_ip="${VDE_PREFIX}.${ip_last}"
    ssh_port=$((BASE_SSH + vm_num - 1))

    # Fichier IP pour fw_cfg
    local ip_file="/tmp/vde/vm${vm_num}-ip"
    echo -n "${static_ip}/${VDE_MASK}" > "$ip_file"

    # Disque selon le mode
    local drive_arg
    drive_arg=$(prepare_disk "$vm_num")

    # Arguments réseau
    local vde_args nat_args fw_cfg
    vde_args="-netdev vde,id=vde0,sock=$VDE_SOCKET -device virtio-net-pci,netdev=vde0,mac=$mac_vde"
    nat_args=""
    $USE_NAT && nat_args="-nic user,hostfwd=tcp::${ssh_port}-:22,mac=$mac_nat"
    fw_cfg="-fw_cfg name=opt/setup-net.sh,file=$NET_SCRIPT -fw_cfg name=opt/vm-ip,file=$ip_file"
    [ -n "$PKG_SCRIPT" ] && fw_cfg="$fw_cfg -fw_cfg name=opt/setup-pkg.sh,file=$PKG_SCRIPT"

    # Écrire la commande dans un fichier pour éviter le bug eval+&
    local cmd_file="/tmp/vde/vm${vm_num}-cmd.sh"
    cat > "$cmd_file" << EOF
#!/bin/bash
$QEMU \\
    -accel tcg,thread=multi -cpu qemu64 \\
    -m $RAM -smp $CPUS \\
    $drive_arg \\
    $vde_args \\
    $nat_args \\
    $fw_cfg \\
    -nographic
EOF
    chmod +x "$cmd_file"

    # Wrapper xterm pour permettre le redémarrage individuel via webgui
    local xterm_file="/tmp/vde/vm${vm_num}-xterm.sh"
    cat > "$xterm_file" << EOF
#!/bin/bash
xterm -title "VM${vm_num} — $static_ip — $DISK_MODE" \
      -geometry 100x25 \
      -fa "DejaVu Sans Mono" \
      -fs 10 \
      -tn xterm-256color \
      -xrm "XTerm*selectToClipboard: true" \
      -xrm "XTerm*translations: #override \\n Ctrl Shift <Key>C: copy-selection(CLIPBOARD) \\n Ctrl Shift <Key>V: insert-selection(CLIPBOARD)" \
      -e "$cmd_file"
EOF
    chmod +x "$xterm_file"

    info "Démarrage VM${vm_num} | MAC: $mac_vde | IP: $static_ip | Disk: $DISK_MODE$([ "$USE_NAT" = true ] && echo " | SSH: localhost:$ssh_port" || echo '')"

    bash "$xterm_file" &

    local pid=$!
    PIDS+=("$pid")
    VM_INFO+=("VM${vm_num}|$mac_vde|$static_ip|$ssh_port|$pid|$DISK_MODE")
}

# -----------------------------------------------------------------------------
# print_summary — affiche le tableau récapitulatif
# -----------------------------------------------------------------------------
print_summary() {
    echo ""
    echo "=================================================================="
    echo -e "${GREEN}  Réseau QEMU+VDE — $COUNT VM(s) démarrée(s)${NC}"
    echo "=================================================================="
    echo ""
    echo "  Disque      : $(basename "$DISK") | Mode: $DISK_MODE"
    echo "  Switch VDE  : $VDE_SOCKET ($( $HUB_MODE && echo 'mode HUB' || echo 'mode SWITCH'))"
    echo "  Management  : $VDE_MGMT  (unixterm $VDE_MGMT)"
    echo "  Réseau VDE  : $VDE_NET (inter-VMs)"
    $USE_NAT && echo "  Réseau NAT  : 10.0.2.0/24 (Internet) | Gateway: 10.0.2.2"
    echo "  Config boot : $NET_SCRIPT (via fw_cfg)"
    $MIRROR && echo "  Mirror      : actif → port $MIRROR_PORT | pipe: $MIRROR_PIPE"
    echo ""

    if $USE_NAT; then
        printf "  %-6s %-20s %-18s %-14s %-10s %s\n" \
            "VM" "MAC eth0 (VDE)" "IP VDE" "SSH host" "Disk" "PID"
        printf "  %-6s %-20s %-18s %-14s %-10s %s\n" \
            "------" "--------------------" "------------------" "--------------" "----------" "-------"
        for info_line in "${VM_INFO[@]}"; do
            IFS='|' read -r vm mac ip ssh_port pid disk_mode <<< "$info_line"
            printf "  %-6s %-20s %-18s %-14s %-10s %s\n" \
                "$vm" "$mac" "$ip" "localhost:$ssh_port" "$disk_mode" "$pid"
        done
    else
        printf "  %-6s %-20s %-18s %-10s %s\n" \
            "VM" "MAC eth0 (VDE)" "IP VDE" "Disk" "PID"
        printf "  %-6s %-20s %-18s %-10s %s\n" \
            "------" "--------------------" "------------------" "----------" "-------"
        for info_line in "${VM_INFO[@]}"; do
            IFS='|' read -r vm mac ip ssh_port pid disk_mode <<< "$info_line"
            printf "  %-6s %-20s %-18s %-10s %s\n" \
                "$vm" "$mac" "$ip" "$disk_mode" "$pid"
        done
    fi

    echo ""
    echo "  Pour arrêter tout :"
    echo "    pkill -f qemu-system-x86_64; pkill vde_switch; rm -rf /tmp/vde"
    echo "=================================================================="

    printf "%s\n" "${PIDS[@]}" > /tmp/vde/vm_pids.txt
    info "PIDs sauvegardés dans /tmp/vde/vm_pids.txt"
}

# -----------------------------------------------------------------------------
# start_mirror — lance vdecapture + configure port mirroring + ouvre Wireshark
# -----------------------------------------------------------------------------
start_mirror() {
    section "Port mirroring — capture Wireshark"

    command -v vdecapture >/dev/null || error "vdecapture introuvable → compiler depuis https://github.com/virtualsquare/vdecapture"
    command -v socat      >/dev/null || error "socat introuvable → sudo apt install socat"

    # 1. Créer le pipe nommé
    rm -f "$MIRROR_PIPE"
    if ! mkfifo "$MIRROR_PIPE" 2>/tmp/vde/mirror_err; then
        error "Impossible de créer le pipe : $(cat /tmp/vde/mirror_err)"
    fi
    info "Pipe créé → $MIRROR_PIPE"

    # 2. Lancer vdecapture
    vdecapture "$VDE_SOCKET" - > "$MIRROR_PIPE" 2>/tmp/vde/vdecapture.log &
    local vcap_pid=$!
    info "vdecapture démarré (PID $vcap_pid)"

    sleep 1
    if ! kill -0 "$vcap_pid" 2>/dev/null; then
        error "vdecapture a planté — log : $(cat /tmp/vde/vdecapture.log)"
    fi

    # 3. Demander à l'utilisateur de lancer Wireshark
    echo ""
    echo "=================================================================="
    echo -e "${YELLOW}  Action requise — lancer Wireshark${NC}"
    echo "=================================================================="
    echo ""
    echo -e "  ${GREEN}sudo wireshark -k -i $MIRROR_PIPE${NC}"
    echo ""
    read -r -p "Appuyer sur [Entrée] une fois Wireshark lancé et prêt..."

    # 4. Récupérer le dernier port connecté (celui de Wireshark)
    info "Récupération du port Wireshark..."
    local max_wait=10
    local waited=0

    while [ $waited -lt $max_wait ]; do
        local port_output
        port_output=$(echo "port/print" | socat - UNIX-CONNECT:"$VDE_MGMT" 2>/tmp/vde/mirror_err)
        MIRROR_PORT=$(echo "$port_output" \
            | grep "^Port" | tail -1 | awk '{print $2}' | sed 's/^0*//')

        [ -n "$MIRROR_PORT" ] && break

        sleep 1
        waited=$((waited + 1))
    done

    if [ -z "$MIRROR_PORT" ]; then
        error "Port Wireshark introuvable après ${max_wait}s — log : $(cat /tmp/vde/vdecapture.log)"
    fi

    info "Port Wireshark détecté : $MIRROR_PORT"

    # Passer ce port en mode hub
    echo "port/sethub $MIRROR_PORT 1" | socat - UNIX-CONNECT:"$VDE_MGMT" 2>/tmp/vde/mirror_err \
        || error "port/sethub a échoué : $(cat /tmp/vde/mirror_err)"

    echo "$vcap_pid" >> /tmp/vde/vm_pids.txt

    info "Port $MIRROR_PORT en mode HUB → mirror actif"
    info "Tout le trafic inter-VMs est visible dans Wireshark"
}

# -----------------------------------------------------------------------------
# stop_lab — arrêt propre de toutes les VMs et du switch VDE
# -----------------------------------------------------------------------------
stop_lab() {
    section "Arrêt du lab"

    # Arrêt des xterms via les PIDs sauvegardés
    if [ -f /tmp/vde/vm_pids.txt ]; then
        info "Arrêt des xterms..."
        while read -r pid; do
            if kill -0 "$pid" 2>/dev/null; then
                kill "$pid" 2>/dev/null
                info "xterm PID $pid arrêté"
            else
                warn "xterm PID $pid déjà arrêté"
            fi
        done < /tmp/vde/vm_pids.txt
    fi

    # Arrêt direct des processus QEMU (enfants des xterms)
    if pgrep -f "qemu-system-x86_64" > /dev/null 2>&1; then
        pkill -f "qemu-system-x86_64" 2>/dev/null
        sleep 1
        # Si toujours actif — forcer avec SIGKILL
        if pgrep -f "qemu-system-x86_64" > /dev/null 2>&1; then
            pkill -9 -f "qemu-system-x86_64" 2>/dev/null
            warn "QEMU forcé à s'arrêter (SIGKILL)"
        fi
        info "Processus QEMU arrêtés"
    else
        warn "Aucun processus QEMU trouvé"
    fi

    # Arrêt de vdecapture si actif
    if pgrep -f vdecapture > /dev/null 2>&1; then
        pkill -f vdecapture
        info "vdecapture arrêté"
    fi

    # Arrêt de Wireshark si actif
    if pgrep -f wireshark > /dev/null 2>&1; then
        pkill -f wireshark
        info "Wireshark arrêté"
    fi

    # Nettoyage du pipe mirror et logs
    rm -f "$MIRROR_PIPE"
    rm -f /tmp/vde/vdecapture.log /tmp/vde/mirror_err
    info "Pipe mirror et logs supprimés"

    # Arrêt de slirpvde si actif
    if pgrep -f slirpvde > /dev/null 2>&1; then
        pkill -f slirpvde
        info "slirpvde arrêté"
    fi

    # Arrêt du switch VDE
    if pgrep -f "vde_switch.*$VDE_SOCKET" > /dev/null 2>&1; then
        pkill -f "vde_switch.*$VDE_SOCKET"
        info "vde_switch arrêté"
    else
        warn "vde_switch déjà arrêté"
    fi

    # Nettoyage des fichiers temporaires
    if [ -d /tmp/vde ]; then
        rm -rf /tmp/vde
        info "Dossier /tmp/vde supprimé"
    fi

    echo ""
    echo "=================================================================="
    echo -e "${GREEN}  Lab arrêté proprement${NC}"
    echo "=================================================================="
}

# =============================================================================
# MAIN
# =============================================================================
parse_args "$@"

# Mode arrêt
if $STOP; then
    stop_lab
    exit 0
fi

# Mode mirror seul — lab déjà lancé
if $MIRROR; then
    check_deps
    start_mirror
    exit 0
fi

check_deps
generate_net_script
generate_pkg_script
setup_vde

section "Démarrage des $COUNT VM(s) via xterm"
for i in $(seq 1 "$COUNT"); do
    launch_vm "$i"
    sleep 1
done

print_summary