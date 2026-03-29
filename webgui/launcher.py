"""
launcher.py — Generateur de script bash pour lancement per-VM.

Quand les VMs ont des configurations individuelles (disque, RAM, CPU, mode disque
differents), ce module genere un script bash `/tmp/vde/webgui-launch.sh` qui
replique la logique des scripts existants (fwcfg.sh, cloudinit.sh) mais avec
des parametres par VM.
"""

import json
import os
import stat

LAUNCH_SCRIPT = "/tmp/vde/webgui-launch.sh"

# Constantes vwifi-server
VWIFI_SERVER_RAM = 512
VWIFI_SERVER_CPUS = 1
VWIFI_SERVER_IP_LAST = 2
VWIFI_SERVER_MAC_VDE = "52:54:00:FF:00:01"
VWIFI_SERVER_MAC_NAT = "52:54:00:FF:01:01"
VWIFI_SERVER_SSH_OFFSET = 100


def generate_launcher(params):
    """Genere le script de lancement per-VM et retourne la commande a executer."""
    vms = params.get("vms", [])
    if not vms:
        return None

    g = {
        "disk": params.get("disk", ""),
        "ram": params.get("ram", 1024),
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
        "wlan_count": params.get("wlan_count", 1),
    }

    # Serveur explicite (optionnel)
    server = params.get("server")

    lines = []
    lines.append(_preamble(g))
    lines.append(_vde_setup_block(g))

    # Generer le script reseau fwcfg si au moins une VM utilise fwcfg
    any_fwcfg = any(
        vm.get("backend") in ("fwcfg", "vwifi_fwcfg") for vm in vms
    )
    # Aussi verifier le serveur
    if server and server.get("backend") == "fwcfg":
        any_fwcfg = True
    if any_fwcfg:
        lines.append(_fwcfg_net_script_block(g))

    # Serveur vwifi (explicite)
    if server:
        server_backend = server.get("backend", "cloudinit")
        lines.append('\nsection "vwifi-server"')
        lines.append(_vwifi_server_launch_block(g, server_backend, server))

    for i, vm in enumerate(vms):
        vm_num = i + 1
        vm_backend = vm.get("backend", "cloudinit")
        # RAM par defaut selon le backend de la VM
        default_ram = 512 if vm_backend in ("fwcfg", "vwifi_fwcfg") else 1024
        resolved = {
            "disk": vm.get("disk") or g["disk"],
            "ram": vm.get("ram") or g["ram"] or default_ram,
            "cpu": vm.get("cpu") or g["cpu"],
            "disk_mode": vm.get("disk_mode") or g["disk_mode"],
        }
        # Per-VM globals override pour le seed
        vm_g = dict(g)
        if vm.get("pkg_list"):
            vm_g["pkg_list"] = vm["pkg_list"]
        if vm.get("wlan_count"):
            vm_g["wlan_count"] = vm["wlan_count"]
        lines.append(f'\nsection "VM{vm_num}"')
        lines.append(_disk_prep_block(vm_num, resolved))

        if vm_backend == "vwifi_cloudinit":
            lines.append(_vwifi_client_seed_block(vm_num, resolved, vm_g))
        elif vm_backend == "vwifi_fwcfg":
            lines.append(_fwcfg_config_block(vm_num, vm_g))
            lines.append(_vwifi_client_fwcfg_block(vm_num, vm_g))
        elif vm_backend == "cloudinit":
            lines.append(_cloudinit_seed_block(vm_num, resolved, vm_g))
        elif vm_backend == "fwcfg":
            lines.append(_fwcfg_config_block(vm_num, vm_g))

        lines.append(_qemu_launch_block(vm_num, resolved, g, vm_backend))

    lines.append(_summary_block(vms, g, server is not None, server))

    script_content = "\n".join(lines) + "\n"

    os.makedirs("/tmp/vde", exist_ok=True)
    with open(LAUNCH_SCRIPT, "w") as f:
        f.write(script_content)
    os.chmod(LAUNCH_SCRIPT, stat.S_IRWXU | stat.S_IRGRP | stat.S_IXGRP)

    # Sauvegarder les parametres pour restart
    with open("/tmp/vde/params.json", "w") as f:
        json.dump(params, f, indent=2)

    return ["bash", LAUNCH_SCRIPT]


