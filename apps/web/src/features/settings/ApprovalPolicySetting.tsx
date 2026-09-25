import type { ApprovalPolicy } from "@ddl/core";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useServices } from "../../app/services";
import { cx } from "../../lib/cx";
import { useSettingsStore } from "../../state/settings-store";
import { ui } from "../../state/ui-store";
import { ConfirmDialog } from "../overlays/ConfirmDialog";
import {
  APPROVAL_POLICY_OPTIONS,
  needsConfirmation,
  RUN_EVERYTHING_CONFIRMATION,
  shownPolicy,
} from "./approval-policy";

/** Settings → Agent → Approvals: when agents ask before acting. "Run everything" confirms first. */
export function ApprovalPolicySetting() {
  const { updateSettings } = useServices();
  const policy = useSettingsStore((s) => shownPolicy(s.settings.agent));
  const [confirming, setConfirming] = useState<ApprovalPolicy | null>(null);
  useEffect(
    () => (confirming ? ui.stackDialog(() => setConfirming(null)) : undefined),
    [confirming],
  );
  const save = (approvalPolicy: ApprovalPolicy) =>
    void updateSettings({ agent: { approvalPolicy } });
  const choose = (next: ApprovalPolicy) => {
    if (next === policy) return;
    if (needsConfirmation(next)) setConfirming(next);
    else save(next);
  };
  return (
    <div className="setting setting-stacked" data-testid="setting-approvals">
      <div className="setting-info">
        <div className="setting-name" id="approvals-heading">
          Approvals
        </div>
        <div className="setting-description">When agents ask you before they act.</div>
      </div>
      <fieldset className="approval-policies" aria-labelledby="approvals-heading">
        {APPROVAL_POLICY_OPTIONS.map(({ policy: option, label, description }) => (
          <label
            key={option}
            className={cx("approval-policy", policy === option && "is-active")}
            data-testid={`setting-approval-${option}`}
          >
            <input
              type="radio"
              name="approval-policy"
              value={option}
              checked={policy === option}
              aria-describedby={`approval-policy-${option}`}
              onChange={() => choose(option)}
            />
            <span className="approval-policy-text">
              <span className="approval-policy-label">{label}</span>
              <span className="approval-policy-description" id={`approval-policy-${option}`}>
                {description}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      {confirming
        ? createPortal(
            <ConfirmDialog
              request={{
                ...RUN_EVERYTHING_CONFIRMATION,
                danger: true,
                onConfirm: () => save(confirming),
              }}
              onClose={() => setConfirming(null)}
            />,
            document.body,
          )
        : null}
    </div>
  );
}
