/**
 * app.js — Logique principale de l'interface web
 *
 * Initialisation, drag-and-drop HTML5, appels API, polling de sortie,
 * et mise a jour live de l'apercu CLI.
 */

/* global Topology, Config */

(function () {
    "use strict";

    // Etat de l'application
    const state = {
        vmCount: 2,
        backend: "cloudinit",
        noNat: false,
        hub: false,
        vdeNet: "192.168.100.0/24",
        baseIP: 10,
        labRunning: false,
        outputOffset: 0,
        pollTimer: null,
    };

    // Elements du DOM
    let canvas;
    let cliPreview;
    let outputContent;
    let btnLaunch;
    let btnStop;
    let statusBadge;

    // --- Initialisation ---

    document.addEventListener("DOMContentLoaded", () => {
        canvas = document.getElementById("topology-canvas");
        cliPreview = document.getElementById("cli-preview");
        outputContent = document.getElementById("output-content");
        btnLaunch = document.getElementById("btn-launch");
        btnStop = document.getElementById("btn-stop");
        statusBadge = document.getElementById("status-badge");

        setupDragAndDrop();
        setupBackendRadios();
        setupFormListeners();
        setupButtons();
        setupOutputToggle();
        scanDisks();

        updateAll();
    });

    // --- Drag and Drop ---

    function setupDragAndDrop() {
        const pcIcon = document.getElementById("pc-icon");
        const container = document.getElementById("canvas-container");

        pcIcon.addEventListener("dragstart", (e) => {
            e.dataTransfer.setData("text/plain", "vm");
            e.dataTransfer.effectAllowed = "copy";
        });

        container.addEventListener("dragover", (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            container.classList.add("drag-over");
        });

        container.addEventListener("dragleave", () => {
            container.classList.remove("drag-over");
        });

        container.addEventListener("drop", (e) => {
            e.preventDefault();
            container.classList.remove("drag-over");
            if (e.dataTransfer.getData("text/plain") === "vm") {
                addVM();
            }
        });

        // Bouton retirer VM
        document.getElementById("btn-remove-vm").addEventListener("click", () => {
            if (state.vmCount > 0) {
                state.vmCount--;
                updateAll();
            }
        });

        // Clic sur bouton supprimer dans le canvas
        canvas.addEventListener("click", (e) => {
            const delBtn = e.target.closest(".vm-delete");
            if (delBtn) {
                removeVM(parseInt(delBtn.getAttribute("data-vm-index"), 10));
            }
        });
    }

    // --- Backend radios ---

    function setupBackendRadios() {
        document.querySelectorAll('input[name="backend"]').forEach(radio => {
            radio.addEventListener("change", () => {
                state.backend = radio.value;
                Config.switchBackend(radio.value);
                updateAll();
            });
        });
    }

    // --- Form listeners ---

    function setupFormListeners() {
        // Tous les inputs/selects qui influencent la commande CLI
        const ids = [
            "disk-path", "opt-ram", "opt-cpu", "opt-disk-mode",
            "opt-vde-net", "opt-base-ip", "opt-base-ssh", "opt-pkg-list",
            "opt-no-nat", "opt-hub", "opt-mirror",
            "opt-net-script",
            "opt-password", "opt-ssh-key", "opt-seeds-dir",
            "opt-password-vwifi", "opt-ssh-key-vwifi", "opt-seeds-dir-vwifi", "opt-wlan-count",
        ];

        ids.forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            const evt = (el.type === "checkbox") ? "change" : "input";
            el.addEventListener(evt, () => {
                syncState();
                updateCLI();
                renderCanvas();
            });
        });
    }

    // --- Boutons ---

    function setupButtons() {
        btnLaunch.addEventListener("click", launchLab);
        btnStop.addEventListener("click", stopLab);
        document.getElementById("btn-scan-disks").addEventListener("click", scanDisks);
    }

    // --- Output toggle ---

    function setupOutputToggle() {
        const panel = document.getElementById("output-panel");
        const btn = document.getElementById("btn-toggle-output");
        const header = document.getElementById("output-header");

        function toggle() {
            panel.classList.toggle("collapsed");
            btn.textContent = panel.classList.contains("collapsed") ? "Deplier" : "Replier";
        }

        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            toggle();
        });
        header.addEventListener("click", toggle);
    }

    // --- VM management ---

    function addVM() {
        state.vmCount++;
        updateAll();
    }

    function removeVM(index) {
        if (state.vmCount > 0) {
            state.vmCount--;
            updateAll();
        }
    }

    // --- State sync ---

    function syncState() {
        state.backend = Config.getSelectedBackend();
        state.noNat = document.getElementById("opt-no-nat")?.checked || false;
        state.hub = document.getElementById("opt-hub")?.checked || false;
        state.vdeNet = document.getElementById("opt-vde-net")?.value?.trim() || "192.168.100.0/24";
        state.baseIP = parseInt(document.getElementById("opt-base-ip")?.value, 10) || 10;
    }

    // --- Update helpers ---

    function updateAll() {
        syncState();
        renderCanvas();
        updateCLI();
    }

    function renderCanvas() {
        Topology.renderTopology(canvas, state);
    }

    function updateCLI() {
        const params = Config.gatherFormParams(state.vmCount);
        cliPreview.textContent = Config.buildCommandString(params);
    }

    // --- API calls ---

    async function launchLab() {
        const params = Config.gatherFormParams(state.vmCount);
        if (!params.disk) {
            alert("Veuillez specifier un chemin d'image disque.");
            return;
        }
        if (state.vmCount < 1) {
            alert("Ajoutez au moins une VM sur le canvas.");
            return;
        }

        btnLaunch.disabled = true;
        btnStop.disabled = false;
        state.labRunning = true;
        state.outputOffset = 0;
        outputContent.textContent = "";
        setStatus("running");

        // Deplier le panel output
        document.getElementById("output-panel").classList.remove("collapsed");
        document.getElementById("btn-toggle-output").textContent = "Replier";

        try {
            const resp = await fetch("/api/launch", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(params),
            });
            const data = await resp.json();
            if (!resp.ok) {
                alert(data.error || "Erreur lors du lancement.");
                resetLabState();
                return;
            }
            outputContent.textContent += `$ ${data.command}\n`;
            startPolling();
        } catch (err) {
            alert("Erreur reseau : " + err.message);
            resetLabState();
        }
    }

    async function stopLab() {
        btnStop.disabled = true;
        const backend = Config.getSelectedBackend();
        try {
            const resp = await fetch("/api/stop", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ backend }),
            });
            const data = await resp.json();
            if (data.output) {
                outputContent.textContent += data.output + "\n";
            }
        } catch (err) {
            outputContent.textContent += `[ERREUR] ${err.message}\n`;
        }
        resetLabState();
    }

    function resetLabState() {
        state.labRunning = false;
        btnLaunch.disabled = false;
        btnStop.disabled = true;
        setStatus("idle");
        stopPolling();
    }

    function setStatus(status) {
        statusBadge.className = "badge";
        if (status === "running") {
            statusBadge.classList.add("badge-running");
            statusBadge.textContent = "Running";
        } else {
            statusBadge.classList.add("badge-idle");
            statusBadge.textContent = "Idle";
        }
    }

    // --- Polling output ---

    function startPolling() {
        stopPolling();
        state.pollTimer = setInterval(pollOutput, 2000);
    }

    function stopPolling() {
        if (state.pollTimer) {
            clearInterval(state.pollTimer);
            state.pollTimer = null;
        }
    }

    async function pollOutput() {
        try {
            const resp = await fetch(`/api/output?since=${state.outputOffset}`);
            const data = await resp.json();
            if (data.lines && data.lines.length > 0) {
                outputContent.textContent += data.lines.join("\n") + "\n";
                state.outputOffset = data.total;
                // Auto-scroll
                outputContent.scrollTop = outputContent.scrollHeight;
            }
            if (!data.running) {
                resetLabState();
            }
        } catch {
            // Ignorer les erreurs reseau transitoires
        }
    }

    // --- Scan disks ---

    async function scanDisks() {
        try {
            const resp = await fetch("/api/disks");
            const disks = await resp.json();
            const datalist = document.getElementById("disk-list");
            datalist.innerHTML = "";
            disks.forEach(path => {
                const opt = document.createElement("option");
                opt.value = path;
                datalist.appendChild(opt);
            });
        } catch {
            // Pas critique
        }
    }

})();