def generate_single_vm_script(params, vm_config, vm_num):
    """Genere les scripts pour une seule VM (ajout dynamique au lab running).

    Cree vmN-cmd.sh, vmN-xterm.sh et un script setup qui prepare le disque
    et le seed, puis lance la VM.
    Retourne le chemin du script setup.
    """
    g = {
        "disk": params.get("disk", ""),
        "ram": params.get("ram", 1024),
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
        "wlan_count": params.get("wlan_count", 1),
    }

    vm_backend = vm_config.get("backend", "cloudinit")
    default_ram = 512 if vm_backend in ("fwcfg", "vwifi_fwcfg") else 1024
    resolved = {
        "disk": vm_config.get("disk") or g["disk"],
        "ram": vm_config.get("ram") or g["ram"] or default_ram,
        "cpu": vm_config.get("cpu") or g["cpu"],
        "disk_mode": vm_config.get("disk_mode") or g["disk_mode"],
    }
    vm_g = dict(g)
    if vm_config.get("pkg_list"):
        vm_g["pkg_list"] = vm_config["pkg_list"]
    if vm_config.get("wlan_count"):
        vm_g["wlan_count"] = vm_config["wlan_count"]

    lines = []
    lines.append("#!/bin/bash")
    lines.append("set -e")
    lines.append("")
    lines.append("GREEN='\\033[0;32m'")
    lines.append("NC='\\033[0m'")
    lines.append("info() { echo -e \"${GREEN}[INFO]${NC} $1\"; }")
    lines.append(f'SEEDS_DIR="{g["seeds_dir"]}"')
    lines.append(f'mkdir -p "$SEEDS_DIR"')
    lines.append("")
    lines.append(_disk_prep_block(vm_num, resolved))

    if vm_backend == "vwifi_cloudinit":
        lines.append(_vwifi_client_seed_block(vm_num, resolved, vm_g))
    elif vm_backend == "vwifi_fwcfg":
        lines.append(_fwcfg_config_block(vm_num, vm_g))
        lines.append(_vwifi_client_fwcfg_block(vm_num, vm_g))
    elif vm_backend == "cloudinit":
        lines.append(_cloudinit_seed_block(vm_num, resolved, vm_g))
    elif vm_backend == "fwcfg":
        lines.append(_fwcfg_config_block(vm_num, vm_g))

    lines.append(_qemu_launch_block(vm_num, resolved, vm_g, vm_backend))

    script_content = "\n".join(lines) + "\n"
    script_path = f"/tmp/vde/vm{vm_num}-setup.sh"

    os.makedirs("/tmp/vde", exist_ok=True)
    with open(script_path, "w") as f:
        f.write(script_content)
    os.chmod(script_path, stat.S_IRWXU | stat.S_IRGRP | stat.S_IXGRP)

    return script_path


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
section "Preparation"
pkill -f "vde_switch.*$VDE_SOCKET" 2>/dev/null && {{ info "Ancien vde_switch arrete"; sleep 1; }} || true
mkdir -p /tmp/vde "{g['seeds_dir']}"

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

    if backend in ("cloudinit", "vwifi_cloudinit"):
        vde_args = f'-netdev vde,id=vde0,sock={vde_socket} -device virtio-net-pci,netdev=vde0,mac={mac_vde},addr=0x4'
        nat_args = ""
        if not g["no_nat"]:
            nat_args = f'-netdev user,id=nat0,hostfwd=tcp::{ssh_port}-:22 -device virtio-net-pci,netdev=nat0,mac={mac_nat},addr=0x5'
        seed_arg = f'-drive file={seeds_dir}/seed-vm{vm_num}.iso,format=raw,if=virtio,readonly=on'
        fw_cfg_args = ""
    elif backend == "vwifi_fwcfg":
        vde_args = f'-netdev vde,id=vde0,sock={vde_socket} -device virtio-net-pci,netdev=vde0,mac={mac_vde}'
        nat_args = ""
        if not g["no_nat"]:
            nat_args = f'-nic user,hostfwd=tcp::{ssh_port}-:22,mac={mac_nat}'
        seed_arg = ""
        vde_prefix = _vde_prefix(g["vde_net"])
        server_ip = f"{vde_prefix}.{VWIFI_SERVER_IP_LAST}"
        wlan_count = g.get("wlan_count", 1)
        fw_cfg_args = (
            f'-fw_cfg name=opt/setup-net.sh,file={net_script}'
            f' -fw_cfg name=opt/vm-ip,file=/tmp/vde/vm{vm_num}-ip'
            f' -fw_cfg name=opt/vwifi-role,file=/tmp/vde/vm{vm_num}-vwifi-role'
            f' -fw_cfg name=opt/vwifi-server-ip,file=/tmp/vde/vm{vm_num}-vwifi-server-ip'
            f' -fw_cfg name=opt/vwifi-wlan-count,file=/tmp/vde/vm{vm_num}-vwifi-wlan-count'
        )
    else:
        vde_args = f'-netdev vde,id=vde0,sock={vde_socket} -device virtio-net-pci,netdev=vde0,mac={mac_vde}'
        nat_args = ""
        if not g["no_nat"]:
            nat_args = f'-nic user,hostfwd=tcp::{ssh_port}-:22,mac={mac_nat}'
        seed_arg = ""
        fw_cfg_args = f'-fw_cfg name=opt/setup-net.sh,file={net_script} -fw_cfg name=opt/vm-ip,file=/tmp/vde/vm{vm_num}-ip'

    if backend in ("fwcfg", "vwifi_fwcfg"):
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

    xterm_cmd_lines = [
        f'xterm -title "VM{vm_num} — {static_ip} — {disk_mode}" \\',
        f'      -geometry {geometry} \\',
        f'      -fa "DejaVu Sans Mono" \\',
        f'      -fs 10 \\',
        f'      -tn xterm-256color \\',
        f'      {xterm_colors}-xrm "XTerm*selectToClipboard: true" \\',
        f'      -xrm "XTerm*translations: #override \\\\n Ctrl Shift <Key>C: copy-selection(CLIPBOARD) \\\\n Ctrl Shift <Key>V: insert-selection(CLIPBOARD)" \\',
        f'      -e "/tmp/vde/vm{vm_num}-cmd.sh"',
    ]
    xterm_cmd = "\n".join(xterm_cmd_lines)

    return f"""CMD_FILE_VM{vm_num}="/tmp/vde/vm{vm_num}-cmd.sh"
cat > "$CMD_FILE_VM{vm_num}" << 'CMDEOF'
#!/bin/bash
{qemu_cmd}
CMDEOF
chmod +x "$CMD_FILE_VM{vm_num}"

XTERM_FILE_VM{vm_num}="/tmp/vde/vm{vm_num}-xterm.sh"
cat > "$XTERM_FILE_VM{vm_num}" << 'XTEOF'
#!/bin/bash
{xterm_cmd}
XTEOF
chmod +x "$XTERM_FILE_VM{vm_num}"

info "VM{vm_num} | {mac_vde} | {static_ip} | {disk_mode} | RAM:{ram} | CPU:{cpu}$([ "$USE_NAT" = true ] && echo " | SSH: localhost:{ssh_port}" || echo '')"

bash "$XTERM_FILE_VM{vm_num}" &

PIDS+=("$!")
VM_INFO+=("VM{vm_num}|{mac_vde}|{static_ip}|{ssh_port}|$!|{disk_mode}")
"""


