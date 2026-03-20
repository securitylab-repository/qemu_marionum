/**
 * config.js — Panel de configuration et construction CLI
 *
 * Gere les champs specifiques par backend, la collecte des parametres
 * du formulaire, et la construction de la commande CLI pour l'apercu.
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
     * Collecte tous les parametres du formulaire en objet JS.
     */
    function gatherFormParams(vmCount) {
        const backend = document.querySelector('input[name="backend"]:checked')?.value || "cloudinit";
        const params = {
            backend: backend,
            count: vmCount,
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
        gatherFormParams,
        buildCommandString,
        getSelectedBackend,
    };
})();
