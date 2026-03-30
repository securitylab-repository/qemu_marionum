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
        vms: [],
        server: null,       // null ou { backend, disk, ram, cpu, diskMode, x, y }
        selectedVmId: null,
        selectedServerPanel: false,
        nextVmId: 1,
        noNat: false,
        hub: false,
        vdeNet: "192.168.100.0/24",
        baseIP: 10,
        labRunning: false,
        hasPreservedState: false,
        outputOffset: 0,
        pollTimer: null,
        switchPos: { x: null, y: null },
        availableRam: null,
        availableSwap: null,
    };

    // Elements du DOM
    let canvas;
    let cliPreview;
    let outputContent;
    let btnLaunch;
    let btnStop;
    let btnRestart;
    let btnClean;
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
        btnRestart = document.getElementById("btn-restart");
        btnClean = document.getElementById("btn-clean");
        statusBadge = document.getElementById("status-badge");

        setupDragAndDrop();
        setupFormListeners();
        setupVmFormListeners();
        setupServerFormListeners();
        setupButtons();
        setupOutputToggle();
        setupDrag();
        setupContextMenu();
        setupMirrorButton();
        setupHelpModal();
        setupFileBrowser();
        setupPanelToggles();

        fetchMemory();
        setInterval(fetchMemory, 30000);

        updateAll();
        checkInitialStatus();
    });

    // --- Drag and Drop ---

    function setupDragAndDrop() {
        const pcIcon = document.getElementById("pc-icon");
        const srvIcon = document.getElementById("srv-icon");
        const container = document.getElementById("canvas-container");

        pcIcon.addEventListener("dragstart", (e) => {
            e.dataTransfer.setData("text/plain", "vm");
            e.dataTransfer.effectAllowed = "copy";
        });

        srvIcon.addEventListener("dragstart", (e) => {
            e.dataTransfer.setData("text/plain", "server");
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
            const data = e.dataTransfer.getData("text/plain");
            if (data === "vm") {
                addVM();
            } else if (data === "server") {
                addServer();
            }
        });

        // Bouton retirer VM
        document.getElementById("btn-remove-vm").addEventListener("click", () => {
            if (state.vms.length > 0) {
                const removed = state.vms.pop();
                if (state.selectedVmId === removed.id) {
                    state.selectedVmId = null;
                }
                // Renumeroter
                state.vms.forEach((vm, i) => { vm.id = i + 1; });
                state.nextVmId = state.vms.length + 1;
                cleanPreservedState();
                updateAll();
            }
        });

        // Clic sur le canvas : selection VM ou bouton supprimer
        canvas.addEventListener("click", (e) => {
            if (justDragged) return;

            // Bouton supprimer VM
            const delBtn = e.target.closest(".vm-delete");
            if (delBtn) {
                const vmId = parseInt(delBtn.getAttribute("data-vm-id"), 10);
                removeVM(vmId);
                return;
            }

            // Bouton supprimer serveur
            const srvDel = e.target.closest(".srv-delete");
            if (srvDel) {
                removeServer();
                return;
            }

            // Clic sur un noeud VM
            const vmNode = e.target.closest(".vm-node");
            if (vmNode) {
                const vmId = parseInt(vmNode.getAttribute("data-vm-id"), 10);
                selectVM(vmId);
                return;
            }

            // Clic sur le noeud vwifi-server
            const srvNode = e.target.closest(".vwifi-server-node");
            if (srvNode) {
                selectServerPanel();
                return;
            }

            // Clic sur le fond → deselectionner
            deselectVM();
        });
    }

    // --- Drag des noeuds SVG ---

    function setupDrag() {
        let dragging = null; // { type: "vm"|"switch"|"server", vmId?, startX, startY, origX, origY }
        const DRAG_THRESHOLD = 5;
        let dragStarted = false;

        canvas.addEventListener("mousedown", (e) => {
            if (e.button !== 0) return; // ignorer clic droit

            const pt = Topology.screenToSVG(canvas, e.clientX, e.clientY);

            // Ne pas initier un drag sur le bouton supprimer
            if (e.target.closest(".vm-delete") || e.target.closest(".srv-delete")) return;

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

            const srvNode = e.target.closest(".vwifi-server-node");
            if (srvNode && state.server) {
                const layout = Topology.getLastLayout();
                const srvPos = layout ? layout.serverPosition : null;
                dragging = {
                    type: "server",
                    startX: e.clientX,
                    startY: e.clientY,
                    origX: srvPos ? srvPos.x : pt.x,
                    origY: srvPos ? srvPos.y : pt.y,
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
            } else if (dragging.type === "server" && state.server) {
                state.server.x = dragging.origX + svgDx;
                state.server.y = dragging.origY + svgDy;
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
        if (state.server) Config.addServerParams(globalParams, state.server);
        const vm = state.vms.find(v => v.id === vmId);
        const vmConfig = vm ? {
            disk: vm.disk || null,
            ram: vm.ram || null,
            cpu: vm.cpu || null,
            disk_mode: vm.diskMode || null,
            backend: vm.backend || "cloudinit",
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

            if (!state.labRunning && !state.hasPreservedState) return;

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
                // Si on etait en etat stopped, passer en running
                if (state.hasPreservedState && !state.labRunning) {
                    state.labRunning = true;
                    state.hasPreservedState = false;
                    btnLaunch.disabled = true;
                    btnStop.disabled = false;
                    btnRestart.disabled = true;
                    btnClean.disabled = true;
                    setStatus("running");
                }

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

    // --- Form listeners (global) ---

    function setupFormListeners() {
        const ids = [
            "disk-path", "opt-ram", "opt-cpu", "opt-disk-mode",
            "opt-vde-net", "opt-base-ip", "opt-base-ssh", "opt-pkg-list",
            "opt-no-nat", "opt-hub", "opt-mirror",
            "opt-net-script",
            "opt-password", "opt-ssh-key", "opt-seeds-dir", "opt-wlan-count",
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
                Config.updateServerPanel(state);
                updateDiskWarning();
                updateRamWarning();
            });
        });
    }

    // --- Form listeners (per-VM) ---

    function setupVmFormListeners() {
        const vmFields = {
            "vm-opt-label": "label",
            "vm-disk-path": "disk",
            "vm-opt-ram": "ram",
            "vm-opt-cpu": "cpu",
            "vm-opt-disk-mode": "diskMode",
            "vm-opt-backend": "backend",
            "vm-opt-pkg-list": "pkgList",
            "vm-opt-wlan-count": "wlanCount",
        };

        Object.entries(vmFields).forEach(([id, prop]) => {
            const el = document.getElementById(id);
            if (!el) return;
            function applyVmFieldChange() {
                if (state.selectedVmId === null) return;
                const vm = state.vms.find(v => v.id === state.selectedVmId);
                if (!vm) return;

                if (prop === "label") {
                    vm[prop] = el.value.trim();
                } else if (prop === "disk" || prop === "diskMode" || prop === "pkgList") {
                    vm[prop] = el.value.trim() || null;
                } else if (prop === "backend") {
                    vm[prop] = el.value || "cloudinit";
                } else {
                    const num = parseInt(el.value, 10);
                    vm[prop] = isNaN(num) ? null : num;
                }

                updateCLI();
                renderCanvas();
                Config.updateVmPanel(state);
                Config.updateServerPanel(state);
            }

            el.addEventListener("input", applyVmFieldChange);
            if (el.tagName === "SELECT") {
                el.addEventListener("change", applyVmFieldChange);
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

    // --- Form listeners (vwifi-server) ---

    function setupServerFormListeners() {
        const srvFields = {
            "srv-opt-backend": "backend",
            "srv-opt-ram": "ram",
            "srv-opt-cpu": "cpu",
            "srv-disk-path": "disk",
            "srv-opt-disk-mode": "diskMode",
        };

        Object.entries(srvFields).forEach(([id, prop]) => {
            const el = document.getElementById(id);
            if (!el) return;
            const handler = () => {
                if (!state.server) return;
                if (prop === "disk" || prop === "diskMode" || prop === "backend") {
                    state.server[prop] = el.value.trim() || (prop === "backend" ? "cloudinit" : null);
                } else {
                    const num = parseInt(el.value, 10);
                    state.server[prop] = isNaN(num) ? null : num;
                }
                updateCLI();
                updateRamWarning();
            };
            el.addEventListener("input", handler);
            if (el.tagName === "SELECT") {
                el.addEventListener("change", handler);
            }
        });
    }

    // --- Boutons ---

    function setupButtons() {
        btnLaunch.addEventListener("click", launchLab);
        btnStop.addEventListener("click", stopLab);
        btnRestart.addEventListener("click", restartLab);
        btnClean.addEventListener("click", cleanLab);
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

    /**
     * Nettoie /tmp/vde/ quand la topologie change (suppression de VM/serveur).
     * Les anciens scripts ne correspondent plus a la nouvelle config.
     */
    function cleanPreservedState() {
        if (!state.labRunning && !state.hasPreservedState) return;

        // Arreter le lab si running
        if (state.labRunning) {
            fetch("/api/stop", { method: "POST", headers: { "Content-Type": "application/json" } })
                .then(() => fetch("/api/clean", { method: "POST", headers: { "Content-Type": "application/json" } }))
                .then(() => {
                    outputContent.textContent += "[INFO] Lab arrete et nettoye (topologie modifiee).\n";
                })
                .catch(() => {});
        } else {
            // Juste nettoyer les fichiers preserves
            fetch("/api/clean", { method: "POST", headers: { "Content-Type": "application/json" } })
                .then(() => {
                    outputContent.textContent += "[INFO] Etat precedent nettoye (topologie modifiee).\n";
                })
                .catch(() => {});
        }
        setLabIdle();
    }

    function addVM() {
        const vm = {
            id: state.nextVmId++,
            label: "",
            disk: "",
            ram: null,
            cpu: null,
            diskMode: null,
            backend: "cloudinit",
            pkgList: null,
            wlanCount: null,
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
        // Renumeroter les VMs restantes (1, 2, 3, ...)
        state.vms.forEach((vm, i) => {
            vm.id = i + 1;
        });
        state.nextVmId = state.vms.length + 1;
        // Corriger selectedVmId si necessaire
        if (state.selectedVmId !== null) {
            const still = state.vms.find(v => v.id === state.selectedVmId);
            if (!still) state.selectedVmId = null;
        }
        // Nettoyer /tmp/vde/ si un lab a ete lance (topologie modifiee)
        cleanPreservedState();
        updateAll();
    }

    function addServer() {
        if (state.server) return; // un seul serveur
        state.server = { backend: "cloudinit", disk: "", ram: null, cpu: null, diskMode: null, x: null, y: null };
        selectServerPanel();
        updateAll();
    }

    function removeServer() {
        state.server = null;
        state.selectedServerPanel = false;
        cleanPreservedState();
        updateAll();
    }

    function selectVM(vmId) {
        const vm = state.vms.find(v => v.id === vmId);
        if (!vm) return;
        state.selectedVmId = vmId;
        state.selectedServerPanel = false;
        Config.updateVmPanel(state);
        Config.updateServerPanel(state);
        renderCanvas();
    }

    function selectServerPanel() {
        state.selectedVmId = null;
        state.selectedServerPanel = true;
        Config.updateVmPanel(state);
        Config.updateServerPanel(state);
        renderCanvas();
    }

    function deselectVM() {
        state.selectedVmId = null;
        state.selectedServerPanel = false;
        Config.updateVmPanel(state);
        Config.updateServerPanel(state);
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

    // --- RAM warning ---

    function fetchMemory() {
        fetch("/api/memory")
            .then(r => r.json())
            .then(data => {
                state.availableRam = data.ram_mb;
                state.availableSwap = data.swap_mb;
                // Afficher les valeurs RAM/swap
                const info = document.getElementById("ram-info");
                if (info && data.ram_mb !== null) {
                    const swap = data.swap_mb || 0;
                    const swapTxt = swap > 0 ? ` | Swap : ${swap} MB` : "";
                    info.textContent = `RAM : ${data.ram_mb} MB${swapTxt}`;
                }
                updateRamWarning();
            })
            .catch(() => {});
    }

    function updateRamWarning() {
        const warning = document.getElementById("ram-warning");
        if (!warning) return;

        if (state.availableRam === null || state.availableRam === undefined) {
            warning.className = "ram-warning hidden";
            warning.textContent = "";
            return;
        }

        const globalRam = parseInt(document.getElementById("opt-ram")?.value, 10) || 1024;
        let totalRam = 0;
        state.vms.forEach(vm => {
            totalRam += vm.ram || globalRam;
        });

        // Ajouter la RAM du serveur si present
        if (state.server) {
            totalRam += state.server.ram || 512;
        }

        const ram = state.availableRam;
        const swap = state.availableSwap || 0;
        const total = ram + swap;
        const swapInfo = swap > 0 ? ` + ${swap} MB swap` : "";
        const sysInfo = `Systeme : ${ram} MB RAM${swapInfo}`;

        if (totalRam >= total) {
            warning.className = "ram-warning danger";
            warning.textContent = `Memoire insuffisante ! ${totalRam} MB requis. ${sysInfo}`;
        } else if (totalRam >= ram) {
            warning.className = "ram-warning warn";
            warning.textContent = `RAM depassee (swap sera utilise). ${totalRam} MB requis. ${sysInfo}`;
        } else if (totalRam >= ram * 0.7) {
            warning.className = "ram-warning warn";
            warning.textContent = `Attention : ${totalRam} MB requis. ${sysInfo}`;
        } else {
            warning.className = "ram-warning hidden";
            warning.textContent = "";
        }
    }

    // --- State sync ---

    function syncState() {
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
        Config.updateServerPanel(state);
        updateDiskWarning();
        updateRamWarning();
    }

    function renderCanvas() {
        Topology.renderTopology(canvas, state);
    }

    function updateCLI() {
        const params = Config.gatherFormParams(state.vms);
        if (state.server) Config.addServerParams(params, state.server);
        cliPreview.textContent = Config.buildCommandString(params);
    }

    // --- API calls ---

    async function launchLab() {
        const params = Config.gatherFormParams(state.vms);
        if (state.server) Config.addServerParams(params, state.server);
        if (!params.disk) {
            alert("Veuillez specifier un chemin d'image disque.");
            return;
        }
        if (state.vms.length < 1) {
            alert("Ajoutez au moins une VM sur le canvas.");
            return;
        }

        // Verification memoire
        if (state.availableRam !== null && state.availableRam !== undefined) {
            const globalRam = parseInt(document.getElementById("opt-ram")?.value, 10) || 1024;
            let totalRam = 0;
            state.vms.forEach(vm => { totalRam += vm.ram || globalRam; });
            if (state.server) totalRam += state.server.ram || 512;
            const ram = state.availableRam;
            const swap = state.availableSwap || 0;
            const total = ram + swap;
            const swapInfo = swap > 0 ? ` + ${swap} MB swap` : "";
            if (totalRam >= total) {
                if (!confirm(
                    `Memoire insuffisante : ${totalRam} MB requis, seulement ${ram} MB RAM${swapInfo} disponibles.\n` +
                    "Le systeme risque de tuer les VMs (OOM). Lancer quand meme ?"
                )) {
                    return;
                }
            } else if (totalRam >= ram) {
                if (!confirm(
                    `RAM depassee : ${totalRam} MB requis, ${ram} MB RAM${swapInfo}.\n` +
                    "Le swap sera utilise (performances degradees). Lancer quand meme ?"
                )) {
                    return;
                }
            }
        }

        btnLaunch.disabled = true;
        btnStop.disabled = false;
        btnRestart.disabled = true;
        btnClean.disabled = true;
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
                setLabIdle();
                return;
            }
            outputContent.textContent += `$ ${data.command}\n`;
            startPolling();
        } catch (err) {
            alert("Erreur reseau : " + err.message);
            setLabIdle();
        }
    }

    async function stopLab() {
        btnStop.disabled = true;
        try {
            const resp = await fetch("/api/stop", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
            });
            const data = await resp.json();
            if (data.message) {
                outputContent.textContent += `[INFO] ${data.message}\n`;
            }
        } catch (err) {
            outputContent.textContent += `[ERREUR] ${err.message}\n`;
        }
        setLabStopped(true);
    }

    async function restartLab() {
        btnRestart.disabled = true;
        btnClean.disabled = true;
        btnLaunch.disabled = true;
        btnStop.disabled = false;
        state.labRunning = true;
        state.hasPreservedState = false;
        setStatus("running");

        // Deplier le panel output
        document.getElementById("output-panel").classList.remove("collapsed");
        document.getElementById("btn-toggle-output").textContent = "Replier";

        try {
            const resp = await fetch("/api/restart", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
            });
            const data = await resp.json();
            if (!resp.ok) {
                outputContent.textContent += `[ERREUR] ${data.error || "Echec du redemarrage."}\n`;
                // Retour a l'etat stopped
                setLabStopped(true);
                return;
            }
            outputContent.textContent += `[INFO] ${data.message}\n`;
            startPolling();
        } catch (err) {
            outputContent.textContent += `[ERREUR] ${err.message}\n`;
            setLabStopped(true);
        }
    }

    async function cleanLab() {
        if (!confirm("Supprimer /tmp/vde/ et tout l'etat du lab ?")) return;
        btnClean.disabled = true;
        btnRestart.disabled = true;
        try {
            const resp = await fetch("/api/clean", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
            });
            const data = await resp.json();
            if (data.message) {
                outputContent.textContent += `[INFO] ${data.message}\n`;
            }
        } catch (err) {
            outputContent.textContent += `[ERREUR] ${err.message}\n`;
        }
        setLabIdle();
    }

    function setLabStopped(hasPreservedState) {
        state.labRunning = false;
        state.hasPreservedState = !!hasPreservedState;
        stopPolling();
        if (hasPreservedState) {
            btnLaunch.disabled = false;
            btnStop.disabled = true;
            btnRestart.disabled = false;
            btnClean.disabled = false;
            setStatus("stopped");
        } else {
            setLabIdle();
        }
    }

    function setLabIdle() {
        state.labRunning = false;
        state.hasPreservedState = false;
        btnLaunch.disabled = false;
        btnStop.disabled = true;
        btnRestart.disabled = true;
        btnClean.disabled = true;
        setStatus("idle");
        stopPolling();
    }

    function checkInitialStatus() {
        fetch("/api/status")
            .then(r => r.json())
            .then(data => {
                if (data.running) {
                    state.labRunning = true;
                    btnLaunch.disabled = true;
                    btnStop.disabled = false;
                    btnRestart.disabled = true;
                    btnClean.disabled = true;
                    setStatus("running");
                    startPolling();
                } else if (data.has_preserved_state) {
                    setLabStopped(true);
                } else {
                    setLabIdle();
                }
            })
            .catch(() => {});
    }

    function setStatus(status) {
        statusBadge.className = "badge";
        if (status === "running") {
            statusBadge.classList.add("badge-running");
            statusBadge.textContent = "Running";
        } else if (status === "stopped") {
            statusBadge.classList.add("badge-stopped");
            statusBadge.textContent = "Stopped";
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
            if (!data.running && state.labRunning) {
                setLabStopped(data.has_preserved_state);
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

    // --- Toggle palette / sidebar ---

    function setupPanelToggles() {
        const main = document.getElementById("main");
        const palette = document.getElementById("palette");
        const sidebar = document.getElementById("sidebar");
        const btnPalette = document.getElementById("btn-toggle-palette");
        const btnSidebar = document.getElementById("btn-toggle-sidebar");

        btnPalette.addEventListener("click", () => {
            palette.classList.toggle("collapsed");
            main.classList.toggle("palette-collapsed");
            btnPalette.innerHTML = palette.classList.contains("collapsed") ? "&raquo;" : "&laquo;";
            btnPalette.title = palette.classList.contains("collapsed") ? "Deplier la palette" : "Replier la palette";
        });

        btnSidebar.addEventListener("click", () => {
            sidebar.classList.toggle("collapsed");
            main.classList.toggle("sidebar-collapsed");
            btnSidebar.innerHTML = sidebar.classList.contains("collapsed") ? "&laquo;" : "&raquo;";
            btnSidebar.title = sidebar.classList.contains("collapsed") ? "Deplier la configuration" : "Replier la configuration";
        });
    }

    // --- Modal Aide ---

    function setupHelpModal() {
        const overlay = document.getElementById("help-overlay");
        const btnOpen = document.getElementById("btn-help");
        const btnClose = document.getElementById("btn-close-help");

        btnOpen.addEventListener("click", () => {
            overlay.style.display = "flex";
        });

        btnClose.addEventListener("click", () => {
            overlay.style.display = "none";
        });

        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) overlay.style.display = "none";
        });

        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && overlay.style.display !== "none") {
                overlay.style.display = "none";
            }
        });
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
