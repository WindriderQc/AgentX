# Development VM

Coding agents work in a disposable Debian 12 VM, not on the owner's workstation
and not on production hosts. Inside the VM they run without permission prompts:
the VM holds no production secrets, and a hypervisor checkpoint restores it.

## Create

1. Debian 12 netinst, no desktop: select only "SSH server" and "standard system
   utilities". Hyper-V: generation 2, Secure Boot template "Microsoft UEFI
   Certificate Authority", fixed memory (16 GB), 8 vCPU, 120 GB disk.
2. Copy this directory to the VM and run `bash bootstrap.sh`. Re-running it is safe.
3. Follow the manual login steps it prints, then take a checkpoint.

## Boundaries

- Agents reach production only through `./agentx` and its runtime-deploy lease,
  never through raw `docker compose` on a production host.
- Credentials and agent logins stay in the VM. Do not copy `instance.env` or
  production keys into it.
- Inference runs on the LAN hosts through Core; the VM needs no GPU.
