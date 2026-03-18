# setup-qemu-vde-debian

Script bash de déploiement automatisé de labs QEMU multi-VMs Debian, avec réseau inter-VMs via VDE switch et accès Internet via NAT. La configuration des VMs (réseau, utilisateurs, paquets) est entièrement gérée par cloud-init via un seed ISO généré automatiquement par le script.

---

## Prérequis

### Image Debian

```bash
# Image genericcloud — accès via cloud-init (recommandée)
wget https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2

# Image nocloud — accès root sans mot de passe (test rapide)
wget https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-nocloud-amd64.qcow2
```

### Paquets host

```bash
sudo apt install qemu-system-x86 vde2 xterm cloud-image-utils
```

### Installation

```bash
chmod +x setup-qemu-vde-debian.sh
```

---

## Architecture réseau

```
  VM1                    VM2                    VMn
  ┌──────────────┐       ┌──────────────┐       ┌──────────────┐
  │ ens4 (VDE)   │       │ ens4 (VDE)   │       │ ens4 (VDE)   │
  │ 192.168.100.x│       │ 192.168.100.x│       │ 192.168.100.x│
  │ ens5 (NAT)   │       │ ens5 (NAT)   │       │ ens5 (NAT)   │
  │ 10.0.2.15    │       │ 10.0.2.15    │       │ 10.0.2.15    │
  └──────┬───────┘       └──────┬───────┘       └──────┬───────┘
         │ ens4                 │ ens4                  │ ens4
         └──────────────────────┴───────────────────────┘
                                │
                        vde_switch (inter-VMs)
         │ ens5                 │ ens5                  │ ens5
         └──────────────────────┴───────────────────────┘
                                │
                        NAT QEMU → Internet
```

---

## Utilisation

```bash
./setup-qemu-vde-debian.sh [OPTIONS] disk.qcow2
```

### Options

| Option | Défaut | Description |
|--------|--------|-------------|
| `--count N` | 2 | Nombre de VMs |
| `--ram MB` | 1024 | RAM par VM |
| `--cpu N` | 2 | CPUs par VM |
| `--disk-mode MODE` | snapshot | Mode disque (voir ci-dessous) |
| `--password P` | — | Mot de passe utilisateur `debian` |
| `--ssh-key F` | `~/.ssh/id_ed25519.pub` | Clé publique SSH |
| `--pkg-list F` | `/tmp/packages` | Fichier liste de paquets à installer |
| `--vde-net CIDR` | `192.168.100.0/24` | Réseau VDE inter-VMs |
| `--base-ip N` | 10 | Dernier octet de la première IP VDE |
| `--base-ssh N` | 2222 | Premier port SSH host |
| `--no-nat` | — | VDE seul, sans accès Internet |
| `--hub` | — | Switch VDE en mode HUB (capture trafic complet) |
| `--mirror` | — | Port mirroring pour capture Wireshark |
| `--stop` | — | Arrêter le lab |
| `--help` | — | Afficher l'aide |

### Modes disque

| Mode | Persistance | Description |
|------|-------------|-------------|
| `snapshot` | ❌ | Écritures en RAM, perdues à l'extinction. Idéal pour les tests. |
| `overlay` | ✅ | Fichier delta par VM. État conservé entre les reboots. |
| `copy` | ✅ | Copie complète du disque. Idéal pour récupérer le disque modifié. |
| `shared` | ⚠️ | Disque partagé entre les VMs. Risque de corruption. |

---

## Exemples

### Lab rapide — 2 VMs avec mot de passe

```bash
./setup-qemu-vde-debian.sh --count 2 --password monpass debian-12-genericcloud-amd64.qcow2
```

```
VM1 → 192.168.100.10 | SSH : ssh -p 2222 debian@localhost
VM2 → 192.168.100.11 | SSH : ssh -p 2223 debian@localhost
```

### Lab persistant — overlay + paquets

```bash
cat > /tmp/packages << 'EOF'
tcpdump
nmap
netcat-openbsd
EOF

./setup-qemu-vde-debian.sh \
    --count 3 \
    --disk-mode overlay \
    --password monpass \
    --pkg-list /tmp/packages \
    debian-12-genericcloud-amd64.qcow2
```

### Réseau personnalisé

```bash
./setup-qemu-vde-debian.sh \
    --count 4 \
    --vde-net 10.10.0.0/24 \
    --base-ip 5 \
    --password monpass \
    debian-12-genericcloud-amd64.qcow2
```

### Modifier et récupérer le disque

```bash
# Lancer en mode copy
./setup-qemu-vde-debian.sh --count 1 --disk-mode copy --password monpass debian-12-genericcloud-amd64.qcow2

# Faire les modifications dans la VM puis l'éteindre
sudo poweroff

# Récupérer le disque modifié (AVANT --stop)
cp /tmp/vde/vm1-disk.qcow2 debian-modifie.qcow2

# Arrêter le lab
./setup-qemu-vde-debian.sh --stop
```

### Capture trafic Wireshark

```bash
# Port mirroring — capture sans impacter les VMs
./setup-qemu-vde-debian.sh --count 2 --password monpass --mirror debian-12-genericcloud-amd64.qcow2

# Mode HUB — capture complète
./setup-qemu-vde-debian.sh --count 2 --password monpass --hub debian-12-genericcloud-amd64.qcow2
```

### Arrêter le lab

```bash
./setup-qemu-vde-debian.sh --stop
```

---

## Connexion aux VMs

```bash
# SSH depuis le host
ssh -p 2222 debian@localhost   # VM1
ssh -p 2223 debian@localhost   # VM2

# Vérifier la connectivité dans la VM
ip addr show          # ens4 = VDE, ens5 = NAT
ping 192.168.100.11   # inter-VMs
ping 8.8.8.8          # Internet

# Surveiller cloud-init
cloud-init status --wait
```

---

## Notes

- Le premier boot avec `genericcloud` prend **3 à 5 minutes** — cloud-init configure le réseau et installe les paquets via apt.
- Les boots suivants sont rapides en mode `overlay` (cloud-init ne rejoue pas).
- En mode `snapshot`, cloud-init rejoue à chaque boot.
- Le script ne nécessite **pas de root** sur le host.

