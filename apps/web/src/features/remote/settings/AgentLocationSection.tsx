import { useEffect, useState } from "react";
import { useServices } from "../../../app/services";
import { updateAgentState, useAgentStore } from "../../../state/agent-store";
import { LocationStatus } from "../AgentLocation";
import { applyDevice, loadDevice, useDeviceStore } from "../device-store";
import { deviceNameProblem } from "../inputs";
import { PlacementToggle } from "../PlacementToggle";
import { remoteErrorMessage } from "../remote-errors";
import { type GoToSection, InlineError, LockedNote, Readiness, usePoll } from "./parts";

/** While the section is open, the agent status (readiness, handovers) is refreshed this often. */
const POLL_MS = 5_000;

/** Settings → Agent location: where this device's agent runs, and whether it could run here. */
export function AgentLocationSection({ go }: { go: GoToSection }) {
  const { client } = useServices();
  const placement = useAgentStore((s) => s.status?.placement);
  const readiness = useAgentStore((s) => s.status?.readiness);
  const locked = useDeviceStore((s) => s.device?.lockedByEnv.includes("placement") ?? false);
  useEffect(() => {
    void loadDevice(client, true);
  }, [client]);
  usePoll(() => {
    client.getAgentStatus().then(
      (status) => updateAgentState((state) => ({ ...state, status })),
      () => {},
    );
  }, POLL_MS);

  return (
    <section data-testid="settings-location">
      <h2 className="settings-heading">Agent location</h2>
      <p className="settings-hint">
        Where the orchestrator and its agents run for this device. Each device chooses for itself;
        your notes stay on every device either way.
      </p>
      {!placement ? (
        <p className="muted" data-testid="location-unsupported">
          This daemon doesn&apos;t say where its agent runs. Update Daily Do List to choose.
        </p>
      ) : (
        <>
          {placement.placement === "always_on_host" ? (
            <div className="setting setting-stacked" data-testid="setting-placement">
              <div className="setting-info">
                <div className="setting-name">This is the always-on machine</div>
                <div className="setting-description">
                  It runs the agent whenever no device set to run it itself is on. Each other device
                  picks where its agent runs in its own Settings.
                </div>
              </div>
            </div>
          ) : (
            <div className="setting setting-stacked" data-testid="setting-placement">
              <div className="setting-info">
                <div className="setting-name">Where the orchestrator runs</div>
                <div className="setting-description">
                  <strong>This device</strong>: the agent runs here, and takes over from the
                  always-on machine while this device is on. <strong>Always-on machine</strong>: it
                  runs there, even while this device sleeps, and this device shows and approves its
                  work.
                </div>
              </div>
              <PlacementToggle testId="settings-placement-toggle" />
            </div>
          )}
          <LocationStatus testId="settings-location-line" />
          {locked ? (
            <LockedNote testId="placement-locked">
              DDL_AGENT_PLACEMENT sets where the agent runs on this device: change it there.
            </LockedNote>
          ) : null}
          <DeviceName />
          <h3 className="settings-subheading">This device&apos;s readiness</h3>
          <p className="settings-hint">
            What this device has for running the agent. Connectors, API keys, browser sign-ins and
            permissions stay with each machine, so check them before moving the agent here.
          </p>
          {readiness ? (
            <Readiness readiness={readiness} where="here" go={go} testId="readiness-here" />
          ) : (
            // The daemon probes in the background right after it starts.
            <p className="muted" data-testid="readiness-checking">
              Checking…
            </p>
          )}
        </>
      )}
    </section>
  );
}

/** How other devices name this one ("The agent is running on …"). */
function DeviceName() {
  const { client } = useServices();
  const name = useDeviceStore((s) => s.device?.device.name);
  const [draft, setDraft] = useState(name ?? "");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(name ?? ""), [name]);
  if (name === undefined) return null;
  const problem = deviceNameProblem(draft);
  const commit = async () => {
    if (draft.trim() === name) return setDraft(name);
    if (problem) return setError(problem);
    setError(null);
    try {
      applyDevice(await client.updateDevice({ name: draft.trim() }));
    } catch (e) {
      setError(remoteErrorMessage(e, "rename"));
    }
  };
  return (
    <div className="setting" data-testid="setting-device-name">
      <div className="setting-info">
        <div className="setting-name">This device&apos;s name</div>
        <div className="setting-description">
          How your other devices name it, as in “The agent is running on {name}”.
        </div>
        <InlineError message={error} testId="device-name-error" />
      </div>
      <div className="setting-control">
        <input
          className="input"
          value={draft}
          aria-label="This device's name"
          spellCheck={false}
          data-testid="device-name"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(event) => {
            if (event.key === "Enter") void commit();
          }}
        />
      </div>
    </div>
  );
}
