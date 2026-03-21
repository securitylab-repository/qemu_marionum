/**
 * config.js — Panel de configuration et construction CLI
 *
 * Gere les champs specifiques par backend, la collecte des parametres
 * du formulaire, la configuration per-VM, et la construction de la
 * commande CLI pour l'apercu.
 */

/* exported Config */

const Config = (() => {

    // Configuration par backend : RAM par defaut et fieldsets visibles
    const BACKEND_CONFIG = {
        fwcfg: {
            label: "Alpine (fw_cfg)",
            script: "./fwcfg.sh",
            defaultRAM: 512,
            fieldsets: ["opts-fwcfg"],
        },
        cloudinit: {
            label: "Debian (cloud-init)",
            script: "./cloudinit.sh",
            defaultRAM: 1024,
            fieldsets: ["opts-cloudinit"],
        },
        vwifi: {
            label: "Debian (vwifi)",
            script: "./vwifi.sh",
            defaultRAM: 1024,
            fieldsets: ["opts-vwifi"],
        },
    };

    /**
     * Affiche/masque les fieldsets specifiques au backend selectionne.
     * Met a jour la RAM par defaut.
     */
    function switchBackend(name) {
        const cfg = BACKEND_CONFIG[name];
        if (!cfg) return;

        // Masquer tous les fieldsets backend
        document.querySelectorAll(".backend-opts").forEach(fs => {
            fs.style.display = "none";
        });

        // Afficher les fieldsets du backend courant
        cfg.fieldsets.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = "";
        });

        // Mettre a jour la RAM par defaut
        const ramInput = document.getElementById("opt-ram");
        if (ramInput) {
            ramInput.value = cfg.defaultRAM;
        }
    }

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
            backendSelect.value = vm.backend || "";
            const globalBackend = document.querySelector('input[name="backend"]:checked')?.value || "cloudinit";
            const globalLabel = BACKEND_CONFIG[globalBackend]?.label || globalBackend;
            const globalOpt = backendSelect.querySelector('option[value=""]');
            if (globalOpt) {
                globalOpt.textContent = `(global: ${globalLabel})`;
            }
            // Masquer le select si le backend global est vwifi (pas d'override possible)
            const backendRow = backendSelect.closest(".form-row");
            if (backendRow) {
                backendRow.style.display = (globalBackend === "vwifi") ? "none" : "";
            }
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
    }

    /**
     * Verifie si une VM a une config differente du global.
     */
    function vmHasOverride(vm) {
        return !!(vm.disk || vm.ram || vm.cpu || vm.diskMode || vm.backend || vm.pkgList);
    }

    /**
     * Verifie si au moins une VM a une surcharge.
     */
    function hasAnyPerVmConfig(vms) {
        return vms.some(vmHasOverride);
    }

    /**
     * Collecte tous les parametres du formulaire en objet JS.
     * Si des VMs ont des surcharges, inclut la cle `vms`.
     */
    function gatherFormParams(vms) {
        const backend = document.querySelector('input[name="backend"]:checked')?.value || "cloudinit";
        const params = {
            backend: backend,
            count: vms.length,
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

        // Options specifiques fwcfg
        if (backend === "fwcfg") {
            const v = document.getElementById("opt-net-script")?.value?.trim();
            if (v) params.net_script = v;
        }

        // Options specifiques cloudinit
        if (backend === "cloudinit") {
            const pw = document.getElementById("opt-password")?.value?.trim();
            if (pw) params.password = pw;
            const sk = document.getElementById("opt-ssh-key")?.value?.trim();
            if (sk) params.ssh_key = sk;
            const sd = document.getElementById("opt-seeds-dir")?.value?.trim();
            if (sd) params.seeds_dir = sd;
        }

        // Options specifiques vwifi
        if (backend === "vwifi") {
            const pw = document.getElementById("opt-password-vwifi")?.value?.trim();
            if (pw) params.password = pw;
            const sk = document.getElementById("opt-ssh-key-vwifi")?.value?.trim();
            if (sk) params.ssh_key = sk;
            const sd = document.getElementById("opt-seeds-dir-vwifi")?.value?.trim();
            if (sd) params.seeds_dir = sd;
            const wc = parseInt(document.getElementById("opt-wlan-count")?.value, 10);
            if (wc) params.wlan_count = wc;
        }

        // Per-VM config si au moins une VM a une surcharge
        if (hasAnyPerVmConfig(vms)) {
            params.vms = vms.map(vm => ({
                id: vm.id,
                disk: vm.disk || null,
                ram: vm.ram || null,
                cpu: vm.cpu || null,
                disk_mode: vm.diskMode || null,
                backend: vm.backend || null,
                pkg_list: vm.pkgList || null,
            }));
        }

        // Nettoyer les undefined
        Object.keys(params).forEach(k => {
            if (params[k] === undefined || params[k] === "") {
                delete params[k];
            }
        });

        return params;
    }

    /**
     * Construit la chaine de commande CLI (pour l'apercu en temps reel).
     */
    function buildCommandString(params) {
        const backend = params.backend || "cloudinit";
        const cfg = BACKEND_CONFIG[backend];
        if (!cfg) return "";

        // Mode per-VM : affichage multi-ligne
        if (params.vms) {
            const lines = ["# Mode per-VM — script genere dans /tmp/vde/webgui-launch.sh"];
            lines.push(`# Backend global: ${cfg.label} | ${params.count} VMs`);
            lines.push("");
            params.vms.forEach((vm, i) => {
                const parts = [`VM${vm.id}:`];
                if (vm.backend && vm.backend !== backend) {
                    const vmCfg = BACKEND_CONFIG[vm.backend];
                    parts.push(`backend=${vmCfg ? vmCfg.label : vm.backend}`);
                }
                parts.push(`disk=${vm.disk || params.disk || "<image>"}`);
                parts.push(`ram=${vm.ram || params.ram || "default"}`);
                parts.push(`cpu=${vm.cpu || params.cpu || "default"}`);
                parts.push(`mode=${vm.disk_mode || params.disk_mode || "snapshot"}`);
                lines.push("  " + parts.join("  "));
            });
            return lines.join("\n");
        }

        // Mode simple : commande classique
        const parts = [cfg.script];

        parts.push("--count", String(params.count || 2));

        if (params.ram) parts.push("--ram", String(params.ram));
        if (params.cpu) parts.push("--cpu", String(params.cpu));

        if (params.vde_net) parts.push("--vde-net", params.vde_net);
        if (params.base_ip) parts.push("--base-ip", String(params.base_ip));
        if (params.base_ssh) parts.push("--base-ssh", String(params.base_ssh));

        if (params.disk_mode && params.disk_mode !== "snapshot") {
            parts.push("--disk-mode", params.disk_mode);
        }

        if (params.no_nat) parts.push("--no-nat");
        if (params.hub) parts.push("--hub");
        if (params.mirror) parts.push("--mirror");

        if (params.pkg_list) parts.push("--pkg-list", params.pkg_list);

        // Options specifiques
        if (backend === "fwcfg" && params.net_script) {
            parts.push("--net-script", params.net_script);
        }
        if ((backend === "cloudinit" || backend === "vwifi") && params.password) {
            parts.push("--password", params.password);
        }
        if ((backend === "cloudinit" || backend === "vwifi") && params.ssh_key) {
            parts.push("--ssh-key", params.ssh_key);
        }
        if ((backend === "cloudinit" || backend === "vwifi") && params.seeds_dir) {
            parts.push("--seeds-dir", params.seeds_dir);
        }
        if (backend === "vwifi" && params.wlan_count) {
            parts.push("--wlan-count", String(params.wlan_count));
        }

        // Disque en dernier
        parts.push(params.disk || "<image.qcow2>");

        return parts.join(" ");
    }

    /**
     * Retourne le backend selectionne.
     */
    function getSelectedBackend() {
        return document.querySelector('input[name="backend"]:checked')?.value || "cloudinit";
    }

    return {
        BACKEND_CONFIG,
        switchBackend,
        updateVmPanel,
        gatherFormParams,
        buildCommandString,
        getSelectedBackend,
    };
})();
