#!/usr/bin/env python3
"""Serveur Flask pour l'interface web qemu_marionum."""

import os
import subprocess
import threading
import time
import glob as globmod
from flask import Flask, render_template, jsonify, request

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
            [script, "--stop"],
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
    """Construit la liste d'arguments CLI a partir des parametres JSON."""
    backend = params.get("backend", "fwcfg")
    disk = params.get("disk", "")
    if not disk:
        return None

    scripts = {
        "fwcfg": "./fwcfg.sh",
        "cloudinit": "./cloudinit.sh",
        "vwifi": "./vwifi.sh",
    }
    script = scripts.get(backend)
    if not script:
        return None

    cmd = [script]

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