def _summary_block(vms, g, has_server=False, server_config=None):
    count = len(vms)
    vde_prefix = _vde_prefix(g["vde_net"])
    server_ip = f"{vde_prefix}.{VWIFI_SERVER_IP_LAST}"
    srv_ram = (server_config or {}).get("ram") or VWIFI_SERVER_RAM
    srv_cpu = (server_config or {}).get("cpu") or VWIFI_SERVER_CPUS
    srv_ssh = g["base_ssh"] + VWIFI_SERVER_SSH_OFFSET

    vwifi_summary = ""
    if has_server:
        vwifi_summary = f"""
echo "  --- vwifi-server ---"
echo "  IP: {server_ip} | RAM: {srv_ram}MB | CPU: {srv_cpu}$([ "$USE_NAT" = true ] && echo " | SSH: localhost:{srv_ssh}" || echo '')"
echo ""
"""

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
{vwifi_summary}
for info_line in "${{VM_INFO[@]}}"; do
    IFS='|' read -r vm mac ip ssh_port pid disk_mode <<< "$info_line"
    echo "  $vm | $mac | $ip | Mode: $disk_mode | PID: $pid$([ "$USE_NAT" = true ] && echo " | SSH: localhost:$ssh_port" || echo '')"
done

echo ""
echo "  Arret : via l'interface web (bouton Stopper/Nettoyer)"
echo "=================================================================="

printf "%s\\n" "${{PIDS[@]}}" > /tmp/vde/vm_pids.txt
info "PIDs sauvegardes dans /tmp/vde/vm_pids.txt"

