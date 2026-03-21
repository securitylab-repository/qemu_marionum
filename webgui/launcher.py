"""
launcher.py — Generateur de script bash pour lancement per-VM.

Quand les VMs ont des configurations individuelles (disque, RAM, CPU, mode disque
differents), ce module genere un script bash `/tmp/vde/webgui-launch.sh` qui
replique la logique des scripts existants (fwcfg.sh, cloudinit.sh) mais avec
des parametres par VM.
"""

import os
import stat

LAUNCH_SCRIPT = "/tmp/vde/webgui-launch.sh"


def generate_launcher(params):
    """Genere le script de lancement per-VM et retourne la commande a executer."""
    backend = params.get("backend", "cloudinit")
    vms = params.get("vms", [])
    if not vms:
        return None

    g = {
        "disk": params.get("disk", ""),
        "ram": params.get("ram", 1024 if backend != "fwcfg" else 512),
        "cpu": params.get("cpu", 2),
        "disk_mode": params.get("disk_mode", "snapshot"),
        "vde_net": params.get("vde_net", "192.168.100.0/24"),
        "base_ip": params.get("base_ip", 10),
        "base_ssh": params.get("base_ssh", 2222),
        "no_nat": params.get("no_nat", False),
        "hub": params.get("hub", False),
        "mirror": params.get("mirror", False),
        "pkg_list": params.get("pkg_list", ""),
        "password": params.get("password", ""),
        "ssh_key": params.get("ssh_key", ""),
        "seeds_dir": params.get("seeds_dir", "/tmp/vde/seeds"),
        "net_script": params.get("net_script", ""),
    }

    lines = []
    lines.append(_preamble(g))
    lines.append(_vde_setup_block(g))

    # Generer le script reseau fwcfg si au moins une VM utilise fwcfg
    any_fwcfg = backend == "fwcfg" or any(
        vm.get("backend") == "fwcfg" for vm in vms
    )
    if any_fwcfg:
        lines.append(_fwcfg_net_script_block(g))

    for i, vm in enumerate(vms):
        vm_num = i + 1
        vm_backend = vm.get("backend") or backend
        resolved = {
            "disk": vm.get("disk") or g["disk"],
            "ram": vm.get("ram") or g["ram"],
            "cpu": vm.get("cpu") or g["cpu"],
            "disk_mode": vm.get("disk_mode") or g["disk_mode"],
        }
        lines.append(f'\nsection "VM{vm_num}"')
        lines.append(_disk_prep_block(vm_num, resolved))

        if vm_backend in ("cloudinit", "vwifi"):
            lines.append(_cloudinit_seed_block(vm_num, resolved, g))
        elif vm_backend == "fwcfg":
            lines.append(_fwcfg_config_block(vm_num, g))

        lines.append(_qemu_launch_block(vm_num, resolved, g, vm_backend))

    lines.append(_summary_block(vms, g))

    script_content = "\n".join(lines) + "\n"

    os.makedirs("/tmp/vde", exist_ok=True)
    with open(LAUNCH_SCRIPT, "w") as f:
        f.write(script_content)
    os.chmod(LAUNCH_SCRIPT, stat.S_IRWXU | stat.S_IRGRP | stat.S_IXGRP)

    return ["bash", LAUNCH_SCRIPT]


