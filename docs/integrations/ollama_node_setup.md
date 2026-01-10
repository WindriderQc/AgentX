# SBQC Ollama Node Setup (TrueNAS Datalake + Headless GPU)

This document describes how to turn a Linux GPU host into a stateless SBQC
Ollama inference node using a shared TrueNAS SMB datalake.

Target design:
- Compute: NVIDIA GPU (headless)
- Models: TrueNAS SMB share
- Access: LAN via Ollama API
- No GUI, no Wayland, no VRAM waste

---

## 1) Install Ollama

```bash
curl -fsSL https://ollama.com/install.sh | sh
systemctl status ollama
2) Install SMB client
bash
Copier le code
sudo apt install -y cifs-utils
3) Mount the TrueNAS share
Create mount point:

bash
Copier le code
sudo mkdir -p /mnt/datalake
Create credentials file:

bash
Copier le code
sudo nano /root/.smbcredentials
ini
Copier le code
username=TRUENAS_USER
password=TRUENAS_PASSWORD
bash
Copier le code
sudo chmod 600 /root/.smbcredentials
Mount manually to test:

bash
Copier le code
sudo mount -t cifs //192.168.2.31/LLMs /mnt/datalake \
  -o credentials=/root/.smbcredentials,iocharset=utf8,vers=3.1.1,nofail
Verify:

bash
Copier le code
ls /mnt/datalake
4) Make the mount persistent
bash
Copier le code
sudo nano /etc/fstab
Add:

bash
Copier le code
//192.168.2.31/LLMs  /mnt/datalake  cifs  credentials=/root/.smbcredentials,iocharset=utf8,vers=3.1.1,nofail,_netdev  0  0
Test:

bash
Copier le code
sudo umount /mnt/datalake
sudo mount -a
5) Point Ollama at the datalake
Create systemd override:

bash
Copier le code
sudo mkdir -p /etc/systemd/system/ollama.service.d
sudo nano /etc/systemd/system/ollama.service.d/override.conf
ini
Copier le code
[Service]
Environment="OLLAMA_MODELS=/mnt/datalake"
Environment="OLLAMA_HOST=0.0.0.0:11434"
Apply:

bash
Copier le code
sudo systemctl daemon-reload
sudo systemctl restart ollama
Verify:

bash
Copier le code
ss -tulpen | grep 11434
ollama list
6) Open firewall (if enabled)
bash
Copier le code
sudo ufw allow 11434/tcp
7) Verify from another host
bash
Copier le code
curl http://HOSTNAME.local:11434/api/version
curl http://HOSTNAME.local:11434/api/tags
8) Make the node headless (optional but recommended)
bash
Copier le code
sudo systemctl set-default multi-user.target
sudo systemctl disable gdm3
sudo reboot
After reboot:

bash
Copier le code
nvidia-smi
The GPU should show 0 MiB used when idle.

Architecture Result
Node has no state

Models live on TrueNAS

GPU is 100% compute

Ollama is reachable via LAN

Safe for AgentX / n8n / multi-node orchestration

This is the SBQC inference fabric baseline.

yaml
Copier le code

---

If you want, next we can convert this into:
- a bash bootstrap script
- or an Ansible playbook
- or an n8n provisioning flow

You’ve basically just built your first **AI compute node template**.