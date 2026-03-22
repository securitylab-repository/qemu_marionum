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
            { id: 1, disk: "", ram: null, cpu: null, diskMode: null, backend: null, pkgList: null, x: null, y: null },
            { id: 2, disk: "", ram: null, cpu: null, diskMode: null, backend: null, pkgList: null, x: null, y: null },
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
        switchPos: { x: null, y: null },
    };

    // Elements du DOM
    let canvas;
    let cliPreview;
    let outputContent;
    let btnLaunch;
    let btnStop;
    let statusBadge;

    // Drag state
    let justDragged = false;

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
        setupDrag();
        setupContextMenu();
        setupMirrorButton();
        setupFileBrowser();

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
            if (justDragged) return;

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

    // --- Drag des noeuds SVG ---

    function setupDrag() {
        let dragging = null; // { type: "vm"|"switch", vmId?, startX, startY, origX, origY }
        const DRAG_THRESHOLD = 5;
        let dragStarted = false;

        canvas.addEventListener("mousedown", (e) => {
            if (e.button !== 0) return; // ignorer clic droit

            const pt = Topology.screenToSVG(canvas, e.clientX, e.clientY);

            // Ne pas initier un drag sur le bouton supprimer
            if (e.target.closest(".vm-delete")) return;

            const vmNode = e.target.closest(".vm-node");
            if (vmNode) {
                const vmId = parseInt(vmNode.getAttribute("data-vm-id"), 10);
                const vm = state.vms.find(v => v.id === vmId);
                if (!vm) return;
                const layout = Topology.getLastLayout();
                const idx = state.vms.indexOf(vm);
                const pos = layout ? layout.vmPositions[idx] : null;
                dragging = {
                    type: "vm",
                    vmId: vmId,
                    startX: e.clientX,
                    startY: e.clientY,
                    origX: pos ? pos.x : pt.x,
                    origY: pos ? pos.y : pt.y,
                };
                dragStarted = false;
                e.preventDefault();
                return;
            }

            const switchNode = e.target.closest(".switch-node");
            if (switchNode) {
                const layout = Topology.getLastLayout();
                const sc = layout ? layout.switchCenter : null;
                dragging = {
                    type: "switch",
                    startX: e.clientX,
                    startY: e.clientY,
                    origX: sc ? sc.x : pt.x,
                    origY: sc ? sc.y : pt.y,
                };
                dragStarted = false;
                e.preventDefault();
                return;
            }
        });

        document.addEventListener("mousemove", (e) => {
            if (!dragging) return;

            const dx = e.clientX - dragging.startX;
            const dy = e.clientY - dragging.startY;

            if (!dragStarted) {
                if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
                dragStarted = true;
            }

            // Convertir le delta ecran en delta SVG
            const startSVG = Topology.screenToSVG(canvas, dragging.startX, dragging.startY);
            const nowSVG = Topology.screenToSVG(canvas, e.clientX, e.clientY);
            const svgDx = nowSVG.x - startSVG.x;
            const svgDy = nowSVG.y - startSVG.y;

            if (dragging.type === "vm") {
                const vm = state.vms.find(v => v.id === dragging.vmId);
                if (vm) {
                    vm.x = dragging.origX + svgDx;
                    vm.y = dragging.origY + svgDy;
                    renderCanvas();
                }
            } else if (dragging.type === "switch") {
                state.switchPos.x = dragging.origX + svgDx;
                state.switchPos.y = dragging.origY + svgDy;
                renderCanvas();
            }
        });

        document.addEventListener("mouseup", (e) => {
            if (!dragging) return;
            if (dragStarted) {
                justDragged = true;
                setTimeout(() => { justDragged = false; }, 0);
            }
            dragging = null;
            dragStarted = false;
        });
    }

    // --- Helpers VM start/launch ---

    function startOrLaunchVM(vmNum, vmId) {
        // Essayer de demarrer via scripts existants, sinon generer via launch-single
        fetch("/api/vm/start", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ vm_num: vmNum }),
        })
            .then(r => r.json().then(data => ({ ok: r.ok, status: r.status, data })))
            .then(({ ok, status, data }) => {
                if (ok) {
                    outputContent.textContent += `[VM${vmNum}] ${data.message}\n`;
                    outputContent.scrollTop = outputContent.scrollHeight;
                } else if (status === 404) {
                    // Pas de scripts : generer et lancer
                    launchSingleVM(vmNum, vmId);
                } else {
                    outputContent.textContent += `[VM${vmNum}] ${data.error || data.message || "Erreur"}\n`;
                    outputContent.scrollTop = outputContent.scrollHeight;
                }
            })
            .catch(err => {
                outputContent.textContent += `[ERREUR] ${err.message}\n`;
            });
    }

    function launchSingleVM(vmNum, vmId) {
        const globalParams = Config.gatherFormParams(state.vms);
        const vm = state.vms.find(v => v.id === vmId);
        const vmConfig = vm ? {
            disk: vm.disk || null,
            ram: vm.ram || null,
            cpu: vm.cpu || null,
            disk_mode: vm.diskMode || null,
            backend: vm.backend || null,
            pkg_list: vm.pkgList || null,
        } : {};

        fetch("/api/vm/launch-single", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                vm_num: vmNum,
                global_params: globalParams,
                vm_config: vmConfig,
            }),
        })
            .then(r => r.json())
            .then(data => {
                const msg = data.message || data.error || "OK";
                outputContent.textContent += `[VM${vmNum}] ${msg}\n`;
                outputContent.scrollTop = outputContent.scrollHeight;
            })
            .catch(err => {
                outputContent.textContent += `[ERREUR] ${err.message}\n`;
            });
    }

    // --- Menu contextuel VM ---

    function setupContextMenu() {
        const menu = document.getElementById("vm-context-menu");
        const selectItem = menu.querySelector('[data-action="select"]');
        const selectSeparator = selectItem ? selectItem.previousElementSibling : null;
        let contextVmId = null; // int pour VMs clientes, "server" pour vwifi-server

        canvas.addEventListener("contextmenu", (e) => {
            // Detecter VM cliente ou vwifi-server
            const vmNode = e.target.closest(".vm-node");
            const srvNode = e.target.closest(".vwifi-server-node");
            if (!vmNode && !srvNode) return;

            e.preventDefault();

            if (srvNode) {
                contextVmId = "server";
                // Masquer "Configurer VM" pour le serveur
                if (selectItem) selectItem.style.display = "none";
                if (selectSeparator) selectSeparator.style.display = "none";
            } else {
                contextVmId = parseInt(vmNode.getAttribute("data-vm-id"), 10);
                if (selectItem) selectItem.style.display = "";
                if (selectSeparator) selectSeparator.style.display = "";
            }

            // Positionner le menu
            menu.style.left = e.clientX + "px";
            menu.style.top = e.clientY + "px";
            menu.style.display = "block";

            // Griser les items selon l'etat
            const startItem = menu.querySelector('[data-action="start"]');
            const stopItem = menu.querySelector('[data-action="stop"]');
            startItem.setAttribute("data-disabled", "true");
            stopItem.setAttribute("data-disabled", "true");

            if (!state.labRunning) return;

            // Resoudre l'identifiant pour l'API
            const apiId = (contextVmId === "server")
                ? "server"
                : String(state.vms.findIndex(v => v.id === contextVmId) + 1);

            fetch(`/api/vm/status/${apiId}`)
                .then(r => r.json())
                .then(data => {
                    if (data.running) {
                        stopItem.removeAttribute("data-disabled");
                        startItem.setAttribute("data-disabled", "true");
                    } else {
                        startItem.removeAttribute("data-disabled");
                        stopItem.setAttribute("data-disabled", "true");
                    }
                })
                .catch(() => {});
        });

        // Click sur un item du menu
        menu.addEventListener("click", (e) => {
            const item = e.target.closest(".context-menu-item");
            if (!item || item.getAttribute("data-disabled") === "true") return;

            const action = item.getAttribute("data-action");
            menu.style.display = "none";

            if (action === "select") {
                if (contextVmId !== "server") selectVM(contextVmId);
                return;
            }

            const isServer = contextVmId === "server";
            const apiId = isServer
                ? "server"
                : String(state.vms.findIndex(v => v.id === contextVmId) + 1);
            const label = isServer ? "vwifi-server" : `VM${apiId}`;

            if (action === "stop") {
                fetch("/api/vm/stop", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ vm_id: apiId }),
                })
                    .then(r => r.json())
                    .then(data => {
                        const msg = data.message || data.error || "OK";
                        outputContent.textContent += `[${label}] ${msg}\n`;
                        outputContent.scrollTop = outputContent.scrollHeight;
                    })
                    .catch(err => {
                        outputContent.textContent += `[ERREUR] ${err.message}\n`;
                    });
            } else if (action === "start") {
                if (isServer) {
                    // Serveur : demarrage direct (pas de launch-single)
                    fetch("/api/vm/start", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ vm_id: "server" }),
                    })
                        .then(r => r.json())
                        .then(data => {
                            const msg = data.message || data.error || "OK";
                            outputContent.textContent += `[${label}] ${msg}\n`;
                            outputContent.scrollTop = outputContent.scrollHeight;
                        })
                        .catch(err => {
                            outputContent.textContent += `[ERREUR] ${err.message}\n`;
                        });
                } else {
                    startOrLaunchVM(parseInt(apiId, 10), contextVmId);
                }
            }
        });

        // Fermer le menu : clic exterieur ou Escape
        document.addEventListener("click", (e) => {
            if (!menu.contains(e.target)) {
                menu.style.display = "none";
            }
        });

        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
                menu.style.display = "none";
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
                Config.updateVmPanel(state);
                updateDiskWarning();
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
            "vm-opt-pkg-list": "pkgList",
        };

        Object.entries(vmFields).forEach(([id, prop]) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.addEventListener("input", () => {
                if (state.selectedVmId === null) return;
                const vm = state.vms.find(v => v.id === state.selectedVmId);
                if (!vm) return;

                if (prop === "disk" || prop === "diskMode" || prop === "pkgList") {
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
    }

    // --- Output toggle ---

    function setupOutputToggle() {
        const panel = document.getElementById("output-panel");
        const btn = document.getElementById("btn-toggle-output");
        const header = document.getElementById("output-header");
        const resizeHandle = document.getElementById("output-resize-handle");
        const btnClear = document.getElementById("btn-clear-output");

        function toggle() {
            panel.classList.toggle("collapsed");
            btn.textContent = panel.classList.contains("collapsed") ? "Deplier" : "Replier";
        }

        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            toggle();
        });

        btnClear.addEventListener("click", (e) => {
            e.stopPropagation();
            outputContent.textContent = "";
            state.outputOffset = 0;
        });

        header.addEventListener("click", (e) => {
            // Ne pas toggle si on clique sur un bouton dans le header
            if (e.target.closest(".output-header-buttons")) return;
            toggle();
        });

        // Resize par drag
        let resizing = false;
        let startY = 0;
        let startH = 0;

        resizeHandle.addEventListener("mousedown", (e) => {
            if (panel.classList.contains("collapsed")) return;
            resizing = true;
            startY = e.clientY;
            startH = panel.offsetHeight;
            e.preventDefault();
        });

        document.addEventListener("mousemove", (e) => {
            if (!resizing) return;
            const newH = Math.max(60, Math.min(window.innerHeight * 0.7, startH - (e.clientY - startY)));
            panel.style.height = newH + "px";
        });

        document.addEventListener("mouseup", () => {
            resizing = false;
        });
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
            pkgList: null,
            x: null,
            y: null,
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

    // --- Disk warning ---

    function updateDiskWarning() {
        const warning = document.getElementById("disk-warning");
        const diskPath = document.getElementById("disk-path");
        if (!warning || !diskPath) return;
        if (diskPath.value.trim()) {
            warning.classList.add("hidden");
        } else {
            warning.classList.remove("hidden");
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
        Config.updateVmPanel(state);
        updateDiskWarning();
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
        if (window._updateMirrorButton) {
            window._updateMirrorButton(status === "running");
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

    // --- Bouton Wireshark (mirror) ---

    function setupMirrorButton() {
        const btnMirror = document.getElementById("btn-mirror");
        let mirrorActive = false;

        btnMirror.addEventListener("click", (e) => {
            e.stopPropagation();
            if (mirrorActive) {
                stopMirror();
            } else {
                startMirror();
            }
        });

        function startMirror() {
            btnMirror.disabled = true;
            btnMirror.textContent = "...";
            fetch("/api/mirror/start", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
            })
                .then(r => r.json().then(data => ({ ok: r.ok, data })))
                .then(({ ok, data }) => {
                    if (ok && data.ok) {
                        mirrorActive = true;
                        btnMirror.disabled = false;
                        btnMirror.textContent = "Stop mirror";
                        btnMirror.title = "Arreter le port mirroring";
                        // Afficher les instructions dans l'output
                        if (!data.already_active) {
                            outputContent.textContent += "[MIRROR] Port mirroring active.\n";
                            outputContent.textContent += "[MIRROR] Lancez Wireshark avec :\n";
                        }
                        outputContent.textContent += `  sudo wireshark -k -i /tmp/vde/vde.pipe\n`;
                        outputContent.scrollTop = outputContent.scrollHeight;
                        // Deplier le panel output
                        const panel = document.getElementById("output-panel");
                        panel.classList.remove("collapsed");
                        document.getElementById("btn-toggle-output").textContent = "Replier";
                    } else {
                        outputContent.textContent += `[MIRROR] Erreur : ${data.error || "echec"}\n`;
                        btnMirror.disabled = false;
                        btnMirror.textContent = "Wireshark";
                    }
                })
                .catch(err => {
                    outputContent.textContent += `[ERREUR] ${err.message}\n`;
                    btnMirror.disabled = false;
                    btnMirror.textContent = "Wireshark";
                });
        }

        function stopMirror() {
            btnMirror.disabled = true;
            btnMirror.textContent = "...";
            fetch("/api/mirror/stop", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
            })
                .then(r => r.json())
                .then(data => {
                    mirrorActive = false;
                    btnMirror.disabled = false;
                    btnMirror.textContent = "Wireshark";
                    btnMirror.title = "Activer le port mirroring Wireshark";
                    outputContent.textContent += "[MIRROR] Port mirroring arrete.\n";
                    outputContent.scrollTop = outputContent.scrollHeight;
                })
                .catch(err => {
                    outputContent.textContent += `[ERREUR] ${err.message}\n`;
                    btnMirror.disabled = false;
                    btnMirror.textContent = "Stop mirror";
                });
        }

        // Activer/desactiver le bouton selon l'etat du lab
        window._updateMirrorButton = function (labRunning) {
            if (!labRunning) {
                btnMirror.disabled = true;
                if (mirrorActive) {
                    mirrorActive = false;
                    btnMirror.textContent = "Wireshark";
                    btnMirror.title = "Activer le port mirroring Wireshark";
                }
            } else if (!mirrorActive) {
                btnMirror.disabled = false;
            }
        };
    }

    // --- Explorateur de fichiers ---

    let browseTargetInput = null;

    function setupFileBrowser() {
        const overlay = document.getElementById("file-browser-overlay");
        const btnClose = document.getElementById("btn-close-browser");
        const btnUp = document.getElementById("btn-browse-up");
        const pathSpan = document.getElementById("browse-current-path");
        const entriesDiv = document.getElementById("browse-entries");
        const discoveredSection = document.getElementById("browse-discovered");
        const discoveredList = document.getElementById("browse-discovered-list");

        let currentPath = "";

        // Ouvrir le browser
        document.getElementById("btn-scan-disks").addEventListener("click", () => {
            browseTargetInput = document.getElementById("disk-path");
            openBrowser();
        });

        // Boutons "..." per-VM
        document.addEventListener("click", (e) => {
            const btn = e.target.closest(".btn-browse-small");
            if (!btn) return;
            const targetId = btn.getAttribute("data-target");
            if (targetId) {
                browseTargetInput = document.getElementById(targetId);
                openBrowser();
            }
        });

        function openBrowser() {
            overlay.style.display = "flex";
            // Charger les disques decouverts + naviguer dans le repertoire courant
            loadDiscovered();
            const startPath = browseTargetInput?.value?.trim();
            if (startPath && startPath.includes("/")) {
                const dir = startPath.substring(0, startPath.lastIndexOf("/")) || "/";
                navigate(dir);
            } else {
                navigate("");
            }
        }

        function closeBrowser() {
            overlay.style.display = "none";
        }

        btnClose.addEventListener("click", closeBrowser);
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) closeBrowser();
        });
        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && overlay.style.display !== "none") {
                closeBrowser();
            }
        });

        btnUp.addEventListener("click", () => {
            if (currentPath && currentPath !== "/") {
                const parent = currentPath.substring(0, currentPath.lastIndexOf("/")) || "/";
                navigate(parent);
            }
        });

        async function loadDiscovered() {
            try {
                const resp = await fetch("/api/disks");
                const disks = await resp.json();
                // Aussi remplir le datalist
                const datalist = document.getElementById("disk-list");
                datalist.innerHTML = "";
                disks.forEach(path => {
                    const opt = document.createElement("option");
                    opt.value = path;
                    datalist.appendChild(opt);
                });

                if (disks.length > 0) {
                    discoveredSection.style.display = "";
                    discoveredList.innerHTML = "";
                    disks.forEach(diskPath => {
                        const name = diskPath.split("/").pop();
                        const dir = diskPath.substring(0, diskPath.lastIndexOf("/"));
                        const entry = document.createElement("div");
                        entry.className = "browse-entry browse-entry-disk";
                        entry.innerHTML = `<span class="browse-entry-icon">\u{1F4BE}</span><span class="browse-entry-name" title="${diskPath}">${name}</span><span class="browse-entry-size">${dir}</span>`;
                        entry.addEventListener("click", () => selectDisk(diskPath));
                        discoveredList.appendChild(entry);
                    });
                } else {
                    discoveredSection.style.display = "none";
                }
            } catch {
                discoveredSection.style.display = "none";
            }
        }

        async function navigate(path) {
            try {
                const resp = await fetch(`/api/browse?path=${encodeURIComponent(path)}`);
                const data = await resp.json();
                currentPath = data.current;
                pathSpan.textContent = currentPath;
                pathSpan.title = currentPath;

                entriesDiv.innerHTML = "";
                if (data.entries.length === 0) {
                    entriesDiv.innerHTML = '<div class="browse-empty">Aucun fichier disque dans ce repertoire</div>';
                    return;
                }

                data.entries.forEach(e => {
                    const entry = document.createElement("div");
                    if (e.type === "dir") {
                        entry.className = "browse-entry browse-entry-dir";
                        entry.innerHTML = `<span class="browse-entry-icon">\u{1F4C1}</span><span class="browse-entry-name">${e.name}</span>`;
                        entry.addEventListener("click", () => navigate(e.path));
                    } else {
                        const sizeStr = formatSize(e.size || 0);
                        entry.className = "browse-entry browse-entry-disk";
                        entry.innerHTML = `<span class="browse-entry-icon">\u{1F4BE}</span><span class="browse-entry-name">${e.name}</span><span class="browse-entry-size">${sizeStr}</span>`;
                        entry.addEventListener("click", () => selectDisk(e.path));
                    }
                    entriesDiv.appendChild(entry);
                });
            } catch (err) {
                entriesDiv.innerHTML = `<div class="browse-empty">Erreur : ${err.message}</div>`;
            }
        }

        function selectDisk(path) {
            if (browseTargetInput) {
                browseTargetInput.value = path;
                browseTargetInput.dispatchEvent(new Event("input", { bubbles: true }));
            }
            closeBrowser();
        }

        function formatSize(bytes) {
            if (bytes < 1024) return bytes + " o";
            if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " Ko";
            if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " Mo";
            return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " Go";
        }
    }

})();