def _preamble(g):
    vde_prefix = _vde_prefix(g["vde_net"])
    vde_mask = g["vde_net"].split("/")[1] if "/" in g["vde_net"] else "24"
    use_nat = "true" if not g["no_nat"] else "false"
    hub_mode = "true" if g["hub"] else "false"

    return f"""#!/bin/bash
set -e

# Genere automatiquement par webgui — lancement per-VM
# Ne pas editer a la main.

GREEN='\\033[0;32m'
RED='\\033[0;31m'
YELLOW='\\033[1;33m'
BLUE='\\033[0;34m'
NC='\\033[0m'

info()    {{ echo -e "${{GREEN}}[INFO]${{NC}} $1"; }}
warn()    {{ echo -e "${{YELLOW}}[WARN]${{NC}} $1"; }}
error()   {{ echo -e "${{RED}}[ERROR]${{NC}} $1"; exit 1; }}
section() {{ echo -e "\\n${{BLUE}}==== $1 ====${{NC}}"; }}

VDE_SOCKET="/tmp/vde/switch"
VDE_MGMT="/tmp/vde/mgmt"
VDE_NET="{g['vde_net']}"
VDE_PREFIX="{vde_prefix}"
VDE_MASK="{vde_mask}"
BASE_IP={g['base_ip']}
BASE_SSH={g['base_ssh']}
USE_NAT={use_nat}
HUB_MODE={hub_mode}
QEMU="qemu-system-x86_64"
SEEDS_DIR="{g['seeds_dir']}"

PIDS=()
VM_INFO=()"""


def _vde_setup_block(g):
    hub_flag = " --hub" if g["hub"] else ""
    return f"""
section "Nettoyage"
pkill -f "vde_switch.*$VDE_SOCKET" 2>/dev/null && {{ info "Ancien vde_switch arrete"; sleep 1; }} || true
rm -rf /tmp/vde
mkdir -p /tmp/vde "{g['seeds_dir']}"
info "/tmp/vde nettoye"

section "Switch VDE"
vde_switch -s "$VDE_SOCKET" -m 777 -M "$VDE_MGMT"{hub_flag} -d
sleep 1

[ -S "$VDE_SOCKET/ctl" ] || error "Socket VDE non cree : $VDE_SOCKET/ctl"
info "Switch VDE     → $VDE_SOCKET/ctl"
info "Management     → $VDE_MGMT"
"""


def _fwcfg_net_script_block(g):
    net_script = g.get("net_script") or "/tmp/setup-net.sh"
    if g["no_nat"]:
        net_body = """#!/bin/sh
STATIC_IP=$(cat /sys/firmware/qemu_fw_cfg/by_name/opt/vm-ip/raw 2>/dev/null)
ip link set eth0 up
[ -n "$STATIC_IP" ] && ip addr add "$STATIC_IP" dev eth0"""
    else:
        net_body = """#!/bin/sh
STATIC_IP=$(cat /sys/firmware/qemu_fw_cfg/by_name/opt/vm-ip/raw 2>/dev/null)
ip link set eth0 up
[ -n "$STATIC_IP" ] && ip addr add "$STATIC_IP" dev eth0
ip link set eth1 up
udhcpc -i eth1
ip route add default via 10.0.2.2 dev eth1"""

    return f"""NET_SCRIPT="{net_script}"
if [ ! -f "$NET_SCRIPT" ]; then
cat > "$NET_SCRIPT" << 'NETEOF'
{net_body}
NETEOF
chmod 644 "$NET_SCRIPT"
info "Script reseau genere → $NET_SCRIPT"
fi
"""


def _disk_prep_block(vm_num, resolved):
    disk = resolved["disk"]
    mode = resolved["disk_mode"]

    if mode == "shared":
        return f'DRIVE_VM{vm_num}="-drive file={disk},format=qcow2,if=virtio"'
    elif mode == "snapshot":
        return f'DRIVE_VM{vm_num}="-drive file={disk},format=qcow2,if=virtio,snapshot=on"'
    elif mode == "overlay":
        return f"""OVERLAY_VM{vm_num}="/tmp/vde/vm{vm_num}-disk.qcow2"
if [ ! -f "$OVERLAY_VM{vm_num}" ]; then
    qemu-img create -f qcow2 -b "$(realpath "{disk}")" -F qcow2 "$OVERLAY_VM{vm_num}" > /dev/null 2>&1
    info "Overlay cree → $OVERLAY_VM{vm_num}"
fi
DRIVE_VM{vm_num}="-drive file=$OVERLAY_VM{vm_num},format=qcow2,if=virtio\""""
    elif mode == "copy":
        return f"""COPY_VM{vm_num}="/tmp/vde/vm{vm_num}-disk.qcow2"
if [ ! -f "$COPY_VM{vm_num}" ]; then
    info "Copie du disque pour VM{vm_num}..."
    cp "{disk}" "$COPY_VM{vm_num}"
    info "Copie creee → $COPY_VM{vm_num}"
fi
DRIVE_VM{vm_num}="-drive file=$COPY_VM{vm_num},format=qcow2,if=virtio\""""
    return ""


