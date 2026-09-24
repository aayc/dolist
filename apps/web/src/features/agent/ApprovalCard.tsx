import type { ApprovalRequest, ApprovalScope } from "@ddl/core";
import { ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import { useState } from "react";
import { useServices } from "../../app/services";
import { cx } from "../../lib/cx";
import { formatTimestamp } from "../../lib/format";
import { CATEGORY_LABELS } from "./status-meta";

const SCOPE_LABEL: Record<ApprovalScope, string> = {
  once: "once",
  task: "for this task",
  always: "always",
};

function decidedText(approval: ApprovalRequest): string {
  const when = approval.decidedAt ? ` · ${formatTimestamp(approval.decidedAt)}` : "";
  switch (approval.status) {
    case "approved":
      return `Approved ${SCOPE_LABEL[approval.scope ?? "once"]} by you${when}`;
    case "denied":
      return `Denied by you${when}`;
    case "expired":
      return `Expired${when}`;
    case "cancelled":
      return `Cancelled${when}`;
    default:
      return "";
  }
}

export function ApprovalCard({ approval }: { approval: ApprovalRequest }) {
  const { agent } = useServices();
  const [showInput, setShowInput] = useState(false);
  const [denying, setDenying] = useState(false);
  const [note, setNote] = useState("");
  const pending = approval.status === "pending";
  const Icon = pending ? ShieldAlert : approval.status === "approved" ? ShieldCheck : ShieldX;

  const approve = (scope: ApprovalScope) =>
    void agent.decide(approval, { decision: "approve", scope });
  const deny = () => {
    const trimmed = note.trim();
    void agent.decide(approval, { decision: "deny", ...(trimmed ? { note: trimmed } : {}) });
  };

  return (
    <section
      className={cx("approval-card", `risk-${approval.risk}`, `is-${approval.status}`)}
      aria-label="Approval request"
      data-testid="approval-card"
      data-status={approval.status}
    >
      <header className="approval-head">
        <Icon size={16} aria-hidden="true" />
        <span className="approval-heading">{pending ? "Approval needed" : "Approval"}</span>
        <span className="approval-tool">{approval.toolLabel ?? approval.toolName}</span>
      </header>
      <p className="approval-summary" data-testid="approval-summary">
        {approval.summary}
      </p>
      <div className="approval-chips">
        <span className={cx("chip", `risk-${approval.risk}`)}>{approval.risk} risk</span>
        {approval.categories.map((category) => (
          <span key={category} className="chip">
            {CATEGORY_LABELS[category]}
          </span>
        ))}
      </div>
      <p className="approval-reason">{approval.reason}</p>
      <button type="button" className="link-button" onClick={() => setShowInput((v) => !v)}>
        {showInput ? "Hide details" : "Show details"}
      </button>
      {showInput ? (
        <pre className="approval-input">{JSON.stringify(approval.input, null, 2)}</pre>
      ) : null}

      {!pending ? (
        <div className="approval-decided" data-testid="approval-decided">
          {decidedText(approval)}
          {approval.decisionNote ? <q className="approval-note">{approval.decisionNote}</q> : null}
        </div>
      ) : denying ? (
        <div className="approval-deny">
          <textarea
            className="textarea"
            placeholder="Optional note for the agent (why not, or what to do instead)"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={2}
            data-testid="deny-note"
            // biome-ignore lint/a11y/noAutofocus: continuing a keyboard flow the user started
            autoFocus
          />
          <div className="approval-actions">
            <button type="button" className="button" onClick={() => setDenying(false)}>
              Back
            </button>
            <button
              type="button"
              className="button is-danger"
              onClick={deny}
              data-testid="deny-confirm"
            >
              Deny
            </button>
          </div>
        </div>
      ) : (
        <div className="approval-actions">
          <button
            type="button"
            className="button is-primary"
            onClick={() => approve("once")}
            data-testid="approve-once"
          >
            Approve once
          </button>
          <button
            type="button"
            className="button"
            onClick={() => approve("task")}
            data-testid="approve-task"
          >
            Approve for this task
          </button>
          <button
            type="button"
            className="button is-danger-ghost"
            onClick={() => setDenying(true)}
            data-testid="deny"
          >
            Deny…
          </button>
        </div>
      )}
      {pending && approval.expiresAt ? (
        <p className="approval-expiry">
          Auto-denied if not answered by {formatTimestamp(approval.expiresAt)}
        </p>
      ) : null}
    </section>
  );
}
