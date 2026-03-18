# setup-qemu-vde.sh — Lab QEMU multi-VM avec VDE Switch

Script bash de gestion d'un lab cybersécurité basé sur QEMU et VDE. Permet de lancer plusieurs VMs Alpine Linux connectées entre elles via un switch virtuel, avec configuration réseau automatique, capture Wireshark et installation de paquets au boot.

---

## Prérequis

### Installation des dépendances

```bash
sudo apt install -y qemu-system-x86 vde2 xterm wireshark \
                    libvdeplug-pcap libpcap-dev cmake \
                    libvdeplug-dev git build-essential socat
```

### Compilation de vdecapture (capture réseau VDE)

```bash
git clone https://github.com/virtualsquare/vdecapture
cd vdecapture && mkdir build && cd build
cmake .. -DCMAKE_C_FLAGS="-I/usr/include/pcap"
make && sudo make install
```

### Rendre le script exécutable

```bash
chmod +x setup-qemu-vde.sh
```

---

## Préparer une VM Alpine (une seule fois)

```bash
# 1. Créer le disque
qemu-img create -f qcow2 alpine.qcow2 4G

# 2. Booter depuis l'ISO
qemu-system-x86_64 \
  -accel tcg,thread=multi -cpu qemu64 \
  -m 512 -smp 2 \
  -drive file=alpine.qcow2,format=qcow2,if=virtio \
  -cdrom alpine-standard-x86_64.iso \
  -boot d -nographic

# 3. Dans la VM — installer Alpine
setup-alpine   # choisir : eth0, dhcp, vda, sys

# 4. Dans la VM — préparer les scripts de boot
cat > /etc/local.d/setup-net.start << 'EOF'
#!/bin/sh
SCRIPT=/sys/firmware/qemu_fw_cfg/by_name/opt/setup-net.sh/raw
[ -f "$SCRIPT" ] && sh "$SCRIPT"
EOF

cat > /etc/local.d/setup-pkg.start << 'EOF'
#!/bin/sh
SCRIPT=/sys/firmware/qemu_fw_cfg/by_name/opt/setup-pkg.sh/raw
[ -f "$SCRIPT" ] && sh "$SCRIPT"
EOF

chmod +x /etc/local.d/setup-net.start /etc/local.d/setup-pkg.start
rc-update add local boot
poweroff
```

---

## Utilisation

### Syntaxe

```
./setup-qemu-vde.sh [OPTIONS] disk.qcow2
./setup-qemu-vde.sh --mirror
./setup-qemu-vde.sh --stop
```

### Options

| Option | Défaut | Description |
|--------|--------|-------------|
| `--count N` | `2` | Nombre de VMs à lancer |
| `--ram MB` | `512` | RAM par VM en mégaoctets |
| `--cpu N` | `2` | Nombre de CPUs par VM |
| `--vde-net CIDR` | `192.168.100.0/24` | Réseau VDE inter-VMs |
| `--base-ip N` | `10` | Dernier octet de la première IP VDE |
| `--base-ssh N` | `2222` | Premier port SSH sur le host |
| `--disk-mode M` | `snapshot` | Mode gestion des disques (voir ci-dessous) |
| `--pkg-list F` | `/tmp/packages` | Fichier liste de paquets Alpine à installer |
| `--net-script F` | `/tmp/setup-net.sh` | Script réseau personnalisé |
| `--no-nat` | — | Désactiver l'accès Internet (VDE seul) |
| `--hub` | — | Lancer le switch en mode HUB |
| `--mirror` | — | Activer le port mirroring Wireshark |
| `--stop` | — | Arrêter le lab proprement |
| `--help` | — | Afficher l'aide |

### Modes disque

| Mode | Persistance | Description |
|------|-------------|-------------|
| `snapshot` | ❌ volatile | Disque partagé, état en mémoire — perdu au reboot **(défaut)** |
| `overlay` | ✅ persistant | Fichier delta léger par VM — base intacte |
| `copy` | ✅ persistant | Copie complète du disque par VM |
| `shared` | ⚠️ risqué | Toutes les VMs sur le même disque |

---

## Exemples

### Lab simple

```bash
# 2 VMs avec accès Internet
./setup-qemu-vde.sh --count 2 alpine.qcow2

# 3 VMs avec état persistant (overlay)
./setup-qemu-vde.sh --count 3 --disk-mode overlay alpine.qcow2
```

### Avec installation de paquets automatique

```bash
# 1. Créer le fichier de paquets
cat > /tmp/packages << 'EOF'
# Outils réseau
tcpdump
curl
wget
# Outils sécurité
nmap
EOF

# 2. Lancer le lab
./setup-qemu-vde.sh --count 2 --pkg-list /tmp/packages alpine.qcow2

# 3. Overlay + paquets (recommandé pour un lab complet)
./setup-qemu-vde.sh --count 2 --disk-mode overlay --pkg-list /tmp/packages alpine.qcow2
```

### Réseau personnalisé

```bash
# Sous-réseau 10.10.0.0/24, IPs à partir de .20, SSH à partir du port 3000
./setup-qemu-vde.sh --count 3 \
  --vde-net 10.10.0.0/24 \
  --base-ip 20 \
  --base-ssh 3000 \
  alpine.qcow2

# VDE seul sans Internet
./setup-qemu-vde.sh --count 2 --no-nat alpine.qcow2
```

### Capture réseau Wireshark

