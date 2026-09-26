# Always-on machine on Azure

A step-by-step guide to an Azure Linux VM that runs Daily Do List's agent around the clock,
reachable only from your devices over Tailscale: a public IP for its outbound traffic only, every
inbound port closed (SSH included), administration over Tailscale SSH, encryption at host. Its
first boot ([cloud-init.yaml](./cloud-init.yaml)) joins your tailnet with Tailscale SSH and
installs Node.js; then the [Linux setup kit](../linux/README.md) installs the daemon and the sync
service. The design is in [docs/ALWAYS_ON.md](../../docs/ALWAYS_ON.md). An option replaces the
public IP with a NAT gateway, so the VM has no public address at all (see [Cost](#cost)).

Daily Do List never manages Azure itself: you create, stop and delete the VM, here or in the
portal. Everything below uses placeholders (`<resource-group>`, `<vm-name>`, …); keep your real
names, keys and IDs out of any repository.

## What you need

- The [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli), signed in
  (`az login`) to the subscription to use.
- A Tailscale account (tailnet), with your laptop on it.
- An SSH public key for the VM's admin user. Azure requires one, but you won't use it:
  administration goes over Tailscale SSH, and the first boot turns the OpenSSH server off.
- A bundle built from this repository for the VM's CPU. The recommended size is Arm64:
  `deploy/linux/build-bundle.sh --arch arm64` writes `deploy/linux/build/ddl-linux-arm64.tar.gz`
  (`--arch x64` for the x86 sizes). `setup.sh` refuses a bundle for the other CPU.

## Choosing a size

| Size | CPU | vCPUs, memory | VM, a month | With disk and IP |
| --- | --- | --- | --- | --- |
| **`Standard_D4ps_v6`** (recommended) | Azure Cobalt 100, **Arm64** | 4, 16 GiB | about $102 | about $116 |
| `Standard_B4as_v2` | AMD, x86, burstable | 4, 16 GiB | about $110 | about $124 |
| `Standard_D2as_v5` | AMD, x86 | 2, 8 GiB | about $63 | about $77 |

Prices are approximate, running around the clock; "with disk and IP" adds the OS disk and the
static public IP (details in [Cost](#cost)).

Four vCPUs and 16 GiB leave room for Node, Chromium and the agent's tools at once; 2 vCPUs and
8 GiB work for lighter use. Sizes aren't offered in every region or to every subscription, so
check before creating the VM (step 5):

```sh
az vm list-skus --location <region> --size Standard_D4ps_v6 --output table
az vm list-skus --location <region> --size Standard_D4ps_v6 --output tsv --query \
  "[0].capabilities[?name=='EncryptionAtHostSupported' || name=='DiskControllerTypes' ||
    name=='HyperVGenerations' || name=='CpuArchitectureType'].[name, value]"
```

The first command lists the size with any restrictions in the region (`NotAvailableForSubscription`
means pick another region or ask for access). The second should show `EncryptionAtHostSupported
True`, `DiskControllerTypes` with `NVMe`, `HyperVGenerations V2` and `CpuArchitectureType Arm64`.
New subscriptions may also have no vCPU quota for the family yet: `az vm list-usage --location
<region> --output table` shows it, and Quotas in the portal raises it.

What the Dpsv6 sizes need, from Microsoft's documentation:

- **Generation 2 and Arm64.** The series runs Generation 2 VMs only, on Arm64
  ([Dpsv6 series](https://learn.microsoft.com/azure/virtual-machines/sizes/general-purpose/dpsv6-series)):
  use Canonical's Gen2 Arm64 image of Ubuntu 24.04, `Canonical:ubuntu-24_04-lts:server-arm64:latest`
  ([Ubuntu images on Azure](https://documentation.ubuntu.com/azure/azure-how-to/instances/find-ubuntu-images/)),
  and the kit's `arm64` bundle.
- **NVMe disks.** v6 sizes attach disks over NVMe rather than SCSI, which takes a Generation 2 image
  tagged for NVMe and the NVMe disk controller
  ([NVMe overview](https://learn.microsoft.com/azure/virtual-machines/nvme-overview)). Ubuntu 24.04
  is on the list of supported images
  ([supported OS images](https://learn.microsoft.com/azure/virtual-machines/enable-nvme-interface)),
  and `az vm create --disk-controller-type NVMe` selects the controller. The OS disk shows up as
  `/dev/nvme0n1`; nothing in the kit depends on disk names.
- **Trusted Launch** (Secure Boot, vTPM) is supported on Cobalt 100 sizes with Arm64 Marketplace
  images ([Trusted Launch](https://learn.microsoft.com/azure/virtual-machines/trusted-launch)).
- **No local temporary disk**, and accelerated networking is always on; the kit uses neither a
  temporary disk nor anything network-specific.

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
LOCATION=<region>                 # e.g. westus3; `az account list-locations -o table`
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

## 4. Network: every inbound port closed

A network security group on the VM's subnet denies every inbound connection, from the internet
and from the rest of the virtual network, with no exception for SSH. The VM reaches the internet
(updates, Tailscale, model APIs) through a static public IP of its own:

```sh
az network nsg create --resource-group "$RG" --name "$VM-nsg"
az network nsg rule create --resource-group "$RG" --nsg-name "$VM-nsg" --name deny-all-inbound \
  --priority 4096 --direction Inbound --access Deny --protocol '*' \
  --source-address-prefixes '*' --source-port-ranges '*' \
  --destination-address-prefixes '*' --destination-port-ranges '*'

az network vnet create --resource-group "$RG" --name "$VM-vnet" \
  --address-prefixes 10.20.0.0/24 --subnet-name default --subnet-prefixes 10.20.0.0/27
az network vnet subnet update --resource-group "$RG" --vnet-name "$VM-vnet" --name default \
  --network-security-group "$VM-nsg"

az network public-ip create --resource-group "$RG" --name "$VM-ip" \
  --sku Standard --allocation-method Static
```

Nothing can connect in through the public IP: a Standard public IP accepts inbound traffic only
where a security group allows it, and this group allows nothing. Tailscale needs no open port: the
VM starts its connections, the security group is stateful, so replies arrive, and Tailscale's NAT
traversal usually connects your devices to the VM directly.

### Option: no public IP, outbound through a NAT gateway

For a VM without any public address, give the subnet a NAT gateway for outbound traffic instead
(new Azure subnets have no outbound access by default), and create the VM with
`--public-ip-address ""` in step 5 instead of `"$VM-ip"`:

```sh
az network public-ip create --resource-group "$RG" --name "$VM-nat-ip" \
  --sku Standard --allocation-method Static
az network nat gateway create --resource-group "$RG" --name "$VM-nat" \
  --public-ip-addresses "$VM-nat-ip"
az network vnet subnet update --resource-group "$RG" --vnet-name "$VM-vnet" --name default \
  --nat-gateway "$VM-nat"
```

The NAT gateway costs about $33 a month plus about $0.045 per GB processed, on top of its own
public IP (about $4), and bills even while the VM is deallocated (approximate retail at the time of
writing). Behind it, Tailscale falls back to its relays (DERP) more often, which adds latency.

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
  --image Canonical:ubuntu-24_04-lts:server-arm64:latest \
  --size Standard_D4ps_v6 \
  --disk-controller-type NVMe \
  --vnet-name "$VM-vnet" --subnet default \
  --public-ip-address "$VM-ip" --nsg "" \
  --encryption-at-host true \
  --security-type TrustedLaunch --enable-secure-boot true --enable-vtpm true \
  --os-disk-size-gb 64 --storage-sku Premium_LRS \
  --admin-username "$ADMIN" --ssh-key-values <ssh-public-key-file> \
  --custom-data "$CLOUD_INIT"

rm -f "$CLOUD_INIT"
```

- `--public-ip-address "$VM-ip"` attaches the static IP from step 4 (`""` in the NAT gateway
  option). `--nsg ""` matters: without it, `az vm create` adds a security group to the network
  interface that opens SSH (port 22) to the internet. The subnet's group applies instead.
- `--disk-controller-type NVMe` is for the v6 sizes (see [Choosing a size](#choosing-a-size)). If
  `az` reports that the image isn't supported for NVMe, check that the image is the Gen2 Arm64
  one above.
- For an x86 size, use `Canonical:ubuntu-24_04-lts:server:latest`, `--size Standard_B4as_v2` (or
  `Standard_D2as_v5`), leave out `--disk-controller-type NVMe` unless the size's
  `DiskControllerTypes` lists NVMe (the v5 sizes attach disks over SCSI), and build the `x64`
  bundle.

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

The admin user has `sudo`. There is no other way in over the network: the security group closes
every port of the public IP, and the first boot turns off the OpenSSH server, since Tailscale SSH
doesn't need it. Without the tailnet, `az vm run-command invoke` still runs commands on the VM
through the Azure agent (see Troubleshooting).

## 7. Install Daily Do List

Copy the bundle for the VM's CPU over (`arm64` for `Standard_D4ps_v6`, `x64` for the x86
sizes), then run the setup kit on the VM:

```sh
# on your laptop
scp deploy/linux/build/ddl-linux-arm64.tar.gz deploy/linux/build/ddl-linux-arm64.tar.gz.sha256 \
  "$ADMIN@$VM:"

# on the VM
sha256sum -c ddl-linux-arm64.tar.gz.sha256
tar -xzf ddl-linux-arm64.tar.gz
sudo ./ddl-linux-arm64/deploy/setup.sh
```

`setup.sh` takes the machine's tailnet name from `tailscale status` as the daemon's remote host,
creates the sync vault, installs Chromium and starts the services, then prints the next steps with
your names filled in: serve both on the tailnet, give the agent a model (the Cursor CLI signed in
as the service user, or an OpenRouter key), install your connectors (`scp
~/.daily-do-list/mcp.json "$ADMIN@$VM:"` first) and pair your laptop. The
[Linux kit's README](../linux/README.md#next-steps) has them with every command.

## Cost

Approximate pay-as-you-go retail at the time of writing (September 2026), Linux, West US 2, West
US 3 and East US; check the [pricing calculator](https://azure.microsoft.com/pricing/calculator/)
for your region:

| Item | A month | Billed |
| --- | --- | --- |
| `Standard_D4ps_v6` (about $0.140 an hour) | about $102 | while allocated |
| OS disk, 64 GiB Premium SSD | about $10 | always |
| Static Standard public IP | about $4 | always |
| **Total, around the clock** | **about $116** | |
| NAT gateway option: the gateway, plus about $0.045 per GB processed, instead of the VM's IP | about $33 more | always, even deallocated |

- `az vm deallocate --resource-group "$RG" --name "$VM"` stops compute billing (`az vm stop` alone
  does not); `az vm start` brings the VM back with everything in place. The disk and the public IP
  (and the NAT gateway, in that option) keep billing. While the VM is deallocated, its agent
  doesn't run: routines wait, and devices set to run the agent themselves keep doing so.
- For the x86 4-vCPU sizes, a 1-year savings plan lowers the compute price; it's a commitment that
  bills whether the VM runs or not. See [Choosing a size](#choosing-a-size) for the alternatives.
- To remove everything, delete the resource group: `az group delete --name "$RG"`.

## Security checklist

- [ ] Inbound denied: `az network nsg rule list --resource-group "$RG" --nsg-name "$VM-nsg"
      --output table` shows `deny-all-inbound` at priority 4096 and no rule that allows anything
      (no SSH), and the network interface has no group of its own: `az network nic show --ids
      "$(az vm show --resource-group "$RG" --name "$VM" --query
      'networkProfile.networkInterfaces[0].id' -o tsv)" --query networkSecurityGroup` prints
      nothing.
- [ ] Nothing answers on the public IP. From your laptop: `nc -z -w 5 "$(az network public-ip
      show --resource-group "$RG" --name "$VM-ip" --query ipAddress -o tsv)" 22 && echo OPEN ||
      echo closed` prints `closed` (try 443 and 8443 too). In the NAT gateway option, the VM has
      no public IP at all: `az vm list-ip-addresses --resource-group "$RG" --name "$VM" --query
      "[].virtualMachine.network.publicIpAddresses" -o tsv` prints nothing.
- [ ] The OpenSSH server is off on the VM (cloud-init turns it off; Tailscale SSH doesn't use it):
      `systemctl is-enabled ssh.socket ssh.service` prints `disabled` twice.
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
  console; the placeholder wasn't replaced; or the VM has no outbound access (check that it has
  its public IP, `az vm list-ip-addresses --resource-group "$RG" --name "$VM" --output table`,
  or in the NAT gateway option that the subnet has the gateway: `az network vnet subnet show
  --resource-group "$RG" --vnet-name "$VM-vnet" --name default --query natGateway.id`). Boot
  logs: `az vm boot-diagnostics enable`, then `az vm boot-diagnostics get-boot-log`, both with
  `--resource-group "$RG" --name "$VM"`. To retry with a new key, delete the VM (`az vm delete`)
  and create it again.
- **`az vm create` fails.** `SkuNotAvailable` or a quota error: check the size in another region
  or raise the family's vCPU quota ([Choosing a size](#choosing-a-size)). "The selected image is
  not supported for NVMe": use the Gen2 Arm64 image for `Standard_D4ps_v6`, or leave out
  `--disk-controller-type NVMe` for a size that attaches disks over SCSI. An architecture error
  means the image and the size disagree (Arm64 image for Dpsv6, x64 image for the x86 sizes).
- **Tailscale SSH refuses you.** The policy needs the `ssh` rule and the port 22 rule for
  `tag:ddl`, with your admin user's name in `users`. Meanwhile `az vm run-command invoke` (above)
  runs commands on the VM without the network, for example `sudo systemctl enable --now ssh` if
  you ever need the OpenSSH server over the tailnet.
- **`tailscale serve` complains about HTTPS.** Turn on HTTPS certificates (admin console → DNS).
  The first request after that takes a few seconds while the certificate is issued.
- **`forbidden_host`, a service that doesn't start, Chromium that won't download:** see the
  [Linux kit's troubleshooting](../linux/README.md#troubleshooting).
- **Everything is slow from one device.** `tailscale ping <vm-name>` may say `via DERP`: when a
  direct connection can't be set up (more often behind a NAT gateway, or a strict network on
  the device's side), Tailscale falls back to its relays. It works, with more latency.
- **The agent's browser fails to launch.** Run `setup.sh` again (without `--skip-browser`) to
  reinstall Chromium and its libraries, then look for `browser` in `journalctl -u ddl-daemon`.
- **Memory pressure.** `free -h`; resize to a larger size of the same CPU architecture
  (`az vm resize`, for example `Standard_D8ps_v6` with 32 GiB) if Chromium and the agent need
  more.
