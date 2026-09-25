import { REMOTE_LIMITS } from "@ddl/core";
import { X } from "lucide-react";
import { type FormEvent, useEffect, useId, useState } from "react";
import { useServices } from "../../../app/services";
import { IconButton } from "../../../components/IconButton";
import { applyDevice, loadDevice, useDeviceStore } from "../device-store";
import { remoteHostFromInput, remoteHostProblem } from "../inputs";
import { remoteErrorMessage } from "../remote-errors";
import { InlineError, LockedNote, useConfirm } from "./parts";

/** The host this page was opened at (a remote host when this is a paired remote browser). */
function pageHost(): string {
  return typeof location === "undefined" ? "" : location.host.toLowerCase();
}

/** Settings → Remote access: the names this daemon answers to besides this computer. */
export function RemoteAccessSection() {
  const { client } = useServices();
  const device = useDeviceStore((s) => s.device);
  const loadError = useDeviceStore((s) => s.loadError);
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirm, dialog] = useConfirm();
  const id = useId();
  useEffect(() => {
    void loadDevice(client, true);
  }, [client]);

  if (!device) {
    return (
      <section data-testid="settings-remote">
        <h2 className="settings-heading">Remote access</h2>
        {loadError ? (
          <InlineError message={loadError} testId="remote-load-error" />
        ) : (
          <div className="thread-loading" aria-busy="true" />
        )}
      </section>
    );
  }
  const hosts = device.remoteHosts;
  const locked = device.lockedByEnv.includes("remoteHosts");

  const save = async (next: string[]): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      applyDevice(await client.updateDevice({ remoteHosts: next }));
      return true;
    } catch (e) {
      setError(remoteErrorMessage(e, "remoteHosts"));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const add = async (event: FormEvent) => {
    event.preventDefault();
    const why = remoteHostProblem(draft, hosts);
    const host = remoteHostFromInput(draft);
    setProblem(why);
    if (why || !host) return;
    if (await save([...hosts, host])) setDraft("");
  };

  const remove = (host: string) => {
    const next = hosts.filter((h) => h !== host);
    if (host !== pageHost()) {
      void save(next);
      return;
    }
    confirm({
      title: `Remove ${host}?`,
      message:
        "You're using Daily Do List through this name: removing it disconnects this browser. Other devices using it lose access too.",
      confirmLabel: "Remove",
      danger: true,
      onConfirm: () => void save(next),
    });
  };

  return (
    <section data-testid="settings-remote">
      <h2 className="settings-heading">Remote access</h2>
      <p className="settings-hint">
        The names this daemon answers to besides this computer, such as its Tailscale name. Each
        lets paired devices open https://&lt;name&gt; over your private network; nothing else can
        use it. With none, Daily Do List stays local-only.
      </p>
      {locked ? (
        <LockedNote testId="remote-locked">
          DDL_REMOTE_HOSTS sets the names this daemon answers to: change it there.
        </LockedNote>
      ) : null}
      {hosts.length === 0 ? (
        <p className="muted" data-testid="remote-empty">
          No remote names: only this computer can reach this daemon.
        </p>
      ) : (
        <ul className="host-list" data-testid="remote-hosts">
          {hosts.map((host) => (
            <li key={host} className="host-row" data-testid="remote-host">
              <code>{host}</code>
              {host === pageHost() ? <span className="chip">This page</span> : null}
              {locked ? null : (
                <IconButton
                  icon={X}
                  label={`Remove ${host}`}
                  size={14}
                  disabled={saving}
                  onClick={() => remove(host)}
                  data-testid="remote-host-remove"
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {locked ? null : (
        <form className="remote-form" onSubmit={add} noValidate data-testid="remote-add-form">
          <div className="remote-field">
            <label className="remote-field-label" htmlFor={id}>
              Add a name
            </label>
            <div className="host-add">
              <input
                id={id}
                className="input"
                value={draft}
                placeholder="vm-name.tailnet-name.ts.net"
                spellCheck={false}
                autoComplete="off"
                aria-invalid={problem !== null}
                aria-describedby={`${id}-note`}
                data-testid="remote-host-input"
                onChange={(event) => {
                  setDraft(event.target.value);
                  setProblem(null);
                }}
              />
              <button
                type="submit"
                className="button"
                disabled={saving || hosts.length >= REMOTE_LIMITS.remoteHosts}
                data-testid="remote-host-add"
              >
                Add
              </button>
            </div>
            {problem ? (
              <span
                className="remote-field-error"
                id={`${id}-note`}
                data-testid="remote-host-problem"
              >
                {problem}
              </span>
            ) : (
              <span className="remote-field-hint" id={`${id}-note`}>
                A DNS name, optionally with :port. At most {REMOTE_LIMITS.remoteHosts}.
              </span>
            )}
          </div>
        </form>
      )}
      <InlineError message={error} testId="remote-error" />
      {dialog}
    </section>
  );
}
