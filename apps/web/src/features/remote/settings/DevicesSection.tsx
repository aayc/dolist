import {
  formatPairingCode,
  type PairedDevice,
  type PairedDeviceKind,
  type PairingCodeResponse,
} from "@ddl/core";
import { AppWindow, Globe, Server } from "lucide-react";
import { type FormEvent, useCallback, useId, useRef, useState } from "react";
import { useServices } from "../../../app/services";
import { cx } from "../../../lib/cx";
import { deviceNameProblem } from "../inputs";
import { remoteErrorMessage } from "../remote-errors";
import { countdown, timeAgo } from "../time";
import { CopyValue, type GoToSection, InlineError, useConfirm, useNow, usePoll } from "./parts";

/** Paired devices are read this often while a code waits to be used, else now and then. */
const POLL_WAITING_MS = 2_000;
const POLL_MS = 30_000;

const KINDS: Record<PairedDeviceKind, { label: string; icon: typeof Globe }> = {
  browser: { label: "Browser", icon: Globe },
  app: { label: "App", icon: AppWindow },
  daemon: { label: "Daemon", icon: Server },
};

/** Settings → Devices: the devices paired with this daemon, revoking them, and pairing one more. */
export function DevicesSection({ go }: { go: GoToSection }) {
  const { client } = useServices();
  const [devices, setDevices] = useState<PairedDevice[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [code, setCode] = useState<PairingCodeResponse | null>(null);
  const [paired, setPaired] = useState<PairedDevice | null>(null);
  /** The devices there were when the code was issued: a new one means it was used. */
  const before = useRef<ReadonlySet<string> | null>(null);

  const load = useCallback(() => {
    client.listDevices().then(
      ({ devices: list }) => {
        setDevices(list);
        setLoadError(null);
        const known = before.current;
        const added = known ? list.find((device) => !known.has(device.id)) : undefined;
        if (added) {
          before.current = null;
          setCode(null);
          setPaired(added);
        }
      },
      (error: unknown) => setLoadError(remoteErrorMessage(error, "load")),
    );
  }, [client]);
  usePoll(load, code ? POLL_WAITING_MS : POLL_MS);

  const issued = (next: PairingCodeResponse) => {
    before.current = new Set((devices ?? []).map((device) => device.id));
    setPaired(null);
    setCode(next);
  };

  return (
    <section data-testid="settings-devices">
      <h2 className="settings-heading">Devices</h2>
      <p className="settings-hint">
        Devices that can use this daemon besides this computer: browsers, apps, and other
        devices&apos; daemons that hand it their agent. Revoking one cuts it off at once.
      </p>
      {loadError ? <InlineError message={loadError} testId="devices-load-error" /> : null}
      {!devices && !loadError ? <div className="thread-loading" aria-busy="true" /> : null}
      {devices?.length === 0 ? (
        <p className="muted" data-testid="devices-empty">
          No devices are paired with this daemon yet.
        </p>
      ) : null}
      {devices && devices.length > 0 ? (
        <ul className="device-list" data-testid="device-list">
          {devices.map((device) => (
            <DeviceRow key={device.id} device={device} onRevoked={load} />
          ))}
        </ul>
      ) : null}
      <h3 className="settings-subheading">Pair a new device</h3>
      <p className="settings-hint">
        A code lets one more device in: open this daemon&apos;s address on it and enter the code, or
        for a daemon, enter it in that device&apos;s Settings → Always-on machine. A code works
        once, for 5 minutes.
      </p>
      {paired ? (
        <p className="settings-success" role="status" data-testid="device-paired">
          Paired: {paired.name}.
        </p>
      ) : null}
      {code ? (
        <CodePanel code={code} go={go} onNew={issued} onDone={() => setCode(null)} />
      ) : (
        <NewCodeForm onIssued={issued} />
      )}
    </section>
  );
}

function DeviceRow({ device, onRevoked }: { device: PairedDevice; onRevoked(): void }) {
  const { client } = useServices();
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, dialog] = useConfirm();
  const now = useNow(30_000);
  const kind = KINDS[device.kind] ?? KINDS.app;
  const Icon = kind.icon;
  const revoke = async () => {
    setRevoking(true);
    setError(null);
    try {
      await client.revokeDevice(device.id);
      onRevoked();
    } catch (e) {
      setError(remoteErrorMessage(e, "revoke"));
      setRevoking(false);
    }
  };
  return (
    <li className="device-row" data-testid="device-row" data-device-id={device.id}>
      <Icon size={16} aria-hidden="true" />
      <span className="device-text">
        <span className="device-name">
          <span data-testid="device-name">{device.name}</span>
          {device.current ? (
            <span className="chip" data-testid="device-current">
              This device
            </span>
          ) : null}
        </span>
        <span className="device-meta">
          {kind.label} ·{" "}
          {device.lastSeenAt === null
            ? `paired ${timeAgo(device.createdAt, now)}, not used yet`
            : `last seen ${timeAgo(device.lastSeenAt, now)}`}
        </span>
        <InlineError message={error} testId="device-revoke-error" />
      </span>
      <button
        type="button"
        className="button is-danger-ghost"
        disabled={revoking}
        data-testid="device-revoke"
        onClick={() =>
          confirm({
            title: device.current ? "Revoke this browser?" : `Revoke ${device.name}?`,
            message: device.current
              ? "This browser is signed out at once. Using Daily Do List here again takes a new pairing code."
              : `${device.name} is cut off at once. Pairing it again takes a new code.`,
            confirmLabel: "Revoke",
            danger: true,
            onConfirm: () => void revoke(),
          })
        }
      >
        {revoking ? "Revoking…" : "Revoke…"}
      </button>
      {dialog}
    </li>
  );
}

