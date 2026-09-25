import {
  type AlwaysOnMachine,
  defaultMachineName,
  type MachineStatusResponse,
  normalizePairingCode,
} from "@ddl/core";
import { ExternalLink, Server } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { useServices } from "../../../app/services";
import { useAgentStore } from "../../../state/agent-store";
import { loadDevice, useDeviceStore } from "../device-store";
import { deviceNameProblem, machineUrlFromInput, machineUrlProblem } from "../inputs";
import { PairingCodeInput } from "../PairingCodeInput";
import { codeProblem } from "../pairing-code";
import { remoteErrorMessage } from "../remote-errors";
import { timeAgo } from "../time";
import {
  type GoToSection,
  InlineError,
  Readiness,
  StateChip,
  useConfirm,
  useNow,
  usePoll,
} from "./parts";

/** While the section is open, the machine's last known status is read this often. */
const POLL_MS = 10_000;

/** Settings → Always-on machine: its address, pairing this device with it, and its status. */
export function MachineSection({ go }: { go: GoToSection }) {
  const { client } = useServices();
  const [status, setStatus] = useState<MachineStatusResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const host = useAgentStore((s) => s.status?.placement?.placement === "always_on_host");
  const load = useCallback(() => {
    client.getMachine().then(
      (next) => {
        setStatus(next);
        setLoadError(null);
      },
      (error: unknown) => setLoadError(remoteErrorMessage(error, "load")),
    );
  }, [client]);
  usePoll(load, POLL_MS, !host);
  useEffect(() => {
    void loadDevice(client);
  }, [client]);

  return (
    <section data-testid="settings-machine">
      <h2 className="settings-heading">Always-on machine</h2>
      <p className="settings-hint">
        A machine that stays on, such as a small cloud VM on your private network, runs the agent
        while your devices sleep. Every device of the vault knows its name and address; each pairs
        with it once.
      </p>
      {host ? (
        <div className="setting setting-stacked" data-testid="machine-is-host">
          <div className="setting-info">
            <div className="setting-name">This is the always-on machine</div>
            <div className="setting-description">
              Other devices pair with it using a code from Devices, then choose to run their agent
              here in their Agent location.
            </div>
          </div>
          <div className="remote-actions">
            <button type="button" className="button" onClick={() => go("devices")}>
              Pair a new device
            </button>
          </div>
        </div>
      ) : loadError ? (
        <InlineError message={loadError} testId="machine-load-error" />
      ) : !status ? (
        <div className="thread-loading" aria-busy="true" />
      ) : status.machine && status.paired ? (
        <MachineStatus status={status} onChange={setStatus} />
      ) : (
        <>
          {status.machine ? (
            <p className="settings-hint" data-testid="machine-not-paired">
              <strong>{status.machine.name}</strong> is this vault&apos;s always-on machine, set up
              on another device. Pair this device with it to use its agent from here.
            </p>
          ) : null}
          <PairForm machine={status.machine} onPaired={setStatus} />
        </>
      )}
    </section>
  );
}

