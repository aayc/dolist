import type { ComputerAccess, ComputerPermissionPane } from "@ddl/core";
import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { errorMessage } from "../../api/errors";
import { useServices } from "../../app/services";
import { cx } from "../../lib/cx";
import { updateAgentState, useAgentStore } from "../../state/agent-store";
import { toast } from "../../state/toast-store";

/** While the section is open, the daemon is asked this often whether a switch was flipped. */
const POLL_MS = 1_500;

const PERMISSIONS: ReadonlyArray<{
  pane: ComputerPermissionPane;
  name: string;
  description: string;
  where: string;
}> = [
  {
    pane: "accessibility",
    name: "Accessibility",
    description: "Lets agents read other apps and press, type and click in them.",
    where: "Privacy & Security → Accessibility",
  },
  {
    pane: "screenRecording",
    name: "Screen Recording",
    description: "Lets agents see app windows in screenshots.",
    where: "Privacy & Security → Screen & System Audio Recording",
  },
];

/** Polls the agent status while mounted, so a permission granted in System Settings shows up. */
function usePolledStatus(): void {
  const { client } = useServices();
  useEffect(() => {
    let stopped = false;
    const poll = () => {
      client.getAgentStatus().then(
        (status) => !stopped && updateAgentState((state) => ({ ...state, status })),
        () => {},
      );
    };
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [client]);
}

export function ComputerUseSection() {
  usePolledStatus();
  const access = useAgentStore((s) => s.status?.execution.computerAccess);
  return (
    <section data-testid="settings-computer">
      <h2 className="settings-heading">Computer use</h2>
      <p className="settings-hint">
        Lets agents do tasks in your Mac&apos;s apps — Grok Bot, WhatsApp, Slack and others without
        a connector — in the background, one app at a time.
      </p>
      {access ? <AccessRows access={access} /> : <Unavailable />}
      <h3 className="settings-subheading">Guardrails</h3>
      <ul className="computer-guardrails">
        <li>Every action in another app asks you first, naming the app and the button or field.</li>
        <li>
          Daily Do List itself, System Settings, password managers and authenticators are always
          off-limits.
        </li>
        <li>What apps show is treated as untrusted text, never as instructions.</li>
      </ul>
    </section>
  );
}

function Unavailable() {
  return (
    <p className="muted" data-testid="computer-unavailable">
      Computer use isn&apos;t available here: it needs the daemon to run on a Mac.
    </p>
  );
}

function AccessRows({ access }: { access: ComputerAccess }) {
  const host = access.hostApp?.name;
  const hostLabel = host ? `“${host}”` : "the app that runs Daily Do List";
  return (
    <>
      {access.accessibility && access.screenRecording ? null : (
        <div className="settings-problem" data-testid="computer-host">
          Turn on {hostLabel} in each list below. macOS gives the permissions to that app, and the
          agents run inside it.
        </div>
      )}
      {PERMISSIONS.map((permission) => (
        <PermissionRow
          key={permission.pane}
          {...permission}
          granted={access[permission.pane]}
          relaunch={permission.pane === "screenRecording" ? hostLabel : undefined}
        />
      ))}
      <div className="setting">
        <div className="setting-info">
          <div className="setting-name">Background app control</div>
          <div className="setting-description">
            {access.appControl
              ? "Agents use apps without bringing them forward or moving your cursor."
              : "The ddl-computer helper isn't installed, so agents fall back to real clicks and keystrokes on the screen."}
          </div>
        </div>
        <div className="setting-control">
          <StatusChip
            ok={access.appControl}
            on="On"
            off="Screen only"
            testId="computer-app-control"
          />
        </div>
      </div>
    </>
  );
}

function PermissionRow({
  pane,
  name,
  description,
  where,
  granted,
  relaunch,
}: {
  pane: ComputerPermissionPane;
  name: string;
  description: string;
  where: string;
  granted: boolean;
  relaunch: string | undefined;
}) {
  const { client } = useServices();
  const [opening, setOpening] = useState(false);
  const open = () => {
    setOpening(true);
    client.openComputerPermissions(pane).then(
      () => setOpening(false),
      (error: unknown) => {
        setOpening(false);
        toast({ kind: "error", title: "Couldn't open System Settings", body: errorMessage(error) });
      },
    );
  };
  return (
    <div className="setting" data-testid={`computer-permission-${pane}`}>
      <div className="setting-info">
        <div className="setting-name">{name}</div>
        <div className="setting-description">
          {description}
          {!granted && relaunch
            ? ` After you turn it on, macOS asks to quit and reopen ${relaunch}.`
            : ""}
        </div>
      </div>
      <div className="setting-control computer-permission-control">
        <StatusChip
          ok={granted}
          on="Allowed"
          off="Not allowed"
          testId={`computer-status-${pane}`}
        />
        {granted ? null : (
          <button
            type="button"
            className="button is-primary"
            onClick={open}
            disabled={opening}
            data-tooltip={`Open System Settings → ${where}`}
            data-testid={`computer-open-${pane}`}
          >
            <ExternalLink size={13} aria-hidden="true" />
            Open System Settings
          </button>
        )}
      </div>
    </div>
  );
}

function StatusChip({
  ok,
  on,
  off,
  testId,
}: {
  ok: boolean;
  on: string;
  off: string;
  testId: string;
}) {
  return (
    <span
      className={cx("status-chip", ok ? "tone-success" : "tone-warning")}
      data-testid={testId}
      data-state={ok ? "on" : "off"}
    >
      <span className="status-chip-dot" />
      {ok ? on : off}
    </span>
  );
}
