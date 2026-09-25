import { normalizeDeviceName, normalizePairingCode } from "@ddl/core";
import { type FormEvent, useId, useState } from "react";
import type { PairBrowser } from "../../api/pairing";
import { deviceNameProblem } from "../remote/inputs";
import { PairingCodeInput } from "../remote/PairingCodeInput";
import { codeProblem } from "../remote/pairing-code";
import { remoteErrorMessage } from "../remote/remote-errors";
import { thisBrowserName } from "./browser-name";
import "../../styles/remote.css";
import "../../styles/pairing.css";

/**
 * What a browser on one of the daemon's remote hosts sees until it's paired (or after it was
 * revoked): a pairing code and this browser's name. Pairing sets its HttpOnly device cookie; the
 * page then reloads into the app.
 */
export function PairingScreen({
  pair,
  revoked = false,
  onPaired,
  defaultName = thisBrowserName(),
}: {
  pair: PairBrowser;
  /** This browser was paired and got revoked. */
  revoked?: boolean;
  onPaired(): void;
  defaultName?: string;
}) {
  const [code, setCode] = useState("");
  const [name, setName] = useState(defaultName);
  const [shown, setShown] = useState(false);
  const [state, setState] = useState<"idle" | "pairing" | "paired">("idle");
  const [error, setError] = useState<string | null>(null);
  const ids = useId();
  const problems = { code: codeProblem(code), name: deviceNameProblem(name) };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setShown(true);
    const pairingCode = normalizePairingCode(code);
    const deviceName = normalizeDeviceName(name);
    if (!pairingCode || !deviceName) return;
    setState("pairing");
    setError(null);
    try {
      await pair({ code: pairingCode, name: deviceName });
      setState("paired");
      onPaired();
    } catch (e) {
      setError(remoteErrorMessage(e, "pair"));
      setState("idle");
    }
  };

  return (
    <main className="pairing-screen" data-testid="pairing-screen">
      <form className="pairing-card" onSubmit={submit} noValidate aria-labelledby={`${ids}-title`}>
        <img className="pairing-logo" src="/favicon.svg" alt="" width={40} height={40} />
        <h1 className="pairing-title" id={`${ids}-title`}>
          {revoked ? "This browser was signed out" : "Pair this browser"}
        </h1>
        <p className="pairing-lead" data-testid="pairing-lead">
          {revoked
            ? "It isn't paired with Daily Do List anymore. Pair it again with a new code to continue."
            : "Daily Do List only lets in devices you pair. Enter a pairing code to use it here."}
        </p>
        <p className="pairing-hint">
          Get a code on a device that&apos;s already paired: Settings → Devices → Pair a new device.
          On the always-on machine, its daemon&apos;s <code>pair</code> command prints one too.
        </p>
        <div className="remote-field">
          <label className="remote-field-label" htmlFor={`${ids}-code`}>
            Pairing code
          </label>
          <PairingCodeInput
            id={`${ids}-code`}
            value={code}
            onValue={setCode}
            autoFocus
            disabled={state !== "idle"}
            aria-invalid={shown && problems.code !== null}
            aria-describedby={`${ids}-code-note`}
            data-testid="pairing-code-input"
          />
          {shown && problems.code ? (
            <span
              className="remote-field-error"
              id={`${ids}-code-note`}
              data-testid="pairing-code-problem"
            >
              {problems.code}
            </span>
          ) : (
            <span className="remote-field-hint" id={`${ids}-code-note`}>
              8 letters and digits, shown as XXXX-XXXX. It works once, for 5 minutes.
            </span>
          )}
        </div>
        <div className="remote-field">
          <label className="remote-field-label" htmlFor={`${ids}-name`}>
            This browser&apos;s name
          </label>
          <input
            id={`${ids}-name`}
            className="input"
            value={name}
            spellCheck={false}
            autoComplete="off"
            disabled={state !== "idle"}
            aria-invalid={shown && problems.name !== null}
            aria-describedby={`${ids}-name-note`}
            data-testid="pairing-name"
            onChange={(event) => setName(event.target.value)}
          />
          {shown && problems.name ? (
            <span className="remote-field-error" id={`${ids}-name-note`}>
              {problems.name}
            </span>
          ) : (
            <span className="remote-field-hint" id={`${ids}-name-note`}>
              How it shows in Settings → Devices, where it can be revoked.
            </span>
          )}
        </div>
        {error ? (
          <p className="settings-error pairing-error" role="alert" data-testid="pairing-error">
            {error}
          </p>
        ) : null}
        {state === "paired" ? (
          <p className="settings-success" role="status" data-testid="pairing-done">
            Paired. Opening Daily Do List…
          </p>
        ) : null}
        <button
          type="submit"
          className="button is-primary pairing-submit"
          disabled={state !== "idle"}
          data-testid="pairing-submit"
        >
          {state === "pairing" ? "Pairing…" : "Pair"}
        </button>
      </form>
    </main>
  );
}
