/**
 * topology.js — Rendu SVG de la topologie reseau
 *
 * Gere le VDE switch, les noeuds VM, le NAT gateway, le serveur vwifi,
 * les lignes de connexion et le placement circulaire.
 */

/* exported Topology */

const Topology = (() => {
    const NS = "http://www.w3.org/2000/svg";

    // Dimensions des elements
    const VM_W = 100;
    const VM_H = 50;
    const SWITCH_W = 120;
    const SWITCH_H = 40;
    const NAT_RX = 60;
    const NAT_RY = 22;
    const VWIFI_W = 120;
    const VWIFI_H = 50;

    // Derniere disposition calculee (pour initialiser les drags)
    let lastLayout = null;

    /**
     * Convertit des coordonnees ecran en coordonnees SVG.
     */
    function screenToSVG(svgEl, screenX, screenY) {
        const ctm = svgEl.getScreenCTM();
        if (!ctm) return { x: screenX, y: screenY };
        const inv = ctm.inverse();
        const pt = svgEl.createSVGPoint();
        pt.x = screenX;
        pt.y = screenY;
        const svgPt = pt.matrixTransform(inv);
        return { x: svgPt.x, y: svgPt.y };
    }

    /**
     * Retourne la derniere disposition calculee.
     */
    function getLastLayout() {
        return lastLayout;
    }

    /**
     * Calcule les positions des VMs en cercle autour du switch.
     */
    function calculateVMPositions(count, cx, cy, radius) {
        const positions = [];
        if (count === 0) return positions;
        // Commence en haut (-PI/2), reparti sur un arc
        const startAngle = -Math.PI / 2;
        const spread = count === 1 ? 0 : Math.PI * 1.2;
        for (let i = 0; i < count; i++) {
            let angle;
            if (count === 1) {
                angle = Math.PI / 2; // En bas du switch
            } else {
                angle = startAngle + (spread / (count - 1)) * i;
                // Decaler pour eviter la zone du haut (NAT)
                angle += Math.PI * 0.4;
            }
            positions.push({
                x: cx + radius * Math.cos(angle),
                y: cy + radius * Math.sin(angle),
            });
        }
        return positions;
    }

    /**
     * Cree un element SVG avec des attributs.
     */
    function svgEl(tag, attrs) {
        const el = document.createElementNS(NS, tag);
        for (const [k, v] of Object.entries(attrs)) {
            el.setAttribute(k, v);
        }
        return el;
    }

    /**
     * Calcule l'IP d'une VM.
     */
    function vmIP(index, vdeNet, baseIP) {
        const parts = vdeNet.split("/")[0].split(".");
        const lastOctet = parseInt(baseIP, 10) + index;
        return `${parts[0]}.${parts[1]}.${parts[2]}.${lastOctet}`;
    }

    /**
     * Rendu complet de la topologie.
     */
    function renderTopology(canvas, state) {
        // Nettoyer le canvas
        canvas.innerHTML = "";

        const rect = canvas.getBoundingClientRect();
        const W = rect.width || 700;
        const H = rect.height || 500;
        canvas.setAttribute("viewBox", `0 0 ${W} ${H}`);

        const cx = W / 2;
        const cy = H / 2;
        const radius = Math.min(W, H) * 0.3;

        const vms = state.vms || [];
        const vmCount = vms.length;
        const noNat = state.noNat || false;
        const vdeNet = state.vdeNet || "192.168.100.0/24";
        const baseIP = state.baseIP || 10;
        const selectedVmId = state.selectedVmId;

        // Groupe pour les lignes (arriere-plan)
        const gLines = svgEl("g", { class: "lines-group" });
        canvas.appendChild(gLines);

        // Positions des VMs (avec overrides)
        const defaultVmPositions = calculateVMPositions(vmCount, cx, cy, radius);
        const vmPositions = defaultVmPositions.map((pos, i) => {
            const vm = vms[i];
            return {
                x: (vm && vm.x !== null && vm.x !== undefined) ? vm.x : pos.x,
                y: (vm && vm.y !== null && vm.y !== undefined) ? vm.y : pos.y,
            };
        });

        // Position du switch (avec override)
        const switchCx = (state.switchPos && state.switchPos.x !== null) ? state.switchPos.x : cx;
        const switchCy = (state.switchPos && state.switchPos.y !== null) ? state.switchPos.y : cy;

        // Position du serveur (avec override)
        const defaultSrvX = switchCx - SWITCH_W / 2 - VWIFI_W - 30;
        const defaultSrvY = switchCy;
        let serverPosition = null;

        // Stocker la disposition pour le drag
        lastLayout = {
            switchCenter: { x: switchCx, y: switchCy },
            vmPositions: vmPositions.map(p => ({ x: p.x, y: p.y })),
            defaultSwitch: { x: cx, y: cy },
            defaultVmPositions: defaultVmPositions.map(p => ({ x: p.x, y: p.y })),
            serverPosition: null,
        };

        // --- Switch VDE (centre) ---
        const switchX = switchCx - SWITCH_W / 2;
        const switchY = switchCy - SWITCH_H / 2;
        const gSwitch = svgEl("g", { class: "switch-node", "data-type": "switch" });
        gSwitch.appendChild(svgEl("rect", {
            x: switchX, y: switchY,
            width: SWITCH_W, height: SWITCH_H,
        }));
        const hubLabel = state.hub ? "VDE HUB" : "VDE Switch";
        const switchText = svgEl("text", {
            x: switchCx, y: switchCy + 5,
        });
        switchText.textContent = hubLabel;
        gSwitch.appendChild(switchText);
        canvas.appendChild(gSwitch);

        // --- NAT gateway (en haut) ---
        if (!noNat) {
            const natCx = cx;
            const natCy = 40;

            // Ligne switch -> NAT
            gLines.appendChild(svgEl("line", {
                x1: switchCx, y1: switchY,
                x2: natCx, y2: natCy + NAT_RY,
                class: "link-line-nat",
            }));

            const gNat = svgEl("g", { class: "nat-node" });
            gNat.appendChild(svgEl("ellipse", {
                cx: natCx, cy: natCy,
                rx: NAT_RX, ry: NAT_RY,
            }));
            const natText = svgEl("text", {
                x: natCx, y: natCy + 4,
            });
            natText.textContent = "NAT / Internet";
            gNat.appendChild(natText);
            canvas.appendChild(gNat);
        }

        // --- Serveur vwifi (si state.server existe) ---
        if (state.server) {
            const srvCx = (state.server.x !== null && state.server.x !== undefined) ? state.server.x : defaultSrvX + VWIFI_W / 2;
            const srvCy = (state.server.y !== null && state.server.y !== undefined) ? state.server.y : defaultSrvY;
            const srvX = srvCx - VWIFI_W / 2;
            const srvY = srvCy - VWIFI_H / 2;

            serverPosition = { x: srvCx, y: srvCy };
            lastLayout.serverPosition = serverPosition;

            // Ligne switch -> serveur vwifi
            gLines.appendChild(svgEl("line", {
                x1: switchCx, y1: switchCy,
                x2: srvCx, y2: srvCy,
                class: "link-line",
            }));

            const gSrv = svgEl("g", { class: "vwifi-server-node", "data-vm-id": "server" });
            gSrv.appendChild(svgEl("rect", {
                x: srvX, y: srvY,
                width: VWIFI_W, height: VWIFI_H,
            }));
            const srvText1 = svgEl("text", {
                x: srvCx, y: srvY + 20,
            });
            srvText1.textContent = "vwifi-server";
            gSrv.appendChild(srvText1);

            const parts = vdeNet.split("/")[0].split(".");
            const srvIPText = `${parts[0]}.${parts[1]}.${parts[2]}.2`;
            const srvText2 = svgEl("text", {
                x: srvCx, y: srvY + 36,
                class: "vm-ip",
            });
            srvText2.textContent = srvIPText;
            gSrv.appendChild(srvText2);

            // Bouton supprimer serveur
            const gDel = svgEl("g", { class: "srv-delete" });
            gDel.appendChild(svgEl("circle", {
                cx: srvX + VWIFI_W - 2, cy: srvY + 2,
                r: 8,
            }));
            const delText = svgEl("text", {
                x: srvX + VWIFI_W - 2, y: srvY + 6,
                "text-anchor": "middle",
            });
            delText.textContent = "\u00d7";
            gDel.appendChild(delText);
            gSrv.appendChild(gDel);

            canvas.appendChild(gSrv);
        }

        // --- VMs ---
        vmPositions.forEach((pos, i) => {
            const vm = vms[i];
            const vmX = pos.x - VM_W / 2;
            const vmY = pos.y - VM_H / 2;

            // Ligne VM -> Switch
            gLines.appendChild(svgEl("line", {
                x1: pos.x, y1: pos.y,
                x2: switchCx, y2: switchCy,
                class: "link-line",
            }));

            const isSelected = vm.id === selectedVmId;
            const classes = "vm-node" + (isSelected ? " vm-selected" : "");
            const gVM = svgEl("g", { class: classes, "data-vm-id": vm.id });

            // Fond
            gVM.appendChild(svgEl("rect", {
                class: "vm-bg",
                x: vmX, y: vmY,
                width: VM_W, height: VM_H,
            }));

            // Nom + label
            const vmLabel = vm.label ? `VM${vm.id} — ${vm.label}` : `VM${vm.id}`;
            const nameText = svgEl("text", {
                x: pos.x, y: pos.y - 8,
            });
            nameText.textContent = vmLabel;
            gVM.appendChild(nameText);

            // IP
            const ip = vmIP(i, vdeNet, baseIP);
            const ipText = svgEl("text", {
                x: pos.x, y: pos.y + 6,
                class: "vm-ip",
            });
            ipText.textContent = ip;
            gVM.appendChild(ipText);

            // Info per-VM : toujours afficher le backend
            const infoParts = [];
            if (vm.backend) {
                infoParts.push(vm.backend);
            }
            if (vm.disk) {
                const name = vm.disk.split("/").pop();
                infoParts.push(name.length > 12 ? name.substring(0, 12) + "..." : name);
            }
            if (vm.ram) infoParts.push(vm.ram + "M");
            if (vm.cpu) infoParts.push(vm.cpu + "cpu");
            if (vm.diskMode) infoParts.push(vm.diskMode);

            if (infoParts.length > 0) {
                const infoText = svgEl("text", {
                    x: pos.x, y: pos.y + 18,
                    class: "vm-info",
                });
                infoText.textContent = infoParts.join(" | ");
                gVM.appendChild(infoText);
            }

            // Bouton supprimer
            const gDel = svgEl("g", {
                class: "vm-delete",
                "data-vm-id": vm.id,
            });
            gDel.appendChild(svgEl("circle", {
                cx: vmX + VM_W - 2, cy: vmY + 2,
                r: 8,
            }));
            const delText = svgEl("text", {
                x: vmX + VM_W - 2, y: vmY + 6,
                "text-anchor": "middle",
            });
            delText.textContent = "\u00d7";
            gDel.appendChild(delText);
            gVM.appendChild(gDel);

            canvas.appendChild(gVM);
        });

        // Masquer/afficher le hint
        const hint = document.getElementById("canvas-hint");
        if (hint) {
            hint.classList.toggle("hidden", vmCount > 0 || !!state.server);
        }
    }

    return {
        renderTopology,
        calculateVMPositions,
        vmIP,
        screenToSVG,
        getLastLayout,
    };
})();
