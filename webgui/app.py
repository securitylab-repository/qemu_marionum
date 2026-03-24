#!/usr/bin/env python3
"""Serveur Flask pour l'interface web qemu_marionum."""

import os
import subprocess
import threading
import time
import glob as globmod
from flask import Flask, render_template, jsonify, request
from launcher import generate_launcher, generate_single_vm_script

app = Flask(__name__)

# Repertoire racine du projet (parent de webgui/)
PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

# Etat global du lab en cours
lab_state = {
    "running": False,
    "process": None,
    "output_lines": [],
    "lock": threading.Lock(),
}


# --- Routes ---

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/disks")
def api_disks():
    """Scanne le repertoire projet et ~/ pour les fichiers disque."""
    extensions = ("*.qcow2", "*.img", "*.raw")
    found = set()
    search_dirs = [PROJECT_ROOT, os.path.expanduser("~")]
    for d in search_dirs:
        for ext in extensions:
            for f in globmod.glob(os.path.join(d, "**", ext), recursive=True):
                found.add(os.path.abspath(f))
            for f in globmod.glob(os.path.join(d, ext)):
                found.add(os.path.abspath(f))
    return jsonify(sorted(found))


@app.route("/api/browse")
def api_browse():
    """Navigue dans le systeme de fichiers pour trouver des images disque."""
    raw = request.args.get("path", os.path.expanduser("~"))
    path = os.path.abspath(raw)
    if not os.path.isdir(path):
        path = os.path.dirname(path)

    entries = []
    try:
        for name in sorted(os.listdir(path), key=str.lower):
            if name.startswith("."):
                continue
            full = os.path.join(path, name)
            if os.path.isdir(full):
                entries.append({"name": name, "path": full, "type": "dir"})
            elif name.lower().endswith((".qcow2", ".img", ".raw")):
                size = os.path.getsize(full)
                entries.append({"name": name, "path": full, "type": "disk", "size": size})
    except PermissionError:
        pass

    parent = os.path.dirname(path) if path != "/" else None
    return jsonify({"current": path, "parent": parent, "entries": entries})


@app.route("/api/launch", methods=["POST"])
def api_launch():
    """Lance le lab avec les parametres fournis."""
    with lab_state["lock"]:
        if lab_state["running"]:
            return jsonify({"error": "Un lab est deja en cours."}), 409

    params = request.get_json(force=True)
    cmd = build_command(params)
    if not cmd:
        return jsonify({"error": "Parametres invalides."}), 400

    with lab_state["lock"]:
        lab_state["output_lines"] = []
        lab_state["running"] = True

    def run():
        try:
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                cwd=PROJECT_ROOT,
            )
            with lab_state["lock"]:
                lab_state["process"] = proc
            for line in proc.stdout:
                with lab_state["lock"]:
                    lab_state["output_lines"].append(line.rstrip("\n"))
            proc.wait()
        except Exception as e:
            with lab_state["lock"]:
                lab_state["output_lines"].append(f"[ERREUR] {e}")
        finally:
            with lab_state["lock"]:
                lab_state["running"] = False
                lab_state["process"] = None

    t = threading.Thread(target=run, daemon=True)
    t.start()

    return jsonify({"ok": True, "command": " ".join(cmd)})


@app.route("/api/stop", methods=["POST"])
def api_stop():
    """Arrete le lab en cours."""
    params = request.get_json(force=True) if request.data else {}
    backend = params.get("backend", "fwcfg")

    scripts = {
        "fwcfg": "./fwcfg.sh",
        "cloudinit": "./cloudinit.sh",
        "vwifi": "./vwifi.sh",
    }
    script = scripts.get(backend, "./fwcfg.sh")

    # Tuer le processus en cours s'il existe
    with lab_state["lock"]:
        if lab_state["process"] and lab_state["process"].poll() is None:
            lab_state["process"].terminate()

    try:
        result = subprocess.run(
            ["bash", script, "--stop"],
            capture_output=True, text=True,
            cwd=PROJECT_ROOT,
            timeout=15,
        )
        with lab_state["lock"]:
            lab_state["running"] = False
            lab_state["process"] = None
            lab_state["output_lines"].append("[INFO] Lab arrete.")
        return jsonify({"ok": True, "output": result.stdout + result.stderr})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/status")
