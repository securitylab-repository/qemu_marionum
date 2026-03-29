/**
 * config.js — Panel de configuration et construction CLI
 *
 * Gere les champs specifiques par backend, la collecte des parametres
 * du formulaire, la configuration per-VM, et la construction de la
 * commande CLI pour l'apercu.
 */

/* exported Config */

const Config = (() => {

    // Configuration par backend : RAM par defaut
    const BACKEND_CONFIG = {
        fwcfg:           { label: "Alpine (fw_cfg)",         defaultRAM: 512,  fieldsets: [] },
        cloudinit:       { label: "Debian (cloud-init)",     defaultRAM: 1024, fieldsets: [] },
        vwifi_cloudinit: { label: "Debian (vwifi)",          defaultRAM: 1024, fieldsets: [] },
        vwifi_fwcfg:     { label: "Alpine (fw_cfg + vwifi)", defaultRAM: 512,  fieldsets: [] },
    };

    /**
     * Met a jour le panel per-VM selon l'etat de selection.
     */
    function updateVmPanel(state) {
        const panel = document.getElementById("vm-config-panel");
        const title = document.getElementById("vm-config-title");
        if (!panel) return;

        if (state.selectedVmId === null) {
            panel.classList.remove("visible");
            return;
        }

        const vm = state.vms.find(v => v.id === state.selectedVmId);
        if (!vm) {
            panel.classList.remove("visible");
            return;
        }

        panel.classList.add("visible");
        title.textContent = `VM${vm.id}`;

        // Valeurs globales pour les placeholders
        const globalDisk = document.getElementById("disk-path")?.value?.trim() || "(aucun)";
        const globalRam = document.getElementById("opt-ram")?.value || "";
        const globalCpu = document.getElementById("opt-cpu")?.value || "";
        const globalDiskMode = document.getElementById("opt-disk-mode")?.value || "snapshot";

        // Remplir les champs per-VM
        const diskInput = document.getElementById("vm-disk-path");
        const ramInput = document.getElementById("vm-opt-ram");
        const cpuInput = document.getElementById("vm-opt-cpu");
        const diskModeSelect = document.getElementById("vm-opt-disk-mode");
        const backendSelect = document.getElementById("vm-opt-backend");

        if (backendSelect) {
            backendSelect.value = vm.backend || "cloudinit";
        }
        if (diskInput) {
            diskInput.value = vm.disk || "";
            diskInput.placeholder = globalDisk ? globalDisk : "(herite du global)";
        }
        if (ramInput) {
            ramInput.value = vm.ram || "";
            ramInput.placeholder = globalRam;
        }
        if (cpuInput) {
            cpuInput.value = vm.cpu || "";
            cpuInput.placeholder = globalCpu;
        }
        if (diskModeSelect) {
            diskModeSelect.value = vm.diskMode || "";
            // Mettre a jour le texte de l'option globale
            const globalOpt = diskModeSelect.querySelector('option[value=""]');
            if (globalOpt) {
                globalOpt.textContent = `(global: ${globalDiskMode})`;
            }
        }

        const pkgListInput = document.getElementById("vm-opt-pkg-list");
        if (pkgListInput) {
            const globalPkgList = document.getElementById("opt-pkg-list")?.value?.trim() || "";
            pkgListInput.value = vm.pkgList || "";
            pkgListInput.placeholder = globalPkgList ? globalPkgList : "(herite du global)";
        }

        // wlan-count : afficher quand le backend contient vwifi
        const wlanRow = document.querySelector(".vm-vwifi-opt");
        const wlanInput = document.getElementById("vm-opt-wlan-count");
        if (wlanRow && wlanInput) {
            const isVwifi = vm.backend === "vwifi_cloudinit" || vm.backend === "vwifi_fwcfg";
            wlanRow.style.display = isVwifi ? "" : "none";
            if (isVwifi) {
                wlanInput.value = vm.wlanCount || "";
                const globalWlan = document.getElementById("opt-wlan-count")?.value || "1";
                wlanInput.placeholder = globalWlan;
            }
        }
    }

    /**
     * Met a jour le panel vwifi-server selon l'etat.
     */
    function updateServerPanel(state) {
        const panel = document.getElementById("vwifi-server-panel");
        if (!panel) return;

        if (!state.server) {
            panel.classList.remove("visible");
            return;
        }

        panel.classList.add("visible");

        const srv = state.server || {};
        const backendSelect = document.getElementById("srv-opt-backend");
        const ramInput = document.getElementById("srv-opt-ram");
        const cpuInput = document.getElementById("srv-opt-cpu");
        const diskInput = document.getElementById("srv-disk-path");
        const diskModeSelect = document.getElementById("srv-opt-disk-mode");

        if (backendSelect) backendSelect.value = srv.backend || "cloudinit";
        if (ramInput) ramInput.value = srv.ram || "";
        if (cpuInput) cpuInput.value = srv.cpu || "";
        if (diskInput) {
            diskInput.value = srv.disk || "";
            const globalDisk = document.getElementById("disk-path")?.value?.trim() || "(aucun)";
            diskInput.placeholder = globalDisk || "(herite du global)";
        }
        if (diskModeSelect) {
            diskModeSelect.value = srv.diskMode || "";
            const globalMode = document.getElementById("opt-disk-mode")?.value || "snapshot";
            const globalOpt = diskModeSelect.querySelector('option[value=""]');
            if (globalOpt) globalOpt.textContent = `(global: ${globalMode})`;
        }
    }

    /**
     * Collecte tous les parametres du formulaire en objet JS.
     * Toujours inclut la cle `vms` (chaque VM a son backend).
     */
    function gatherFormParams(vms) {
        const params = {
            disk: document.getElementById("disk-path")?.value?.trim() || "",
            ram: parseInt(document.getElementById("opt-ram")?.value, 10) || undefined,
            cpu: parseInt(document.getElementById("opt-cpu")?.value, 10) || undefined,
            disk_mode: document.getElementById("opt-disk-mode")?.value || "snapshot",
            vde_net: document.getElementById("opt-vde-net")?.value?.trim() || undefined,
            base_ip: parseInt(document.getElementById("opt-base-ip")?.value, 10) || undefined,
            base_ssh: parseInt(document.getElementById("opt-base-ssh")?.value, 10) || undefined,
            pkg_list: document.getElementById("opt-pkg-list")?.value?.trim() || undefined,
            no_nat: document.getElementById("opt-no-nat")?.checked || false,
            hub: document.getElementById("opt-hub")?.checked || false,
            mirror: document.getElementById("opt-mirror")?.checked || false,
        };

        // Options globales (toujours collectees)
        const pw = document.getElementById("opt-password")?.value?.trim();
        if (pw) params.password = pw;
        const sk = document.getElementById("opt-ssh-key")?.value?.trim();
        if (sk) params.ssh_key = sk;
        const sd = document.getElementById("opt-seeds-dir")?.value?.trim();
        if (sd) params.seeds_dir = sd;
        const ns = document.getElementById("opt-net-script")?.value?.trim();
        if (ns) params.net_script = ns;
        const wc = parseInt(document.getElementById("opt-wlan-count")?.value, 10);
        if (wc) params.wlan_count = wc;

        // Per-VM config (toujours incluse)
        params.vms = vms.map(vm => ({
            id: vm.id,
            backend: vm.backend || "cloudinit",
            disk: vm.disk || null,
            ram: vm.ram || null,
            cpu: vm.cpu || null,
            disk_mode: vm.diskMode || null,
            pkg_list: vm.pkgList || null,
            wlan_count: vm.wlanCount || null,
        }));

        // Nettoyer les undefined
        Object.keys(params).forEach(k => {
            if (params[k] === undefined || params[k] === "") {
                delete params[k];
            }
        });

        return params;
    }

    /**
     * Ajoute les parametres du serveur a un objet params existant.
     */
    function addServerParams(params, server) {
        if (!server) return;
        params.server = {
            backend: server.backend || "cloudinit",
            ram: server.ram || null,
            cpu: server.cpu || null,
            disk: server.disk || null,
            disk_mode: server.diskMode || null,
        };
    }

    /**
     * Construit la chaine de commande CLI (pour l'apercu en temps reel).
     */
    function buildCommandString(params) {
        const vms = params.vms || [];
        if (vms.length === 0) return "# Ajoutez des VMs sur le canvas";

        const lines = ["# Mode per-VM — script genere dans /tmp/vde/webgui-launch.sh"];
        const srvLabel = params.server ? " + vwifi-server" : "";
        lines.push(`# ${vms.length} VM(s)${srvLabel}`);
        lines.push("");

        if (params.server) {
            const srv = params.server;
            const srvCfg = BACKEND_CONFIG[srv.backend];
            lines.push(`  vwifi-server: backend=${srvCfg ? srvCfg.label : srv.backend}  ram=${srv.ram || params.ram || "default"}  cpu=${srv.cpu || params.cpu || "default"}`);
        }

        vms.forEach(vm => {
            const vmCfg = BACKEND_CONFIG[vm.backend];
            const parts = [`VM${vm.id}:`];
            parts.push(`backend=${vmCfg ? vmCfg.label : vm.backend}`);
            parts.push(`disk=${vm.disk || params.disk || "<image>"}`);
            parts.push(`ram=${vm.ram || params.ram || "default"}`);
            parts.push(`cpu=${vm.cpu || params.cpu || "default"}`);
            parts.push(`mode=${vm.disk_mode || params.disk_mode || "snapshot"}`);
            if (vm.backend === "vwifi_cloudinit" || vm.backend === "vwifi_fwcfg") {
                parts.push(`wlan=${vm.wlan_count || params.wlan_count || 1}`);
            }
            lines.push("  " + parts.join("  "));
        });

        return lines.join("\n");
    }

    return {
        BACKEND_CONFIG,
        updateVmPanel,
        updateServerPanel,
        gatherFormParams,
        addServerParams,
        buildCommandString,
    };
})();
