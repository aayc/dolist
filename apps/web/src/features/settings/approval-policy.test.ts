import { APPROVAL_POLICIES, type ApprovalPolicy } from "@ddl/core";
import { describe, expect, it } from "vitest";
import {
  APPROVAL_POLICY_OPTIONS,
  approvalPolicyItem,
  NEVER_ALLOWED,
  needsConfirmation,
  RUN_EVERYTHING_CONFIRMATION,
  shownPolicy,
} from "./approval-policy";

describe("approval policy choices", () => {
  it("offers every policy once, strictest first", () => {
    expect(APPROVAL_POLICY_OPTIONS.map((o) => o.policy)).toEqual([...APPROVAL_POLICIES]);
  });

  it("uses the agreed labels and descriptions (the Mac app shows the same words)", () => {
    expect(APPROVAL_POLICY_OPTIONS.map(({ label, description }) => [label, description])).toEqual([
      [
        "Ask before every action",
        "Every action that changes something asks first. Reading, searching and research don't.",
      ],
      [
        "Ask for risky actions (recommended)",
        "The safety check decides: purchases, messages, bookings, deletions, account changes and anything it can't verify ask first.",
      ],
      [
        "Ask only for high-risk actions",
        "Only high-risk actions ask first (sending messages, paying, deleting, account and credential changes); everything else runs.",
      ],
      [
        "Run everything",
        "Agents never ask. Actions that are never allowed stay blocked: deleting your home folder, reading passwords or keychains, controlling Daily Do List itself, System Settings or password managers.",
      ],
    ]);
  });

  it("names only things the hard-deny rules and protected apps really block", () => {
    // shell.hardline.rm-home, secrets.credential-store / keychain-dump, system.protected-app and
    // network.app-self-access (see packages/agent/src/safety/README.md).
    expect(NEVER_ALLOWED).toBe(
      "deleting your home folder, reading passwords or keychains, controlling Daily Do List itself, System Settings or password managers",
    );
    expect(RUN_EVERYTHING_CONFIRMATION.message).toContain(NEVER_ALLOWED);
  });

  it("confirms only before running everything", () => {
    expect(APPROVAL_POLICIES.filter(needsConfirmation)).toEqual(["run_everything"]);
    expect(RUN_EVERYTHING_CONFIRMATION).toMatchObject({
      title: "Run everything without asking?",
      confirmLabel: "Run everything",
    });
  });

  it("shows a policy it doesn't know (from a newer daemon) as the default", () => {
    expect(shownPolicy({ approvalPolicy: "ask_high_risk" })).toBe("ask_high_risk");
    expect(shownPolicy({ approvalPolicy: "ask_payments" as ApprovalPolicy })).toBe("ask_risky");
    expect(shownPolicy({ approvalPolicy: undefined as unknown as ApprovalPolicy })).toBe(
      "ask_risky",
    );
  });
});

describe("approval policy status item", () => {
  it("shows nothing for the default policy", () => {
    expect(approvalPolicyItem({ approvalPolicy: "ask_risky" })).toBeNull();
  });

  it("warns while agents run everything and names the other policies neutrally", () => {
    expect(approvalPolicyItem({ approvalPolicy: "run_everything" })).toEqual({
      label: "Runs everything",
      title: "Agents run everything without asking — click to change",
      tone: "warning",
    });
    expect(approvalPolicyItem({ approvalPolicy: "ask_high_risk" })).toMatchObject({
      label: "Asks only for high-risk",
      tone: "neutral",
    });
    expect(approvalPolicyItem({ approvalPolicy: "ask_every_action" })).toMatchObject({
      label: "Asks before every action",
      tone: "neutral",
    });
  });
});