```bash
# Mode HUB — tout le trafic visible par vdecapture
./setup-qemu-vde.sh --count 2 --hub alpine.qcow2

# Port mirroring sur un lab déjà lancé
./setup-qemu-vde.sh --mirror
# → affiche la commande Wireshark à lancer
# → sudo wireshark -k -i /tmp/vde/vde.pipe
```

### Arrêt

```bash
./setup-qemu-vde.sh --stop
```

---

## Architecture réseau

```
  VM1                        VM2                        VMn
  ┌────────────────┐         ┌────────────────┐         ┌────────────────┐
  │ eth0 (VDE)     │         │ eth0 (VDE)     │         │ eth0 (VDE)     │
  │ 192.168.100.10 │         │ 192.168.100.11 │         │ 192.168.100.1n │
  │ eth1 (NAT)     │         │ eth1 (NAT)     │         │ eth1 (NAT)     │
  │ 10.0.2.15      │         │ 10.0.2.15      │         │ 10.0.2.15      │
  └───────┬────────┘         └───────┬────────┘         └───────┬────────┘
          │ eth0                     │ eth0                     │ eth0
          └─────────────┬────────────────────────────────────────┘
                        │
                vde_switch (/tmp/vde/switch)
                        │
                  eth1  │  eth1                eth1
                        └──────────────────────────────► Internet
                                User NAT (10.0.2.2)
```

### Adresses réseau

| Adresse | Rôle |
|---------|------|
| `192.168.100.x` | IPs inter-VMs (eth0, VDE) |
| `10.0.2.2` | Gateway Internet (eth1, NAT) |
| `10.0.2.3` | DNS |
| `localhost:2222` | SSH VM1 depuis le host |
| `localhost:2223` | SSH VM2 depuis le host |

---

## Configuration automatique au boot (fw_cfg)

Le script passe trois fichiers à chaque VM via le mécanisme `fw_cfg` de QEMU :

| Fichier host | Rôle dans la VM |
|-------------|-----------------|
| `/tmp/setup-net.sh` | Configure eth0 (IP statique VDE) et eth1 (DHCP NAT) |
| `/tmp/vde/vmN-ip` | IP statique propre à chaque VM (ex: `192.168.100.10/24`) |
| `/tmp/setup-pkg.sh` | Installe les paquets Alpine listés dans `--pkg-list` |

Ces fichiers sont générés automatiquement par le script. `setup-net.sh` est conservé s'il existe déjà (pour permettre une configuration personnalisée).

---

## Capture réseau

Le trafic VDE circule en userspace et n'est pas visible par `tcpdump` ou Wireshark classiques. Deux méthodes sont disponibles :

### Mode HUB (simple)

```bash
# Lancer le lab en mode HUB
./setup-qemu-vde.sh --count 2 --hub alpine.qcow2

# Capturer dans un fichier
vdecapture /tmp/vde/switch capture.pcap &
wireshark capture.pcap
```

### Port mirroring (recommandé)

```bash
# 1. Lancer le lab normalement
./setup-qemu-vde.sh --count 2 alpine.qcow2

# 2. Activer le mirror
./setup-qemu-vde.sh --mirror

# 3. Suivre les instructions affichées par le script
#    sudo wireshark -k -i /tmp/vde/vde.pipe
```

Le port mirroring configure uniquement le port de `vdecapture` en mode hub — les VMs communiquent normalement en mode switch.

### Interface de management VDE

```bash
# Accéder au prompt de gestion du switch
unixterm /tmp/vde/mgmt

# Ou via socat
echo "port/print"     | socat - UNIX-CONNECT:/tmp/vde/mgmt
echo "port/sethub N 1"| socat - UNIX-CONNECT:/tmp/vde/mgmt
echo "hub/setall 1"   | socat - UNIX-CONNECT:/tmp/vde/mgmt
```

---

## Dépannage

| Symptôme | Cause | Fix |
|----------|-------|-----|
| Ping ne passe pas entre VMs | MACs identiques | MACs uniques auto-générées par le script |
| `eth0` sans IP au boot | `setup-net.start` absent | Reconfigurer Alpine (voir Préparer une VM) |
| Paquets non installés | `setup-pkg.start` absent ou pas de réseau | Vérifier eth1 avant apk |
| `vde` non compilé dans QEMU | QEMU système sans VDE | Recompiler QEMU avec `--enable-vde` |
| Wireshark ne voit rien | Mode SWITCH actif | Utiliser `--hub` ou `--mirror` |
| Port mirroring introuvable | vdecapture non connecté | Relancer `./setup-qemu-vde.sh --mirror` |
| VMs toujours actives après `--stop` | PIDs xterm ≠ PIDs QEMU | Le script kill aussi directement les processus QEMU |

---

## Fichiers générés lors du lancement

```
/tmp/vde/
├── switch/           ← socket VDE (ctl, ports)
├── mgmt              ← socket management
├── vmN-ip            ← IP de chaque VM
├── vmN-cmd.sh        ← commande QEMU par VM
├── vmN-disk.qcow2    ← disque overlay/copy par VM
├── vm_pids.txt       ← PIDs des xterms
├── vde.pipe          ← FIFO pour Wireshark (mode mirror)
├── vdecapture.log    ← logs vdecapture
└── mirror_err        ← logs erreurs mirror
```

---

## Licence

Usage libre — EFREI Paris, cours cybersécurité.

