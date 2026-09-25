import { type AgentSettings, APPROVAL_POLICIES, type ApprovalPolicy } from "@ddl/core";

/** One choice of Settings → Agent → Approvals (the Mac app shows the same words). */
export interface ApprovalPolicyOption {
  policy: ApprovalPolicy;
  label: string;
  description: string;
}

/** What stays blocked under every policy: the hard-deny rules and protected apps, in plain words. */
export const NEVER_ALLOWED =
  "deleting your home folder, reading passwords or keychains, controlling Daily Do List itself, System Settings or password managers";

export const APPROVAL_POLICY_OPTIONS: readonly ApprovalPolicyOption[] = [
  {
    policy: "ask_every_action",
    label: "Ask before every action",
    description:
      "Every action that changes something asks first. Reading, searching and research don't.",
  },
  {
    policy: "ask_risky",
    label: "Ask for risky actions (recommended)",
    description:
      "The safety check decides: purchases, messages, bookings, deletions, account changes and anything it can't verify ask first.",
  },
  {
    policy: "ask_high_risk",
    label: "Ask only for high-risk actions",
    description:
      "Only high-risk actions ask first (sending messages, paying, deleting, account and credential changes); everything else runs.",
  },
  {
    policy: "run_everything",
    label: "Run everything",
    description: `Agents never ask. Actions that are never allowed stay blocked: ${NEVER_ALLOWED}.`,
  },
];

/** The confirmation before choosing "Run everything". */
export const RUN_EVERYTHING_CONFIRMATION = {
  title: "Run everything without asking?",
  message: `Agents will act without asking you first: they can buy things, send messages, book, delete files and run programs on their own. Actions that are never allowed stay blocked: ${NEVER_ALLOWED}.`,
  confirmLabel: "Run everything",
};

/** The policy settings show as selected: one this build doesn't know shows as the default. */
export function shownPolicy(agent: Pick<AgentSettings, "approvalPolicy">): ApprovalPolicy {
  return APPROVAL_POLICIES.includes(agent.approvalPolicy) ? agent.approvalPolicy : "ask_risky";
}

/** Whether choosing `policy` asks for confirmation first. */
export function needsConfirmation(policy: ApprovalPolicy): boolean {
  return policy === "run_everything";
}

/** The status bar item while the policy isn't the default (same wording as the Mac app). */
export interface ApprovalPolicyItem {
  label: string;
  title: string;
  tone: "warning" | "neutral";
}

export function approvalPolicyItem(
  agent: Pick<AgentSettings, "approvalPolicy">,
): ApprovalPolicyItem | null {
  switch (shownPolicy(agent)) {
    case "run_everything":
      return {
        label: "Runs everything",
        title: "Agents run everything without asking — click to change",
        tone: "warning",
      };
    case "ask_high_risk":
      return {
        label: "Asks only for high-risk",
        title: "Agents ask only before high-risk actions — click to change",
        tone: "neutral",
      };
    case "ask_every_action":
      return {
        label: "Asks before every action",
        title: "Agents ask before every action that changes something — click to change",
        tone: "neutral",
      };
    case "ask_risky":
      return null;
  }
}
