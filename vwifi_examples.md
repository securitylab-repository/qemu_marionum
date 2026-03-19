# Examples of commands to test Wifi


> Les fichiers de configuration pour `hostapd` et `wpa_supplicant` sont disponibles dans le dossier `tests` du projet vwifi se trouvant dans `/home/debian` des vms.

## Test 1 : WPA

### Guests

* Guest Wifi 1 :

```bash
sudo ip a a 10.0.0.1/8 dev wlan0

sudo hostapd /home/debian/vwifi/tests/hostapd_wpa.conf
```

* Guest Wifi 2 :
```bash
sudo wpa_supplicant -Dnl80211 -iwlan0 -c tests/wpa_supplicant.conf

sudo ip a a 10.0.0.2/8 dev wlan0
ping 10.0.0.1
```

* Guest Wifi 3 :
```bash
sudo wpa_supplicant -Dnl80211 -iwlan0 -c /home/debian/vwifi/tests/wpa_supplicant.conf

sudo ip a a 10.0.0.3/8 dev wlan0
ping 10.0.0.2
```

* Capture de paquets sur la vm vwifi-server :
```bash
sudo tcpdump -n -i wlan0 -w vwifi_capture_wlan0.pcap
``` 

## Test 2 : Open

### Guests

* Guest Wifi 1 :

```bash
sudo ip a a 10.0.0.1/8 dev wlan0

sudo hostapd /home/vwifi/tests/hostapd_open.conf
```

* Guest Wifi 2 :
```bash
sudo ip link set up wlan0
sudo iw dev wlan0 connect mac80211_open

sudo ip a a 10.0.0.2/8 dev wlan0
ping 10.0.0.1
```

* Guest Wifi 3 :
```bash
sudo ip link set up wlan0
sudo tcpdump -n -e -I -i wlan0 -w vwifi_capture_wlan0.pcap
```

### Host

```bash
tail -f -c +0b vwifi_capture_wlan0.pcap | wireshark -k -i -
```

## Test 3 : Ad-Hoc

### Packages needed on the guests for this test

### Guests

* Guest Wifi 1 :
```bash
sudo ip link set up wlan0
sudo iw wlan0 set type ibss
sudo iw wlan0 ibss join MYNETWORK 2412 # frequency 2412 is channel 1

sudo ip a a 10.0.0.1/8 dev wlan0
```

* Guest Wifi 2 :
```bash
sudo ip link set up wlan0
sudo iw wlan0 set type ibss
sudo iw wlan0 ibss join MYNETWORK 2412 # frequency 2412 is channel 1

sudo ip a a 10.0.0.2/8 dev wlan0
ping 10.0.0.1
```

## Test 4 : WEP

### Packages needed on the guests for this test


### Guests

* Guest Wifi 1 :

```bash
sudo ip a a 10.0.0.1/8 dev wlan0

sudo hostapd /home/debian/vwifi/tests/hostapd_wep.conf
```

* Guest Wifi 2 :
```bash
cat << EOF | sudo tee -a /etc/network/interfaces > /dev/null

iface wlan0 inet static
    wireless-essid AP_WEP
    wireless-key s:12345
    address 10.0.0.2
    netmask 255.255.255.0

EOF
sudo ifup wlan0

ping 10.0.0.1
```