def _cloudinit_seed_block(vm_num, resolved, g):
    vde_prefix = _vde_prefix(g["vde_net"])
    vde_mask = g["vde_net"].split("/")[1] if "/" in g["vde_net"] else "24"
    ip_last = g["base_ip"] + vm_num - 1
    static_ip = f"{vde_prefix}.{ip_last}"
    mac_suffix = f"{vm_num:02x}"
    mac_vde = f"52:54:00:12:34:{mac_suffix}"
    mac_nat = f"52:54:00:AB:CD:{mac_suffix}"
    seeds_dir = g["seeds_dir"]

    # Password hashing
    pass_setup = ""
    pass_userdata = ""
    if g.get("password"):
        pass_setup = f"""
# Hasher le mot de passe
HASHED_PASS_VM{vm_num}=$(python3 -c "
import crypt, sys
print(crypt.crypt(sys.argv[1], crypt.mksalt(crypt.METHOD_SHA512)))
" "{g['password']}")"""
        pass_userdata = f"""
    passwd: "$HASHED_PASS_VM{vm_num}"
    lock_passwd: false"""

    # SSH key
    ssh_setup = ""
    ssh_userdata = ""
    if g.get("ssh_key"):
        ssh_setup = f"""
SSH_KEY_CONTENT_VM{vm_num}=$(cat "{g['ssh_key']}" 2>/dev/null || echo "")"""
        ssh_userdata = f"""
    ssh_authorized_keys:
      - $SSH_KEY_CONTENT_VM{vm_num}"""

    # Packages
    pkg_setup = ""
    pkg_userdata = ""
    if g.get("pkg_list"):
        pkg_setup = f"""
PKG_BLOCK_VM{vm_num}="packages:"
while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ -z "${{line//[[:space:]]/}}" ]] && continue
    PKG_BLOCK_VM{vm_num}="${{PKG_BLOCK_VM{vm_num}}}
  - $(echo "$line" | xargs)"
done < "{g['pkg_list']}"
"""
        pkg_userdata = f"""

${{PKG_BLOCK_VM{vm_num}}}"""

    # NAT network config
    nat_network = ""
    if not g["no_nat"]:
        nat_network = f"""
  nat-iface:
    match:
      macaddress: "{mac_nat}"
    dhcp4: true
    dhcp4-overrides:
      route-metric: 100"""

    return f"""
SEED_DIR_VM{vm_num}="{seeds_dir}/vm{vm_num}"
SEED_ISO_VM{vm_num}="{seeds_dir}/seed-vm{vm_num}.iso"
mkdir -p "$SEED_DIR_VM{vm_num}"
{pass_setup}
{ssh_setup}
{pkg_setup}
cat > "$SEED_DIR_VM{vm_num}/meta-data" << METAEOF
instance-id: vm{vm_num}-$(date +%s)
local-hostname: debian-vm{vm_num}
METAEOF

cat > "$SEED_DIR_VM{vm_num}/user-data" << UDEOF
#cloud-config

users:
  - name: debian
    groups: sudo
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL{pass_userdata}{ssh_userdata}
{pkg_userdata}

runcmd:
  - sed -i 's/^#\\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config
  - systemctl restart ssh
  - echo "Lab VM{vm_num} ready at \\$(date)" > /var/log/lab-ready.log

final_message: ""
UDEOF

cat > "$SEED_DIR_VM{vm_num}/network-config" << NCEOF
version: 2
ethernets:
  vde-iface:
    match:
      macaddress: "{mac_vde}"
    addresses:
      - {static_ip}/{vde_mask}{nat_network}
NCEOF

if command -v cloud-localds >/dev/null; then
    cloud-localds \\
        --network-config "$SEED_DIR_VM{vm_num}/network-config" \\
        "$SEED_ISO_VM{vm_num}" \\
        "$SEED_DIR_VM{vm_num}/user-data" \\
        "$SEED_DIR_VM{vm_num}/meta-data" \\
        2>/dev/null
else
    genisoimage \\
        -output "$SEED_ISO_VM{vm_num}" \\
        -volid cidata \\
        -joliet -rock \\
        "$SEED_DIR_VM{vm_num}/user-data" \\
        "$SEED_DIR_VM{vm_num}/meta-data" \\
        "$SEED_DIR_VM{vm_num}/network-config" \\
        2>/dev/null
fi
info "Seed ISO → $SEED_ISO_VM{vm_num}"
"""


