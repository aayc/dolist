# Always-on machine on Azure

A step-by-step guide to an Azure Linux VM that runs Daily Do List's agent around the clock,
reachable only from your devices over Tailscale: no public IP, every inbound connection denied,
encryption at host. Its first boot ([cloud-init.yaml](./cloud-init.yaml)) joins your tailnet with
Tailscale SSH and installs Node.js; then the [Linux setup kit](../linux/README.md) installs the
daemon and the sync service. The design is in [docs/ALWAYS_ON.md](../../docs/ALWAYS_ON.md).

Daily Do List never manages Azure itself: you create, stop and delete the VM, here or in the
portal. Everything below uses placeholders (`<resource-group>`, `<vm-name>`, …); keep your real
names, keys and IDs out of any repository.

## What you need

- The [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli), signed in
  (`az login`) to the subscription to use.
- A Tailscale account (tailnet), with your laptop on it.
- An SSH public key for the VM's admin user. Azure requires one; you won't use it day to day,
  since administration goes over Tailscale SSH.
- A bundle built from this repository: `deploy/linux/build-bundle.sh --arch x64` writes
  `deploy/linux/build/ddl-linux-x64.tar.gz` (use `--arch arm64` for an Arm VM, below).

## 1. Prepare the tailnet

In the [Tailscale admin console](https://login.tailscale.com/admin):

1. **DNS:** turn on MagicDNS and HTTPS certificates. Note your tailnet name: the machine will be
   `<vm-name>.<tailnet-name>.ts.net` (in these guides, `vm-name.tailnet-name.ts.net`).
2. **Access controls:** define a tag for the machine, let your devices reach only its two HTTPS
   ports, and let you in over Tailscale SSH. Merge this into your policy file, replacing the
   default allow-all rule if you want the restriction to hold:

   ```jsonc
   {
     "tagOwners": {
       "tag:ddl": ["autogroup:admin"],
     },
     "acls": [
       // Your devices reach the daemon (443) and the sync service (8443) on the machine.
       { "action": "accept", "src": ["autogroup:member"], "dst": ["tag:ddl:443,8443"] },
       // Tailscale SSH for administrators.
       { "action": "accept", "src": ["autogroup:admin"], "dst": ["tag:ddl:22"] },
       // ...your other rules. Nothing lets tag:ddl open connections to your devices.
     ],
     "ssh": [
       // Re-authenticate in the browser every 12 hours; log in as the VM's admin user only.
       { "action": "check", "src": ["autogroup:admin"], "dst": ["tag:ddl"], "users": ["<admin-user>"] },
     ],
   }
   ```

3. **Keys → Generate auth key:** not reusable, not ephemeral, pre-approved (if device approval is
   on), tag `tag:ddl`, expiring in a day. Tagged machines don't expire, so the VM stays on the
   tailnet.

Save the key in a **local file outside any repository**, readable only by you, for example:

```sh
mkdir -p ~/.config/ddl-private && chmod 700 ~/.config/ddl-private
(umask 077 && "${EDITOR:-vi}" <tailscale-auth-key-file>)   # paste the key, save
```

Never commit this file, never paste the key into `cloud-init.yaml` in the repository, and delete
the file once the machine has joined.

## 2. Resource group and variables

```sh
RG=<resource-group>
LOCATION=<region>                 # e.g. westeurope; `az account list-locations -o table`
VM=<vm-name>                      # also the machine's name on the tailnet
ADMIN=<admin-user>                # the VM's admin user, as in the ssh rule above

az group create --name "$RG" --location "$LOCATION"
```

## 3. Encryption at host (once per subscription)

Encryption at host encrypts the VM's temporary disk and caches too, not only the managed disks.
It's a subscription feature to register once:

```sh
az feature register --namespace Microsoft.Compute --name EncryptionAtHost
az feature show --namespace Microsoft.Compute --name EncryptionAtHost --query properties.state -o tsv
# wait until it prints Registered (a few minutes), then:
az provider register --namespace Microsoft.Compute
```

## 4. Network: no inbound, outbound through a NAT gateway

The VM gets no public IP. A network security group on its subnet denies every inbound connection
(including from the rest of the virtual network), and a NAT gateway gives it outbound internet
access (updates, Tailscale, model APIs), which new Azure subnets don't have by default.

```sh
az network nsg create --resource-group "$RG" --name "$VM-nsg"
az network nsg rule create --resource-group "$RG" --nsg-name "$VM-nsg" --name deny-all-inbound \
  --priority 4096 --direction Inbound --access Deny --protocol '*' \
  --source-address-prefixes '*' --source-port-ranges '*' \
  --destination-address-prefixes '*' --destination-port-ranges '*'

az network public-ip create --resource-group "$RG" --name "$VM-nat-ip" \
  --sku Standard --allocation-method Static
az network nat gateway create --resource-group "$RG" --name "$VM-nat" \
  --public-ip-addresses "$VM-nat-ip"

az network vnet create --resource-group "$RG" --name "$VM-vnet" \
  --address-prefixes 10.20.0.0/24 --subnet-name default --subnet-prefixes 10.20.0.0/27
az network vnet subnet update --resource-group "$RG" --vnet-name "$VM-vnet" --name default \
  --network-security-group "$VM-nsg" --nat-gateway "$VM-nat"
```

The NAT gateway's public IP is outbound only: nothing can connect in through it. The security
group is stateful, so replies to the VM's own connections still arrive.

## 5. Create the VM

Fill the auth key into a temporary copy of `cloud-init.yaml` (created `0600`; `awk` reads the key
from its file, so it never appears in a command line), create the VM with it, and delete the copy:

```sh
CLOUD_INIT="$(mktemp)"
awk -v keyfile="<tailscale-auth-key-file>" \
  'BEGIN { getline key < keyfile } { sub(/<tailscale-auth-key>/, key) } 1' \
  deploy/azure/cloud-init.yaml >"$CLOUD_INIT"
grep -c '<tailscale-auth-key>' "$CLOUD_INIT"     # must print 0

az vm create --resource-group "$RG" --name "$VM" \
  --image Canonical:ubuntu-24_04-lts:server:latest \
  --size Standard_D2as_v5 \
  --vnet-name "$VM-vnet" --subnet default \
  --public-ip-address "" --nsg "" \
  --encryption-at-host true \
  --security-type TrustedLaunch --enable-secure-boot true --enable-vtpm true \
  --os-disk-size-gb 64 \
  --admin-username "$ADMIN" --ssh-key-values <ssh-public-key-file> \
  --custom-data "$CLOUD_INIT"

rm -f "$CLOUD_INIT"
```

- `Standard_D2as_v5` has 2 vCPUs and 8 GiB of memory, comfortable for Node, Chromium and the
  agent. Any 2 vCPU / 8 GiB size that supports encryption at host works; check one with
  `az vm list-skus --location "$LOCATION" --size <size> --query "[0].capabilities[?name=='EncryptionAtHostSupported'].value" -o tsv`.
- For an Arm VM (often cheaper), use `Standard_D2ps_v5` with
  `Canonical:ubuntu-24_04-lts:server-arm64:latest` and an `arm64` bundle.
- `--public-ip-address ""` and `--nsg ""` create the network interface without a public IP or
  its own security group; the subnet's group applies.

First boot takes a few minutes: updates, then Tailscale, then Node.js. The machine shows up in the
admin console, tagged `tag:ddl`. From your laptop:

```sh
tailscale status | grep "$VM"
tailscale ping "$VM"
```

## 6. Log in over Tailscale SSH

```sh
tailscale ssh "$ADMIN@$VM"          # or plain ssh, which Tailscale SSH answers on the tailnet
cloud-init status --wait            # on the VM: waits until the first boot is done
node --version                      # v24.x
```

The admin user has `sudo`. There is no other way in: no public IP, no open port.

## 7. Install Daily Do List

Copy the bundle over, then run the setup kit on the VM:

```sh
# on your laptop
scp deploy/linux/build/ddl-linux-x64.tar.gz deploy/linux/build/ddl-linux-x64.tar.gz.sha256 \
  "$ADMIN@$VM:"

# on the VM
sha256sum -c ddl-linux-x64.tar.gz.sha256
tar -xzf ddl-linux-x64.tar.gz
sudo ./ddl-linux-x64/deploy/setup.sh
```

`setup.sh` takes the machine's tailnet name from `tailscale status` as the daemon's remote host,
creates the sync vault, installs Chromium and starts the services; the
[Linux kit's README](../linux/README.md) details every step. Then follow the next steps it prints:

1. **Serve on the tailnet:**

   ```sh
   sudo tailscale serve --bg --https=443 http://127.0.0.1:7331
   sudo tailscale serve --bg --https=8443 http://127.0.0.1:7332
   ```

2. **Model credentials.** Install and sign in the Cursor CLI as the service user (the login prints
   a link to open on your laptop), then choose the Cursor harness in Settings:

   ```sh
   sudo -u ddl -H bash -c 'curl https://cursor.com/install -fsS | bash'
   sudo -u ddl -H env NO_OPEN_BROWSER=1 /var/lib/ddl/.local/bin/agent login
   ```

   Or, for the Pi harness, add `OPENROUTER_API_KEY=…` to `/etc/ddl/ddl.env` with `sudoedit` and
   `sudo systemctl restart ddl-daemon`. Add only the keys this machine needs; don't copy your
   laptop's whole `.env`.
3. **Connectors (`mcp.json`).** Review your laptop's `~/.daily-do-list/mcp.json` first: commands
   and paths must exist on the VM, and any tokens in it are secrets. Then:

   ```sh
   scp ~/.daily-do-list/mcp.json "$ADMIN@$VM:"                     # on your laptop
   sudo install -o ddl -g ddl -m 0600 mcp.json /var/lib/ddl/.daily-do-list/mcp.json && rm mcp.json
   sudo systemctl restart ddl-daemon                                # on the VM
   ```

4. **Pair your laptop.** On the VM, `sudo -u ddl -H node /opt/ddl/current/daemon/dist/main.js
   pair` prints a pairing code. In the laptop's app, Settings → Always-on machine takes
   `https://vm-name.tailnet-name.ts.net` and the code; Settings → Sync takes
   `https://vm-name.tailnet-name.ts.net:8443`, the vault id and the vault token
   (`sudo cat /var/lib/ddl/.daily-do-list/sync-token` on the VM). Then choose where the laptop's
   agent runs (Settings → Agent location).

The agent's browser on the VM starts signed in to nothing. Sign it in only to accounts made or set
aside for the agent, so that a mistake lands there and not on your own accounts.

## Cost

- The VM bills for compute while it's allocated. `az vm deallocate --resource-group "$RG" --name
  "$VM"` stops compute billing (`az vm stop` alone does not); `az vm start` brings it back with
  everything in place. While it's deallocated, its agent doesn't run: routines wait, and devices
  set to run the agent themselves keep doing so.
- The disk, the NAT gateway and its public IP bill whether the VM runs or not. The NAT gateway
  (hourly, plus data processed) can cost about as much as a small VM; check the
  [pricing calculator](https://azure.microsoft.com/pricing/calculator/) for your region.
- To remove everything, delete the resource group: `az group delete --name "$RG"`.

## Security checklist

- [ ] No public IP: `az vm list-ip-addresses --resource-group "$RG" --name "$VM" --query "[].virtualMachine.network.publicIpAddresses" -o tsv` prints nothing.
- [ ] Inbound denied: the subnet's group has `deny-all-inbound` at priority 4096, and the network
      interface has no group of its own.
- [ ] Encryption at host: `az vm show --resource-group "$RG" --name "$VM" --query securityProfile.encryptionAtHost` prints `true`.
- [ ] The auth key was single-use and short-lived, the rendered cloud-init copy is deleted, and the
      key file is gone from your laptop (it never was in a repository).
- [ ] Tailnet policy: only your devices reach `tag:ddl`, on 443 and 8443; SSH in check mode, as the
      admin user only; nothing allows `tag:ddl` to reach your devices.
- [ ] Secrets are `0600` and owned by `ddl`: `sudo ls -l /etc/ddl/ddl.env
      /var/lib/ddl/.daily-do-list`.
- [ ] The agent's browser is signed in to the agent's own accounts only.
- [ ] Updates: unattended upgrades (on by default in Ubuntu), Tailscale's auto-update (set by
      cloud-init), and a new bundle now and then.
- [ ] Your Azure and Tailscale accounts use multi-factor authentication.
- [ ] Backups exist and are encrypted: the vault, the sync database and the machine's settings
      (see the Linux kit's README), or disk snapshots (`az snapshot create --resource-group "$RG"
      --name <snapshot-name> --source <os-disk-id>`, the disk id from `az vm show --query
      storageProfile.osDisk.managedDisk.id -o tsv`).

## Troubleshooting

- **The machine never joins the tailnet.** Look at the first boot without network access to the
  VM, through the Azure agent:

  ```sh
  az vm run-command invoke --resource-group "$RG" --name "$VM" --command-id RunShellScript \
    --scripts "cloud-init status --long; tail -n 40 /var/log/cloud-init-output.log"
  ```

  Usual causes: the auth key expired, was already used, or waits for approval in the admin
  console; the placeholder wasn't replaced; or the VM has no outbound access (check that the
  subnet has the NAT gateway: `az network vnet subnet show --resource-group "$RG" --vnet-name
  "$VM-vnet" --name default --query natGateway.id`). Boot logs: `az vm boot-diagnostics enable`,
  then `az vm boot-diagnostics get-boot-log`, both with `--resource-group "$RG" --name "$VM"`. To
  retry with a new key, delete the VM (`az vm delete`) and create it again.
- **Tailscale SSH refuses you.** The policy needs the `ssh` rule and the port 22 rule for
  `tag:ddl`, with your admin user's name in `users`.
- **`tailscale serve` complains about HTTPS.** Turn on HTTPS certificates (admin console → DNS).
  The first request after that takes a few seconds while the certificate is issued.
- **The browser shows `forbidden_host`.** The daemon doesn't list the name you used in
  `remote.hosts`: check `sudo cat /var/lib/ddl/.daily-do-list/config.json`, and run `setup.sh`
  again with `--host vm-name.tailnet-name.ts.net`.
- **A service doesn't start.** `journalctl -u ddl-daemon -n 50` (or `-u ddl-sync`). Configuration
  errors name the file and the key.
- **Everything is slow from one device.** `tailscale ping <vm-name>` may say `via DERP`: behind a
  NAT gateway with inbound denied, Tailscale can fall back to its relays. It works, with more
  latency.
- **The agent's browser fails to launch.** Run `setup.sh` again (without `--skip-browser`) to
  reinstall Chromium and its libraries, then look for `browser` in `journalctl -u ddl-daemon`.
- **Memory pressure.** `free -h`; resize to a 16 GiB size (`az vm resize`) if Chromium and the
  agent need more.
