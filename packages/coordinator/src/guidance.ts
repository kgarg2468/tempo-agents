import type {
  AgentSession,
  Fingerprint,
  InterventionDirective,
  InterventionDirectiveRole,
  TempoConflict
} from "@tempo/shared";
import { interventionDirectiveSchema } from "@tempo/shared";

const MAX_DIRECTIVE_CHARS = 1200;
const MAX_CONTEXT_ITEMS = 5;
const MAX_PEER_SUMMARY_CHARS = 140;

export interface AgentDirectiveInput {
  conflict: TempoConflict;
  targetSessionId: string;
  ownerSessionId?: string | null | undefined;
  agents: AgentSession[];
  fingerprints: Fingerprint[];
  editedDirection?: string;
}

export function buildAgentSpecificDirective(
  input: AgentDirectiveInput
): InterventionDirective {
  const target = input.agents.find((agent) => agent.id === input.targetSessionId);
  const owner = input.ownerSessionId
    ? input.agents.find((agent) => agent.id === input.ownerSessionId)
    : null;
  const role = roleFor(input.targetSessionId, owner?.id ?? null);
  const peer = peerFor({ target, owner, agents: input.agents, conflict: input.conflict });
  const peerFingerprint = latestFingerprintFor(input.fingerprints, peer?.worktreeId);

  const directive = interventionDirectiveSchema.parse({
    role,
    conflict: input.conflict.title,
    ...(peer?.displayName ? { peerAgentName: peer.displayName } : {}),
    ...(peer?.worktreeId ? { peerWorktreeId: peer.worktreeId } : {}),
    peerIntentSummary: summarizePeerIntent(peer, peerFingerprint),
    sharedSurfaces: input.conflict.affectedSurfaces.slice(0, MAX_CONTEXT_ITEMS),
    sharedFiles: sharedFiles(input.fingerprints, input.conflict),
    nextAction: nextActionFor({
      role,
      conflict: input.conflict,
      peerName: peer?.displayName
    }),
    planSteps: planStepsFor({
      role,
      conflict: input.conflict,
      peerName: peer?.displayName
    })
  });

  return enforceDirectiveBudget(directive);
}

export function directionFromDirective(
  directive: InterventionDirective,
  fallback: string
): string {
  const roleLabel = directive.role.replace(/_/g, " ");
  const pieces = [
    `You are the ${roleLabel} for ${directive.conflict}.`,
    directive.peerAgentName ? `Peer: ${directive.peerAgentName}.` : null,
    directive.peerIntentSummary ? `Peer intent: ${directive.peerIntentSummary}` : null,
    directive.nextAction
  ].filter(Boolean);
  const direction = pieces.join(" ");
  return trimToLength(direction || fallback, MAX_DIRECTIVE_CHARS);
}

function roleFor(
  targetSessionId: string,
  ownerSessionId: string | null
): InterventionDirectiveRole {
  if (!ownerSessionId) return "pause_only";
  return targetSessionId === ownerSessionId ? "contract_owner" : "adapter";
}

function peerFor({
  target,
  owner,
  agents,
  conflict
}: {
  target: AgentSession | undefined;
  owner: AgentSession | null | undefined;
  agents: AgentSession[];
  conflict: TempoConflict;
}): AgentSession | undefined {
  if (owner && owner.id !== target?.id) return owner;
  return agents.find(
    (agent) =>
      agent.id !== target?.id &&
      agent.worktreeId !== null &&
      conflict.affectedWorktreeIds.includes(agent.worktreeId)
  );
}

function latestFingerprintFor(
  fingerprints: Fingerprint[],
  worktreeId: string | null | undefined
): Fingerprint | undefined {
  if (!worktreeId) return undefined;
  return fingerprints
    .filter((fingerprint) => fingerprint.worktreeId === worktreeId)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
}

function summarizePeerIntent(
  peer: AgentSession | undefined,
  fingerprint: Fingerprint | undefined
): string {
  const raw =
    fingerprint?.semanticSummary ||
    peer?.currentPlan ||
    "Peer intent unknown.";
  return oneSentence(raw, MAX_PEER_SUMMARY_CHARS);
}