def _fwcfg_config_block(vm_num, g):
    vde_prefix = _vde_prefix(g["vde_net"])
    vde_mask = g["vde_net"].split("/")[1] if "/" in g["vde_net"] else "24"
    ip_last = g["base_ip"] + vm_num - 1
    static_ip = f"{vde_prefix}.{ip_last}"

    return f"""IP_FILE_VM{vm_num}="/tmp/vde/vm{vm_num}-ip"
echo -n "{static_ip}/{vde_mask}" > "$IP_FILE_VM{vm_num}"
"""


def _resolve_drive_arg(vm_num, resolved):
    """Retourne l'argument -drive QEMU avec le chemin reel du disque."""
    disk = resolved["disk"]
    mode = resolved["disk_mode"]
    if mode == "shared":
        return f"-drive file={disk},format=qcow2,if=virtio"
    elif mode == "snapshot":
        return f"-drive file={disk},format=qcow2,if=virtio,snapshot=on"
    elif mode in ("overlay", "copy"):
        return f"-drive file=/tmp/vde/vm{vm_num}-disk.qcow2,format=qcow2,if=virtio"
    return f"-drive file={disk},format=qcow2,if=virtio,snapshot=on"


def _qemu_launch_block(vm_num, resolved, g, backend):
    vde_prefix = _vde_prefix(g["vde_net"])
    ip_last = g["base_ip"] + vm_num - 1
    static_ip = f"{vde_prefix}.{ip_last}"
    ssh_port = g["base_ssh"] + vm_num - 1
    mac_suffix = f"{vm_num:02x}"
    mac_vde = f"52:54:00:12:34:{mac_suffix}"
    mac_nat = f"52:54:00:AB:CD:{mac_suffix}"
    ram = resolved["ram"]
    cpu = resolved["cpu"]
    disk_mode = resolved["disk_mode"]

    # Resoudre les valeurs inline (pas de references $VAR dans le heredoc)
    drive_arg = _resolve_drive_arg(vm_num, resolved)
    vde_socket = "/tmp/vde/switch"
    seeds_dir = g["seeds_dir"]
    net_script = g.get("net_script") or "/tmp/setup-net.sh"

    if backend in ("cloudinit", "vwifi"):
        vde_args = f'-netdev vde,id=vde0,sock={vde_socket} -device virtio-net-pci,netdev=vde0,mac={mac_vde},addr=0x4'
        nat_args = ""
        if not g["no_nat"]:
            nat_args = f'-netdev user,id=nat0,hostfwd=tcp::{ssh_port}-:22 -device virtio-net-pci,netdev=nat0,mac={mac_nat},addr=0x5'
        seed_arg = f'-drive file={seeds_dir}/seed-vm{vm_num}.iso,format=raw,if=virtio,readonly=on'
        fw_cfg_args = ""
    else:
        vde_args = f'-netdev vde,id=vde0,sock={vde_socket} -device virtio-net-pci,netdev=vde0,mac={mac_vde}'
        nat_args = ""
        if not g["no_nat"]:
            nat_args = f'-nic user,hostfwd=tcp::{ssh_port}-:22,mac={mac_nat}'
        seed_arg = ""
        fw_cfg_args = f'-fw_cfg name=opt/setup-net.sh,file={net_script} -fw_cfg name=opt/vm-ip,file=/tmp/vde/vm{vm_num}-ip'

    if backend == "fwcfg":
        geometry = "100x25"
        xterm_colors = ""
    else:
        geometry = "120x30"
        xterm_colors = '-bg "#1e1e1e" -fg "#d4d4d4" '

    # Construire la commande QEMU avec valeurs inline
    qemu_lines = [
        "qemu-system-x86_64 \\",
        "    -accel tcg,thread=multi -cpu qemu64 \\",
        f"    -m {ram} -smp {cpu} \\",
        f"    {drive_arg} \\",
    ]
    if seed_arg:
        qemu_lines.append(f"    {seed_arg} \\")
    qemu_lines.append(f"    {vde_args} \\")
    if nat_args:
        qemu_lines.append(f"    {nat_args} \\")
    if fw_cfg_args:
        qemu_lines.append(f"    {fw_cfg_args} \\")
    qemu_lines.append("    -nographic")

    qemu_cmd = "\n".join(qemu_lines)

    return f"""CMD_FILE_VM{vm_num}="/tmp/vde/vm{vm_num}-cmd.sh"
cat > "$CMD_FILE_VM{vm_num}" << 'CMDEOF'
#!/bin/bash
{qemu_cmd}
CMDEOF
chmod +x "$CMD_FILE_VM{vm_num}"

info "VM{vm_num} | {mac_vde} | {static_ip} | {disk_mode} | RAM:{ram} | CPU:{cpu}$([ "$USE_NAT" = true ] && echo " | SSH: localhost:{ssh_port}" || echo '')"

xterm -title "VM{vm_num} — {static_ip} — {disk_mode}" \\
      -geometry {geometry} \\
      -fa "DejaVu Sans Mono" \\
      -fs 10 \\
      -tn xterm-256color \\
      {xterm_colors}-xrm "XTerm*selectToClipboard: true" \\
      -xrm "XTerm*translations: #override \\\\n Ctrl Shift <Key>C: copy-selection(CLIPBOARD) \\\\n Ctrl Shift <Key>V: insert-selection(CLIPBOARD)" \\
      -e "$CMD_FILE_VM{vm_num}" &

PIDS+=("$!")
VM_INFO+=("VM{vm_num}|{mac_vde}|{static_ip}|{ssh_port}|$!|{disk_mode}")
"""


