/**
 * app.js — Logique principale de l'interface web
 *
 * Initialisation, drag-and-drop HTML5, appels API, polling de sortie,
 * gestion per-VM, et mise a jour live de l'apercu CLI.
 */

/* global Topology, Config */

(function () {
    "use strict";

    // Etat de l'application
    const state = {
        vms: [
            { id: 1, disk: "", ram: null, cpu: null, diskMode: null, backend: null },
            { id: 2, disk: "", ram: null, cpu: null, diskMode: null, backend: null },
        ],
        selectedVmId: null,
        nextVmId: 3,
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
        setupVmFormListeners();
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
            if (state.vms.length > 0) {
                // Retirer la derniere VM
                const removed = state.vms.pop();
                if (state.selectedVmId === removed.id) {
                    state.selectedVmId = null;
                }
                updateAll();
            }
        });

        // Clic sur le canvas : selection VM ou bouton supprimer
        canvas.addEventListener("click", (e) => {
            // Bouton supprimer
            const delBtn = e.target.closest(".vm-delete");
            if (delBtn) {
                const vmId = parseInt(delBtn.getAttribute("data-vm-id"), 10);
                removeVM(vmId);
                return;
            }

            // Clic sur un noeud VM
            const vmNode = e.target.closest(".vm-node");
            if (vmNode) {
                const vmId = parseInt(vmNode.getAttribute("data-vm-id"), 10);
                selectVM(vmId);
                return;
            }

            // Clic sur le fond → deselectionner
            deselectVM();
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

    // --- Form listeners (global) ---

    function setupFormListeners() {
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
                // Mettre a jour les placeholders du panel per-VM
                Config.updateVmPanel(state);
            });
        });
    }

    // --- Form listeners (per-VM) ---

    function setupVmFormListeners() {
        const vmFields = {
            "vm-disk-path": "disk",
            "vm-opt-ram": "ram",
            "vm-opt-cpu": "cpu",
            "vm-opt-disk-mode": "diskMode",
            "vm-opt-backend": "backend",
        };

        Object.entries(vmFields).forEach(([id, prop]) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.addEventListener("input", () => {
                if (state.selectedVmId === null) return;
                const vm = state.vms.find(v => v.id === state.selectedVmId);
                if (!vm) return;

                if (prop === "disk" || prop === "diskMode") {
                    vm[prop] = el.value.trim() || null;
                } else {
                    const num = parseInt(el.value, 10);
                    vm[prop] = isNaN(num) ? null : num;
                }

                updateCLI();
                renderCanvas();
            });
            // Also listen for change on select
            if (el.tagName === "SELECT") {
                el.addEventListener("change", () => {
                    if (state.selectedVmId === null) return;
                    const vm = state.vms.find(v => v.id === state.selectedVmId);
                    if (!vm) return;
                    vm[prop] = el.value || null;
                    updateCLI();
                    renderCanvas();
                });
            }
        });

        // Bouton retour config globale
        const btnGlobal = document.getElementById("btn-global-config");
        if (btnGlobal) {
            btnGlobal.addEventListener("click", () => {
                deselectVM();
            });
        }
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
        const vm = {
            id: state.nextVmId++,
            disk: "",
            ram: null,
            cpu: null,
            diskMode: null,
            backend: null,
        };
        state.vms.push(vm);
        selectVM(vm.id);
        updateAll();
    }

    function removeVM(vmId) {
        const idx = state.vms.findIndex(v => v.id === vmId);
        if (idx === -1) return;
        state.vms.splice(idx, 1);
        if (state.selectedVmId === vmId) {
            state.selectedVmId = null;
        }
        updateAll();
    }

    function selectVM(vmId) {
        const vm = state.vms.find(v => v.id === vmId);
        if (!vm) return;
        state.selectedVmId = vmId;
        Config.updateVmPanel(state);
        renderCanvas();
    }

    function deselectVM() {
        state.selectedVmId = null;
        Config.updateVmPanel(state);
        renderCanvas();
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
        Config.updateVmPanel(state);
    }

    function renderCanvas() {
        Topology.renderTopology(canvas, state);
    }

    function updateCLI() {
        const params = Config.gatherFormParams(state.vms);
        cliPreview.textContent = Config.buildCommandString(params);
    }

    // --- API calls ---

    async function launchLab() {
        const params = Config.gatherFormParams(state.vms);
        if (!params.disk) {
            alert("Veuillez specifier un chemin d'image disque.");
            return;
        }
        if (state.vms.length < 1) {
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