def api_status():
    """Verifie l'etat du lab."""
    vde_running = os.path.exists("/tmp/vde/switch/ctl")
    pids_file = "/tmp/vde/vm_pids.txt"
    vm_count = 0
    if os.path.exists(pids_file):
        with open(pids_file) as f:
            vm_count = sum(1 for line in f if line.strip())
    with lab_state["lock"]:
        return jsonify({
            "running": lab_state["running"],
            "vde_active": vde_running,
            "vm_count": vm_count,
            "output_total": len(lab_state["output_lines"]),
        })


@app.route("/api/vm/status/<vm_id>")
def api_vm_status(vm_id):
    """Verifie si une VM individuelle tourne. vm_id = "1", "2", ... ou "server"."""
    cmd_script = f"/tmp/vde/vm{vm_id}-cmd.sh"
    xterm_script = f"/tmp/vde/vm{vm_id}-xterm.sh"
    has_scripts = os.path.exists(cmd_script) and os.path.exists(xterm_script)
    running = False
    if has_scripts:
        try:
            result = subprocess.run(
                ["pgrep", "-f", cmd_script],
                capture_output=True, text=True, timeout=5,
            )
            running = result.returncode == 0
        except Exception:
            pass
    return jsonify({"running": running, "has_scripts": has_scripts})