def _summary_block(vms, g):
    count = len(vms)
    return f"""
section "Resume"
echo ""
echo "=================================================================="
echo -e "${{GREEN}}  Lab QEMU+VDE — {count} VM(s) demarree(s) (per-VM config)${{NC}}"
echo "=================================================================="
echo ""
echo "  Switch VDE : $VDE_SOCKET ($($HUB_MODE && echo 'HUB' || echo 'SWITCH'))"
echo "  Reseau VDE : $VDE_NET"
$USE_NAT && echo "  NAT        : 10.0.2.0/24 | Gateway: 10.0.2.2"
echo ""

for info_line in "${{VM_INFO[@]}}"; do
    IFS='|' read -r vm mac ip ssh_port pid disk_mode <<< "$info_line"
    echo "  $vm | $mac | $ip | Mode: $disk_mode | PID: $pid$([ "$USE_NAT" = true ] && echo " | SSH: localhost:$ssh_port" || echo '')"
done

echo ""
echo "  Arret : ./fwcfg.sh --stop  (ou ./cloudinit.sh --stop)"
echo "=================================================================="

printf "%s\\n" "${{PIDS[@]}}" > /tmp/vde/vm_pids.txt
info "PIDs sauvegardes dans /tmp/vde/vm_pids.txt"

# Attendre que toutes les VMs se terminent
wait
"""


def _vde_prefix(vde_net):
    """Extrait le prefixe reseau (3 premiers octets) du CIDR."""
    ip_part = vde_net.split("/")[0]
    octets = ip_part.split(".")
    return ".".join(octets[:3])