function PairForm({
  machine,
  onPaired,
}: {
  machine: AlwaysOnMachine | null;
  onPaired(status: MachineStatusResponse): void;
}) {
  const { client } = useServices();
  const [url, setUrl] = useState(machine?.url ?? "");
  const [code, setCode] = useState("");
  // Pairing with the vault's machine again keeps the name every device knows it by.
  const [name, setName] = useState(machine?.name ?? "");
  const [shown, setShown] = useState({ url: false, code: false });
  const [pairing, setPairing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = useId();
  const normalized = machineUrlFromInput(url);
  const problems = {
    url: machineUrlProblem(url),
    code: codeProblem(code),
    name: name.trim() ? deviceNameProblem(name) : null,
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setShown({ url: true, code: true });
    const pairingCode = normalizePairingCode(code);
    if (!normalized || !pairingCode || problems.name) return;
    setPairing(true);
    setError(null);
    try {
      onPaired(
        await client.pairMachine({
          url: normalized,
          code: pairingCode,
          ...(name.trim() ? { name: name.trim() } : {}),
        }),
      );
    } catch (e) {
      setError(remoteErrorMessage(e, "machinePair"));
    } finally {
      setPairing(false);
    }
  };

  return (
    <form className="remote-form" onSubmit={submit} noValidate data-testid="machine-pair-form">
      <div className="remote-field">
        <label className="remote-field-label" htmlFor={`${ids}-url`}>
          Address
        </label>
        <input
          id={`${ids}-url`}
          className="input"
          type="url"
          value={url}
          placeholder="https://vm-name.tailnet-name.ts.net"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={shown.url && problems.url !== null}
          aria-describedby={`${ids}-url-note`}
          data-testid="machine-url"
          onChange={(event) => setUrl(event.target.value)}
          onBlur={() => url.trim() && setShown((s) => ({ ...s, url: true }))}
        />
        {shown.url && problems.url ? (
          <span
            className="remote-field-error"
            id={`${ids}-url-note`}
            data-testid="machine-url-problem"
          >
            {problems.url}
          </span>
        ) : (
          <span className="remote-field-hint" id={`${ids}-url-note`}>
            Its name on your private network, such as its Tailscale name.
          </span>
        )}
      </div>
      <div className="remote-field">
        <label className="remote-field-label" htmlFor={`${ids}-code`}>
          Pairing code
        </label>
        <PairingCodeInput
          id={`${ids}-code`}
          value={code}
          onValue={setCode}
          aria-invalid={shown.code && problems.code !== null}
          aria-describedby={`${ids}-code-note`}
          data-testid="machine-code"
        />
        {shown.code && problems.code ? (
          <span
            className="remote-field-error"
            id={`${ids}-code-note`}
            data-testid="machine-code-problem"
          >
            {problems.code}
          </span>
        ) : (
          <span className="remote-field-hint" id={`${ids}-code-note`}>
            Get one on the machine: run the daemon&apos;s <code>pair</code> command there, or open
            its web app on a device already paired with it and choose Devices → Pair a new device.
          </span>
        )}
      </div>
      <div className="remote-field">
        <label className="remote-field-label" htmlFor={`${ids}-name`}>
          Name <span className="muted">(optional)</span>
        </label>
        <input
          id={`${ids}-name`}
          className="input"
          value={name}
          placeholder={normalized ? defaultMachineName(normalized) : "vm-name"}
          spellCheck={false}
          aria-invalid={problems.name !== null}
          data-testid="machine-name"
          onChange={(event) => setName(event.target.value)}
        />
        {problems.name ? <span className="remote-field-error">{problems.name}</span> : null}
      </div>
      <InlineError message={error} testId="machine-pair-error" />
      <div className="remote-actions">
        <button
          type="submit"
          className="button is-primary"
          disabled={pairing}
          data-testid="machine-pair"
        >
          {pairing ? "Pairing…" : "Pair"}
        </button>
      </div>
    </form>
  );
}

function MachineStatus({
  status,
  onChange,
}: {
  status: MachineStatusResponse;
  onChange(status: MachineStatusResponse): void;
}) {
  const { client } = useServices();
  const thisDevice = useDeviceStore((s) => s.device?.device.id);
  const [busy, setBusy] = useState<"check" | "forget" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const [confirm, dialog] = useConfirm();
  const now = useNow(15_000);
  const machine = status.machine as AlwaysOnMachine;

  const run = async (action: "check" | "forget") => {
    setBusy(action);
    setError(null);
    try {
      onChange(await (action === "check" ? client.checkMachine() : client.forgetMachine()));
    } catch (e) {
      setError(remoteErrorMessage(e, action === "check" ? "machineCheck" : "machineForget"));
    } finally {
      setBusy(null);
    }
  };

  const runsOn = status.agent?.runsOn;
  const agentText = !status.agent
    ? "—"
    : !runsOn
      ? "Not running right now"
      : runsOn.thisDevice
        ? `Running on ${machine.name}`
        : runsOn.deviceId === thisDevice
          ? "Running on this device"
          : `Running on ${runsOn.name}`;

  return (
    <div data-testid="machine-status">
      <div className="machine-card">
        <div className="machine-card-head">
          <Server size={16} aria-hidden="true" />
          <span className="machine-name" data-testid="machine-status-name">
            {machine.name}
          </span>
          <code className="machine-url">{machine.url}</code>
          <a
            className="button"
            href={machine.url}
            target="_blank"
            rel="noopener noreferrer"
            data-tooltip={`Open ${machine.url} in a new tab`}
            data-testid="machine-open"
          >
            Open its web app
            <ExternalLink size={13} aria-hidden="true" />
          </a>
        </div>
        <dl className="about-list">
          <div className="about-row">
            <dt>Status</dt>
            <dd>
              {status.reachable === null ? (
                <StateChip tone="faint" state="unchecked" testId="machine-reachable">
                  Not checked yet
                </StateChip>
              ) : status.reachable ? (
                <StateChip tone="success" state="reachable" testId="machine-reachable">
                  Reachable
                </StateChip>
              ) : (
                <StateChip tone="danger" state="unreachable" testId="machine-reachable">
                  Can&apos;t be reached
                </StateChip>
              )}
              {status.checkedAt !== null ? (
                <span className="muted"> · checked {timeAgo(status.checkedAt, now)}</span>
              ) : null}
              {status.error ? (
                <div className="settings-error" data-testid="machine-error">
                  {status.error}
                </div>
              ) : null}
            </dd>
          </div>
          <div className="about-row">
            <dt>Version</dt>
            <dd data-testid="machine-version">{status.version ?? "—"}</dd>
          </div>
          <div className="about-row">
            <dt>Its agent</dt>
            <dd data-testid="machine-agent">
              {agentText}
              {status.agent?.problem ? <div className="muted">{status.agent.problem}</div> : null}
            </dd>
          </div>
        </dl>
      </div>
      <h3 className="settings-subheading">Its readiness</h3>
      {status.readiness ? (
        <Readiness readiness={status.readiness} where="machine" testId="readiness-machine" />
      ) : (
        <p className="muted">Known once the machine answers.</p>
      )}
      <InlineError message={error} testId="machine-action-error" />
      {pairing ? (
        <>
          <h3 className="settings-subheading">Pair again</h3>
          <PairForm
            machine={machine}
            onPaired={(next) => {
              setPairing(false);
              onChange(next);
            }}
          />
        </>
      ) : null}
      <div className="remote-actions machine-actions">
        <button
          type="button"
          className="button"
          disabled={busy !== null}
          onClick={() => void run("check")}
          data-testid="machine-check"
        >
          {busy === "check" ? "Checking…" : "Check now"}
        </button>
        {pairing ? null : (
          <button
            type="button"
            className="button"
            disabled={busy !== null}
            onClick={() => setPairing(true)}
            data-tooltip="Pair with a new code, for when the machine no longer accepts this device"
            data-testid="machine-pair-again"
          >
            Pair again…
          </button>
        )}
        <button
          type="button"
          className="button is-danger-ghost"
          disabled={busy !== null}
          data-testid="machine-forget"
          onClick={() =>
            confirm({
              title: `Forget ${machine.name} on this device?`,
              message: `This device's credential for ${machine.name} is deleted, and revoked on the machine if it answers. It stays the vault's always-on machine: pair again with a new code to use it from here.`,
              confirmLabel: "Forget",
              danger: true,
              onConfirm: () => void run("forget"),
            })
          }
        >
          Forget…
        </button>
      </div>
      {dialog}
    </div>
  );
}