function sharedFiles(
  fingerprints: Fingerprint[],
  conflict: TempoConflict
): string[] {
  const relevant = fingerprints.filter((fingerprint) =>
    conflict.affectedWorktreeIds.includes(fingerprint.worktreeId)
  );
  const counts = new Map<string, number>();
  for (const fingerprint of relevant) {
    for (const file of fingerprint.filesTouched) {
      counts.set(file, (counts.get(file) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort(
      (a, b) =>
        b[1] - a[1] ||
        fileRank(b[0]) - fileRank(a[0]) ||
        a[0].localeCompare(b[0])
    )
    .map(([file]) => file)
    .slice(0, MAX_CONTEXT_ITEMS);
}

function nextActionFor({
  role,
  conflict,
  peerName
}: {
  role: InterventionDirectiveRole;
  conflict: TempoConflict;
  peerName?: string | undefined;
}): string {
  if (role === "contract_owner") {
    return `Own the ${conflict.primarySurface} shape, checkpoint the final schema/type/API contract, and do not inspect or edit peer worktrees.`;
  }
  if (role === "adapter") {
    return `Pause ${conflict.primarySurface} edits until ${peerName ?? "the owner"} checkpoints the owner shape, then preserve that contract while adapting your work.`;
  }
  if (role === "compatibility_owner") {
    return `Keep ${conflict.primarySurface} backward compatible and checkpoint the compatibility shape before dependent edits continue.`;
  }
  return `Pause ${conflict.primarySurface} edits until the user assigns an owner or compatibility path.`;
}

function planStepsFor({
  role,
  conflict,
  peerName
}: {
  role: InterventionDirectiveRole;
  conflict: TempoConflict;
  peerName?: string | undefined;
}): string[] {
  if (role === "contract_owner") {
    return [
      `Define the final ${conflict.primarySurface} shape, including compatible peer intent where applicable.`,
      "Update schema, shared types, and API serialization around that final shape.",
      "Avoid inspecting or editing peer worktrees.",
      "Checkpoint the final contract before adapters continue."
    ];
  }
  if (role === "adapter") {
    return [
      `Pause disputed ${conflict.primarySurface} edits until ${peerName ?? "the owner"} checkpoints.`,
      "Read the owner direction and preserve the published contract shape.",
      "Adapt local feature code around the owner shape.",
      "Checkpoint after the adaptation batch."
    ];
  }
  if (role === "compatibility_owner") {
    return [
      `Keep ${conflict.primarySurface} backward compatible.`,
      "Document the compatibility behavior in the plan.",
      "Update dependent code only after the compatibility shape is clear.",
      "Checkpoint before dependent edits continue."
    ];
  }
  return [
    `Pause ${conflict.primarySurface} edits.`,
    "Review the numbered coordination choices with the user.",
    "Record the user-approved decision in Tempo.",
    "Continue only after a direction is available."
  ];
}

function enforceDirectiveBudget(
  directive: InterventionDirective
): InterventionDirective {
  const next = { ...directive };
  while (JSON.stringify(next).length > MAX_DIRECTIVE_CHARS && next.sharedFiles.length > 0) {
    next.sharedFiles = next.sharedFiles.slice(0, -1);
  }
  while (
    JSON.stringify(next).length > MAX_DIRECTIVE_CHARS &&
    next.sharedSurfaces.length > 0
  ) {
    next.sharedSurfaces = next.sharedSurfaces.slice(0, -1);
  }
  if (JSON.stringify(next).length > MAX_DIRECTIVE_CHARS) {
    next.nextAction = trimToLength(next.nextAction, 240);
    if (next.peerIntentSummary) {
      next.peerIntentSummary = trimToLength(next.peerIntentSummary, 100);
    }
  }
  return interventionDirectiveSchema.parse(next);
}

function oneSentence(value: string, maxLength: number): string {
  const sentence = value
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)[0]
    ?.trim();
  return trimToLength(sentence || "Peer intent unknown.", maxLength);
}

function trimToLength(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function fileRank(file: string): number {
  if (/schema|model|migration/.test(file)) return 100;
  if (/shared|type|contract/.test(file)) return 90;
  if (/api|route/.test(file)) return 80;
  if (/component|tsx$/.test(file)) return 60;
  return 10;
}