# Attendre que toutes les VMs se terminent
wait
"""


def _vwifi_server_seed_block(g, server_config):
    """Genere le seed cloud-init pour le serveur vwifi (backend cloudinit)."""
    vde_prefix = _vde_prefix(g["vde_net"])
    vde_mask = g["vde_net"].split("/")[1] if "/" in g["vde_net"] else "24"
    static_ip = f"{vde_prefix}.{VWIFI_SERVER_IP_LAST}"
    mac_vde = VWIFI_SERVER_MAC_VDE
    mac_nat = VWIFI_SERVER_MAC_NAT
    seeds_dir = g["seeds_dir"]

    # Password hashing
    pass_setup = ""
    pass_userdata = ""
    if g.get("password"):
        pass_setup = f"""
# Hasher le mot de passe serveur
HASHED_PASS_SRV=$(python3 -c "
import crypt, sys
print(crypt.crypt(sys.argv[1], crypt.mksalt(crypt.METHOD_SHA512)))
" "{g['password']}")"""
        pass_userdata = """
    passwd: "$HASHED_PASS_SRV"
    lock_passwd: false"""

    # SSH key
    ssh_setup = ""
    ssh_userdata = ""
    if g.get("ssh_key"):
        ssh_setup = f"""
SSH_KEY_CONTENT_SRV=$(cat "{g['ssh_key']}" 2>/dev/null || echo "")"""
        ssh_userdata = """
    ssh_authorized_keys:
      - $SSH_KEY_CONTENT_SRV"""

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
SEED_DIR_SRV="{seeds_dir}/vmserver"
SEED_ISO_SRV="{seeds_dir}/seed-vmserver.iso"
mkdir -p "$SEED_DIR_SRV"
{pass_setup}
{ssh_setup}
cat > "$SEED_DIR_SRV/meta-data" << METAEOF
instance-id: vmserver-$(date +%s)
local-hostname: vwifi-server
METAEOF

cat > "$SEED_DIR_SRV/user-data" << UDEOF
#cloud-config

users:
  - name: debian
    groups: sudo
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL{pass_userdata}{ssh_userdata}

packages:
  - iw
  - tcpdump
  - tmux

write_files:
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
      set -e
      cleanup() {{
        [ -n "\\$VWIFI_PID" ] && kill "\\$VWIFI_PID" 2>/dev/null || true
        exit 0
      }}
      trap cleanup EXIT INT TERM
      sudo modprobe mac80211_hwsim radios=0
      vwifi-client -s -n 1 &
      VWIFI_PID=\\$!
      MAX_WAIT=30; WAITED=0
      while [ ! -d /sys/class/net/wlan0 ]; do
        sleep 1; WAITED=\\$((WAITED + 1))
        [ \\$WAITED -ge \\$MAX_WAIT ] && exit 1
      done
      ip link set wlan0 down
      iw dev wlan0 set monitor control
      ip link set wlan0 up
      tmux new-session -d -s capture "tcpdump -n -i wlan0"
      tmux attach -t capture

runcmd:
  - sed -i 's/^#\\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config
  - systemctl restart ssh
  - systemctl daemon-reload
  - systemctl enable --now vwifi-server
  - echo "vwifi-server ready at \\$(date)" > /var/log/lab-ready.log

final_message: ""
UDEOF

cat > "$SEED_DIR_SRV/network-config" << NCEOF
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
        --network-config "$SEED_DIR_SRV/network-config" \\
        "$SEED_ISO_SRV" \\
        "$SEED_DIR_SRV/user-data" \\
        "$SEED_DIR_SRV/meta-data" \\
        2>/dev/null
else
    genisoimage \\
        -output "$SEED_ISO_SRV" \\
        -volid cidata \\
        -joliet -rock \\
        "$SEED_DIR_SRV/user-data" \\
        "$SEED_DIR_SRV/meta-data" \\
        "$SEED_DIR_SRV/network-config" \\
        2>/dev/null
fi
info "Seed ISO serveur → $SEED_ISO_SRV"
"""


def _vwifi_server_fwcfg_block(g, server_config):
    """Genere la config fw_cfg pour le serveur vwifi (backend fwcfg)."""
    vde_prefix = _vde_prefix(g["vde_net"])
    vde_mask = g["vde_net"].split("/")[1] if "/" in g["vde_net"] else "24"
    static_ip = f"{vde_prefix}.{VWIFI_SERVER_IP_LAST}"

    return f"""IP_FILE_SRV="/tmp/vde/vmserver-ip"
echo -n "{static_ip}/{vde_mask}" > "$IP_FILE_SRV"
ROLE_FILE_SRV="/tmp/vde/vmserver-vwifi-role"
echo -n "server" > "$ROLE_FILE_SRV"
"""


def _vwifi_server_launch_block(g, server_backend, server_config):
    """Genere le bloc de lancement complet du serveur vwifi."""
    vde_prefix = _vde_prefix(g["vde_net"])
    static_ip = f"{vde_prefix}.{VWIFI_SERVER_IP_LAST}"
    ssh_port = g["base_ssh"] + VWIFI_SERVER_SSH_OFFSET
    ram = (server_config or {}).get("ram") or VWIFI_SERVER_RAM
    cpu = (server_config or {}).get("cpu") or VWIFI_SERVER_CPUS
    disk = (server_config or {}).get("disk") or g["disk"]
    disk_mode = (server_config or {}).get("disk_mode") or g["disk_mode"]
    mac_vde = VWIFI_SERVER_MAC_VDE
    mac_nat = VWIFI_SERVER_MAC_NAT
    seeds_dir = g["seeds_dir"]
    vde_socket = "/tmp/vde/switch"
    net_script = g.get("net_script") or "/tmp/setup-net.sh"

    # Preparer le disque serveur
    resolved_srv = {"disk": disk, "disk_mode": disk_mode}
    disk_block = _disk_prep_block("server", resolved_srv)

    # Config backend-specifique
    if server_backend == "fwcfg":
        config_block = _vwifi_server_fwcfg_block(g, server_config)
        drive_arg = _resolve_drive_arg("server", resolved_srv)
        vde_args = f'-netdev vde,id=vde0,sock={vde_socket} -device virtio-net-pci,netdev=vde0,mac={mac_vde}'
        nat_args = ""
        if not g["no_nat"]:
            nat_args = f'-nic user,hostfwd=tcp::{ssh_port}-:22,mac={mac_nat}'
        seed_arg = ""
        fw_cfg_args = (
            f'-fw_cfg name=opt/setup-net.sh,file={net_script}'
            f' -fw_cfg name=opt/vm-ip,file=/tmp/vde/vmserver-ip'
            f' -fw_cfg name=opt/vwifi-role,file=/tmp/vde/vmserver-vwifi-role'
        )
        geometry = "100x25"
        xterm_colors = ""
    else:
        config_block = _vwifi_server_seed_block(g, server_config)
        drive_arg = _resolve_drive_arg("server", resolved_srv)
        vde_args = f'-netdev vde,id=vde0,sock={vde_socket} -device virtio-net-pci,netdev=vde0,mac={mac_vde},addr=0x4'
        nat_args = ""
        if not g["no_nat"]:
            nat_args = f'-netdev user,id=nat0,hostfwd=tcp::{ssh_port}-:22 -device virtio-net-pci,netdev=nat0,mac={mac_nat},addr=0x5'
        seed_arg = f'-drive file={seeds_dir}/seed-vmserver.iso,format=raw,if=virtio,readonly=on'
        fw_cfg_args = ""
        geometry = "120x30"
        xterm_colors = '-bg "#1e1e1e" -fg "#d4d4d4" '

    # Construire la commande QEMU
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

    xterm_cmd_lines = [
        f'xterm -title "vwifi-server — {static_ip} — {disk_mode}" \\',
        f'      -geometry {geometry} \\',
        f'      -fa "DejaVu Sans Mono" \\',
        f'      -fs 10 \\',
        f'      -tn xterm-256color \\',
        f'      {xterm_colors}-xrm "XTerm*selectToClipboard: true" \\',
        f'      -xrm "XTerm*translations: #override \\\\n Ctrl Shift <Key>C: copy-selection(CLIPBOARD) \\\\n Ctrl Shift <Key>V: insert-selection(CLIPBOARD)" \\',
        f'      -e "/tmp/vde/vmserver-cmd.sh"',
    ]
    xterm_cmd = "\n".join(xterm_cmd_lines)

    return f"""{disk_block}
{config_block}
CMD_FILE_SRV="/tmp/vde/vmserver-cmd.sh"
cat > "$CMD_FILE_SRV" << 'CMDEOF'
#!/bin/bash
{qemu_cmd}
CMDEOF
chmod +x "$CMD_FILE_SRV"

XTERM_FILE_SRV="/tmp/vde/vmserver-xterm.sh"
cat > "$XTERM_FILE_SRV" << 'XTEOF'
#!/bin/bash
{xterm_cmd}
XTEOF
chmod +x "$XTERM_FILE_SRV"

info "vwifi-server | {mac_vde} | {static_ip} | {disk_mode} | RAM:{ram} | CPU:{cpu}$([ "$USE_NAT" = true ] && echo " | SSH: localhost:{ssh_port}" || echo '')"

bash "$XTERM_FILE_SRV" &

PIDS+=("$!")
VM_INFO+=("vwifi-server|{mac_vde}|{static_ip}|{ssh_port}|$!|{disk_mode}")

info "vwifi-server demarre — attente 5s pour initialisation..."
sleep 5
"""


def _vwifi_client_seed_block(vm_num, resolved, g):
    """Genere le seed cloud-init pour un client vwifi (backend vwifi_cloudinit)."""
    vde_prefix = _vde_prefix(g["vde_net"])
    vde_mask = g["vde_net"].split("/")[1] if "/" in g["vde_net"] else "24"
    ip_last = g["base_ip"] + vm_num - 1
    static_ip = f"{vde_prefix}.{ip_last}"
    server_ip = f"{vde_prefix}.{VWIFI_SERVER_IP_LAST}"
    mac_suffix = f"{vm_num:02x}"
    mac_vde = f"52:54:00:12:34:{mac_suffix}"
    mac_nat = f"52:54:00:AB:CD:{mac_suffix}"
    seeds_dir = g["seeds_dir"]
    wlan_count = g.get("wlan_count", 1)
    vm_hex = f"{vm_num:02x}"

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

    # Packages de base vwifi + packages utilisateur
    pkg_setup = ""
    pkg_userdata = ""
    if g.get("pkg_list"):
        pkg_setup = f"""
PKG_BLOCK_VM{vm_num}="  - hostapd
  - wpasupplicant
  - tmux
  - iw"
while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ -z "${{line//[[:space:]]/}}" ]] && continue
    PKG_BLOCK_VM{vm_num}="${{PKG_BLOCK_VM{vm_num}}}
  - $(echo "$line" | xargs)"