@app.route("/api/vm/stop", methods=["POST"])
def api_vm_stop():
    """Arrete une VM individuelle."""
    params = request.get_json(force=True) if request.data else {}
    vm_id = str(params.get("vm_id") or params.get("vm_num") or "")
    if not vm_id:
        return jsonify({"error": "vm_id requis."}), 400

    label = "vwifi-server" if vm_id == "server" else f"VM{vm_id}"
    cmd_script = f"/tmp/vde/vm{vm_id}-cmd.sh"
    try:
        result = subprocess.run(
            ["pkill", "-f", cmd_script],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0:
            return jsonify({"ok": True, "message": f"{label} arretee."})
        else:
            return jsonify({"ok": False, "message": f"{label} non trouvee ou deja arretee."})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/vm/start", methods=["POST"])
def api_vm_start():
    """Demarre (ou redemarre) une VM individuelle."""
    params = request.get_json(force=True) if request.data else {}
    vm_id = str(params.get("vm_id") or params.get("vm_num") or "")
    if not vm_id:
        return jsonify({"error": "vm_id requis."}), 400

    label = "vwifi-server" if vm_id == "server" else f"VM{vm_id}"
    xterm_script = f"/tmp/vde/vm{vm_id}-xterm.sh"
    cmd_script = f"/tmp/vde/vm{vm_id}-cmd.sh"

    if not os.path.exists(xterm_script):
        return jsonify({"error": f"Script {xterm_script} introuvable. Lancez le lab d'abord."}), 404

    # Verifier si deja running
    try:
        result = subprocess.run(
            ["pgrep", "-f", cmd_script],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0:
            return jsonify({"error": f"{label} est deja en cours d'execution."}), 409
    except Exception:
        pass

    try:
        subprocess.Popen(
            ["bash", xterm_script],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            cwd=PROJECT_ROOT,
        )
        return jsonify({"ok": True, "message": f"{label} demarree."})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/vm/launch-single", methods=["POST"])
def api_vm_launch_single():
    """Genere les scripts et lance une VM individuelle (ajout dynamique)."""
    params = request.get_json(force=True) if request.data else {}
    vm_num = params.get("vm_num")
    global_params = params.get("global_params", {})
    vm_config = params.get("vm_config", {})

    if not vm_num:
        return jsonify({"error": "vm_num requis."}), 400
    if not global_params.get("disk") and not vm_config.get("disk"):
        return jsonify({"error": "Aucune image disque specifiee."}), 400

    # Verifier que le switch VDE tourne
    if not os.path.exists("/tmp/vde/switch/ctl"):
        return jsonify({"error": "Le switch VDE n'est pas actif. Lancez le lab d'abord."}), 400

    # Verifier si deja running
    cmd_script = f"/tmp/vde/vm{vm_num}-cmd.sh"
    try:
        result = subprocess.run(
            ["pgrep", "-f", cmd_script],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0:
            return jsonify({"error": f"VM{vm_num} est deja en cours d'execution."}), 409
    except Exception:
        pass

    try:
        script_path = generate_single_vm_script(global_params, vm_config, vm_num)
        proc = subprocess.Popen(
            ["bash", script_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            cwd=PROJECT_ROOT,
        )
        # Lire la sortie dans un thread
        def read_output():
            for line in proc.stdout:
                with lab_state["lock"]:
                    lab_state["output_lines"].append(line.rstrip("\n"))
            proc.wait()

        t = threading.Thread(target=read_output, daemon=True)
        t.start()

        return jsonify({"ok": True, "message": f"VM{vm_num} en cours de lancement..."})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/mirror/start", methods=["POST"])
def api_mirror_start():
    """Active le port mirroring (vdecapture + FIFO) pour Wireshark.

    vdecapture bloque en ecriture sur la FIFO tant que Wireshark ne lit pas.
    Le port n'apparait dans le switch qu'apres le lancement de Wireshark.
    On lance donc un thread qui poll port/print et active le HUB des que
    le port vdecapture est visible.
    """
    vde_socket = "/tmp/vde/switch"
    mgmt_socket = "/tmp/vde/mgmt"
    fifo_path = "/tmp/vde/vde.pipe"

    if not os.path.exists(os.path.join(vde_socket, "ctl")):
        return jsonify({"error": "Le switch VDE n'est pas actif."}), 400

    # Verifier si deja actif
    try:
        result = subprocess.run(
            ["pgrep", "-f", "vdecapture"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0:
            return jsonify({
                "ok": True,
                "already_active": True,
                "message": "Port mirroring deja actif.",
                "wireshark_cmd": f"sudo wireshark -k -i {fifo_path}",
            })
    except Exception:
        pass

    try:
        # Creer la FIFO si elle n'existe pas
        if not os.path.exists(fifo_path):
            os.mkfifo(fifo_path)

        # Lancer vdecapture en arriere-plan (bloque sur FIFO jusqu'a Wireshark)
        # "-" = sortie stdout, "> fifo" = redirection shell vers la FIFO
        # Le shell bloque sur l'ouverture de la FIFO tant que Wireshark ne lit pas
        subprocess.Popen(
            f'vdecapture "{vde_socket}" - > "{fifo_path}" 2>/dev/null',
            shell=True,
        )

        # Lister les ports connus AVANT que Wireshark ne se connecte
        known_ports = set()
        if os.path.exists(mgmt_socket):
            try:
                result = subprocess.run(
                    ["socat", "-", f"UNIX-CONNECT:{mgmt_socket}"],
                    input="port/print\n",
                    capture_output=True, text=True, timeout=5,
                )
                for line in result.stdout.strip().splitlines():
                    parts = line.strip().split()
                    if len(parts) >= 2 and parts[0].lower().startswith("port"):
                        try:
                            known_ports.add(int(parts[1].rstrip(":")))
                        except ValueError:
                            pass
            except Exception:
                pass

        with lab_state["lock"]:
            lab_state["output_lines"].append("[MIRROR] vdecapture lance, en attente de Wireshark...")
            lab_state["output_lines"].append(f"[MIRROR] Lancez Wireshark avec :")
            lab_state["output_lines"].append(f"  sudo wireshark -k -i {fifo_path}")

        # Thread qui attend que le port vdecapture apparaisse puis active HUB
        def wait_and_sethub():
            for _ in range(30):  # max 60s (30 x 2s)
                time.sleep(2)
                if not os.path.exists(mgmt_socket):
                    continue
                try:
                    result = subprocess.run(
                        ["socat", "-", f"UNIX-CONNECT:{mgmt_socket}"],
                        input="port/print\n",
                        capture_output=True, text=True, timeout=5,
                    )
                    new_port = None
                    for line in result.stdout.strip().splitlines():
                        parts = line.strip().split()
                        if len(parts) >= 2 and parts[0].lower().startswith("port"):
                            try:
                                p = int(parts[1].rstrip(":"))
                                if p not in known_ports:
                                    new_port = p
                            except ValueError:
                                pass
                    if new_port is not None:
                        # Activer HUB sur le nouveau port
                        subprocess.run(
                            ["socat", "-", f"UNIX-CONNECT:{mgmt_socket}"],
                            input=f"port/sethub {new_port} 1\n",
                            capture_output=True, text=True, timeout=5,
                        )
                        with lab_state["lock"]:
                            lab_state["output_lines"].append(
                                f"[MIRROR] Wireshark connecte — port {new_port} en mode HUB"
                            )
                        return
                except Exception:
                    pass
            with lab_state["lock"]:
                lab_state["output_lines"].append(
                    "[MIRROR] Timeout : Wireshark non detecte apres 60s. "
                    "Le HUB n'a pas ete active."
                )

        t = threading.Thread(target=wait_and_sethub, daemon=True)
        t.start()

        return jsonify({
            "ok": True,
            "message": "Port mirroring active.",
            "wireshark_cmd": f"sudo wireshark -k -i {fifo_path}",
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/mirror/stop", methods=["POST"])
def api_mirror_stop():
    """Arrete le port mirroring."""
    fifo_path = "/tmp/vde/vde.pipe"
    try:
        subprocess.run(
            ["pkill", "-f", "vdecapture"],
            capture_output=True, text=True, timeout=5,
        )
        if os.path.exists(fifo_path):
            os.remove(fifo_path)

        with lab_state["lock"]:
            lab_state["output_lines"].append("[MIRROR] Port mirroring arrete.")

        return jsonify({"ok": True, "message": "Port mirroring arrete."})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/memory")
def api_memory():
    """Retourne la memoire disponible du systeme en MB."""
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    kb = int(line.split()[1])
                    return jsonify({"available_mb": kb // 1024})
        return jsonify({"available_mb": None})
    except Exception:
        return jsonify({"available_mb": None})


@app.route("/api/output")
def api_output():
    """Retourne les nouvelles lignes de sortie depuis l'index donne."""
    since = request.args.get("since", 0, type=int)
    with lab_state["lock"]:
        lines = lab_state["output_lines"][since:]
        total = len(lab_state["output_lines"])
        running = lab_state["running"]
    return jsonify({"lines": lines, "total": total, "running": running})


# --- Construction de commande ---

def build_command(params):
    """Construit la liste d'arguments CLI a partir des parametres JSON.

    Si la cle 'vms' est presente (config per-VM), genere un script via
    launcher.py au lieu d'appeler directement le backend.
    """
    backend = params.get("backend", "fwcfg")
    disk = params.get("disk", "")
    if not disk:
        return None

    # Per-VM : generer un script de lancement
    if "vms" in params:
        return generate_launcher(params)

    scripts = {
        "fwcfg": "./fwcfg.sh",
        "cloudinit": "./cloudinit.sh",
        "vwifi": "./vwifi.sh",
    }
    script = scripts.get(backend)
    if not script:
        return None

    cmd = ["bash", script]

    # Options communes
    count = params.get("count", 2)
    cmd += ["--count", str(count)]

    ram = params.get("ram")
    if ram:
        cmd += ["--ram", str(ram)]

    cpu = params.get("cpu")
    if cpu:
        cmd += ["--cpu", str(cpu)]

    vde_net = params.get("vde_net")
    if vde_net:
        cmd += ["--vde-net", vde_net]

    base_ip = params.get("base_ip")
    if base_ip:
        cmd += ["--base-ip", str(base_ip)]

    base_ssh = params.get("base_ssh")
    if base_ssh:
        cmd += ["--base-ssh", str(base_ssh)]

    disk_mode = params.get("disk_mode", "snapshot")
    cmd += ["--disk-mode", disk_mode]

    if params.get("no_nat"):
        cmd.append("--no-nat")

    if params.get("hub"):
        cmd.append("--hub")

    if params.get("mirror"):
        cmd.append("--mirror")

    pkg_list = params.get("pkg_list")
    if pkg_list:
        cmd += ["--pkg-list", pkg_list]

    # Options specifiques fwcfg
    if backend == "fwcfg":
        net_script = params.get("net_script")
        if net_script:
            cmd += ["--net-script", net_script]

    # Options specifiques cloudinit
    if backend in ("cloudinit", "vwifi"):
        password = params.get("password")
        if password:
            cmd += ["--password", password]

        ssh_key = params.get("ssh_key")
        if ssh_key:
            cmd += ["--ssh-key", ssh_key]

        seeds_dir = params.get("seeds_dir")
        if seeds_dir:
            cmd += ["--seeds-dir", seeds_dir]

    # Options specifiques vwifi
    if backend == "vwifi":
        wlan_count = params.get("wlan_count")
        if wlan_count:
            cmd += ["--wlan-count", str(wlan_count)]

    # Disque en dernier argument
    cmd.append(disk)

    return cmd


if __name__ == "__main__":
    print(f"[webgui] Repertoire projet : {PROJECT_ROOT}")
    print(f"[webgui] Demarrage sur http://localhost:5000")
    app.run(host="0.0.0.0", port=5000, debug=True)