function NewCodeForm({ onIssued }: { onIssued(code: PairingCodeResponse): void }) {
  const { client } = useServices();
  const [name, setName] = useState("");
  const [issuing, setIssuing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const problem = name.trim() ? deviceNameProblem(name) : null;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (problem) return;
    setIssuing(true);
    setError(null);
    try {
      onIssued(await client.createPairingCode(name.trim() ? { name: name.trim() } : {}));
    } catch (e) {
      setError(remoteErrorMessage(e, "pairingCode"));
    } finally {
      setIssuing(false);
    }
  };
  return (
    <form className="remote-form" onSubmit={submit} noValidate data-testid="pairing-code-form">
      <div className="remote-field">
        <label className="remote-field-label" htmlFor={id}>
          Its name <span className="muted">(optional)</span>
        </label>
        <input
          id={id}
          className="input"
          value={name}
          placeholder="It names itself when left empty"
          spellCheck={false}
          aria-invalid={problem !== null}
          data-testid="pairing-code-name"
          onChange={(event) => setName(event.target.value)}
        />
        {problem ? <span className="remote-field-error">{problem}</span> : null}
      </div>
      <InlineError message={error} testId="pairing-code-error" />
      <div className="remote-actions">
        <button
          type="submit"
          className="button is-primary"
          disabled={issuing}
          data-testid="pairing-code-create"
        >
          {issuing ? "Getting a code…" : "Get a code"}
        </button>
      </div>
    </form>
  );
}

function CodePanel({
  code,
  go,
  onNew,
  onDone,
}: {
  code: PairingCodeResponse;
  go: GoToSection;
  onNew(code: PairingCodeResponse): void;
  onDone(): void;
}) {
  const { client } = useServices();
  const now = useNow(1_000);
  const [error, setError] = useState<string | null>(null);
  const left = code.expiresAt - now;
  const expired = left <= 0;
  const again = async () => {
    setError(null);
    try {
      onNew(await client.createPairingCode());
    } catch (e) {
      setError(remoteErrorMessage(e, "pairingCode"));
    }
  };
  return (
    <div
      className={cx("pairing-code-panel", expired && "is-expired")}
      data-testid="pairing-code-panel"
      data-expired={expired ? "true" : undefined}
    >
      <div className="pairing-code-big">
        <CopyValue
          value={formatPairingCode(code.code)}
          label="Copy the code"
          testId="pairing-code"
        />
      </div>
      <div className="pairing-code-meta" role="timer" data-testid="pairing-code-expiry">
        {expired ? "This code expired." : `Expires in ${countdown(left)}`}
      </div>
      {code.url ? (
        <div className="pairing-code-meta">
          On the new device, open{" "}
          <CopyValue value={code.url} label="Copy the address" testId="pairing-code-url" /> and
          enter the code.
        </div>
      ) : (
        <div className="pairing-code-meta" data-testid="pairing-code-no-url">
          Other devices can&apos;t reach this daemon yet: add the name they reach it by in{" "}
          <button type="button" className="link-button" onClick={() => go("remote")}>
            Remote access
          </button>
          .
        </div>
      )}
      <InlineError message={error} testId="pairing-code-error" />
      <div className="remote-actions">
        {expired ? (
          <button
            type="button"
            className="button is-primary"
            onClick={() => void again()}
            data-testid="pairing-code-again"
          >
            Get a new code
          </button>
        ) : null}
        <button type="button" className="button" onClick={onDone} data-testid="pairing-code-done">
          Done
        </button>
      </div>
    </div>
  );
}