done < "{g['pkg_list']}"
"""
        pkg_userdata = f"""
packages:
${{PKG_BLOCK_VM{vm_num}}}"""
    else:
        pkg_userdata = """
packages:
  - hostapd
  - wpasupplicant
  - tmux
  - iw"""

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

write_files:
  - path: /usr/local/bin/vwifi-guest-setup.sh
    permissions: '0755'
    content: |
      #!/bin/bash
      sudo modprobe mac80211_hwsim radios=0
      vwifi-add-interfaces {wlan_count} "0a:0b:0c:{vm_hex}:00"
      SERVER="{server_ip}"
      PORT=8212
      MAX_WAIT=120; WAITED=0
      while ! bash -c "echo > /dev/tcp/\\$SERVER/\\$PORT" 2>/dev/null; do
        sleep 2; WAITED=\\$((WAITED + 2))
        [ \\$WAITED -ge \\$MAX_WAIT ] && exit 1
      done
      exec vwifi-client "\\$SERVER"

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
  - sed -i 's/^#\\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config
  - systemctl restart ssh
  - systemctl daemon-reload
  - systemctl enable --now vwifi-client
  - echo "Lab VM{vm_num} vwifi-client ready at \\$(date)" > /var/log/lab-ready.log

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
info "Seed ISO → $SEED_ISO_VM{vm_num} (vwifi-client, {wlan_count} wlan)"
"""


def _vwifi_client_fwcfg_block(vm_num, g):
    """Genere les fichiers fw_cfg vwifi pour un client Alpine (backend vwifi_fwcfg)."""
    vde_prefix = _vde_prefix(g["vde_net"])
    server_ip = f"{vde_prefix}.{VWIFI_SERVER_IP_LAST}"
    wlan_count = g.get("wlan_count", 1)

    return f"""ROLE_FILE_VM{vm_num}="/tmp/vde/vm{vm_num}-vwifi-role"
echo -n "client" > "$ROLE_FILE_VM{vm_num}"
SRVIP_FILE_VM{vm_num}="/tmp/vde/vm{vm_num}-vwifi-server-ip"
echo -n "{server_ip}" > "$SRVIP_FILE_VM{vm_num}"
WLAN_FILE_VM{vm_num}="/tmp/vde/vm{vm_num}-vwifi-wlan-count"
echo -n "{wlan_count}" > "$WLAN_FILE_VM{vm_num}"
"""


def _vde_prefix(vde_net):
    """Extrait le prefixe reseau (3 premiers octets) du CIDR."""
    ip_part = vde_net.split("/")[0]
    octets = ip_part.split(".")
    return ".".join(octets[:3])
