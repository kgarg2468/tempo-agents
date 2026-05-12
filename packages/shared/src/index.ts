import { z } from "zod";

export const riskLevelSchema = z.enum(["low", "medium", "high"]);
export type RiskLevel = z.infer<typeof riskLevelSchema>;

export const conflictStatusSchema = z.enum([
  "open",
  "acknowledged",
  "resolved",
  "ignored"
]);
export type ConflictStatus = z.infer<typeof conflictStatusSchema>;

export const compatibilityKindSchema = z.enum([
  "no_issue",
  "coordination_notice",
  "blocking_conflict"
]);
export type CompatibilityKind = z.infer<typeof compatibilityKindSchema>;

export const compatibilityClassificationSchema = z.object({
  kind: compatibilityKindSchema,
  rationale: z.string().min(1),
  recommendedOwnerWorktreeId: z.string().min(1).optional(),
  recommendedOptionId: z.string().min(1).optional(),
  source: z.enum(["openai", "fallback"]).optional(),
  confidence: z.number().min(0).max(1).default(0.5)
});
export type CompatibilityClassification = z.infer<
  typeof compatibilityClassificationSchema
>;

export const coordinationRoleSchema = z.enum(["feature", "integration"]);
export type CoordinationRole = z.infer<typeof coordinationRoleSchema>;

export const surfaceKindSchema = z.enum([
  "schema",
  "api",
  "type",
  "component",
  "model",
  "dto",
  "utility",
  "test",
  "migration",
  "unknown"
]);
export type SurfaceKind = z.infer<typeof surfaceKindSchema>;

export const repoSchema = z.object({
  id: z.string().min(1),
  rootPath: z.string().min(1),
  name: z.string().min(1),
  createdAt: z.number(),
  updatedAt: z.number()
});
export type RebaseRepo = z.infer<typeof repoSchema>;

export const worktreeSchema = z.object({
  id: z.string().min(1),
  repoId: z.string().min(1),
  path: z.string().min(1),
  branch: z.string().nullable(),
  headSha: z.string().nullable(),
  dirty: z.boolean(),
  status: z.enum(["active", "missing", "unjoined"]),
  lastObservedAt: z.number()
});
export type RebaseWorktree = z.infer<typeof worktreeSchema>;

export const agentSessionSchema = z.object({
  id: z.string().min(1),
  repoId: z.string().min(1),
  worktreeId: z.string().min(1).nullable(),
  agentKind: z.enum(["codex", "claude", "unknown"]),
  coordinationRole: coordinationRoleSchema.optional(),
  cwd: z.string().min(1),
  displayName: z.string().min(1),
  currentPlan: z.string().optional(),
  lastCheckpointAt: z.number().nullable(),
  joinedAt: z.number()
});
export type AgentSession = z.infer<typeof agentSessionSchema>;

export const contractSurfaceSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: surfaceKindSchema,
  files: z.array(z.string().min(1)),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string().min(1))
});
export type ContractSurface = z.infer<typeof contractSurfaceSchema>;

export const fingerprintSchema = z.object({
  id: z.string().min(1),
  repoId: z.string().min(1),
  worktreeId: z.string().min(1),
  diffHash: z.string().min(1),
  createdAt: z.number(),
  filesTouched: z.array(z.string().min(1)),
  symbols: z.object({
    added: z.array(z.string()),
    modified: z.array(z.string()),
    removed: z.array(z.string())
  }),
  surfaces: z.array(contractSurfaceSchema),
  semanticSummary: z.string(),
  contractChanges: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  source: z.enum(["heuristic", "openai", "mixed"])
});
export type Fingerprint = z.infer<typeof fingerprintSchema>;

export const conflictTypeSchema = z.enum([
  "schema",
  "api",
  "component",
  "type",
  "intent",
  "unknown"
]);
export type ConflictType = z.infer<typeof conflictTypeSchema>;

export const tokenCostEstimateSchema = z.object({
  estimatedTokens: z.number().int().min(0),
  formula: z.string().min(1),
  inputs: z.object({
    filesTouched: z.number().int().min(0),
    touchedSurfaces: z.number().int().min(0),
    confidence: z.number().min(0).max(1),
    riskMultiplier: z.number().min(0),
    reworkMultiplier: z.number().min(0)
  })
});
export type TokenCostEstimate = z.infer<typeof tokenCostEstimateSchema>;

export const debateVerdictSchema = z.object({
  verdict: z.enum(["blocking", "notice", "compatible"]),
  confidence: z.number().min(0).max(1),
  proposer: z.string().min(1),
  skeptic: z.string().min(1),
  judge: z.string().min(1),
  evidence: z.array(z.string().min(1)).default([]),
  directions: z.array(z.string().min(1)).default([])
});
export type DebateVerdict = z.infer<typeof debateVerdictSchema>;

export const conflictSchema = z.object({
  id: z.string().min(1),
  repoId: z.string().min(1),
  status: conflictStatusSchema,
  risk: riskLevelSchema,
  confidence: z.number().min(0).max(1),
  type: conflictTypeSchema,
  title: z.string().min(1),
  summary: z.string().min(1),
  primarySurface: z.string().min(1).default("shared surface"),
  affectedWorktreeIds: z.array(z.string().min(1)),
  affectedSurfaces: z.array(z.string().min(1)),
  evidence: z.array(z.string().min(1)),
  riskReasons: z
    .array(
      z.object({
        label: z.string().min(1),
        detail: z.string().min(1),
        weight: z.number().min(0).max(100)
      })
    )
    .default([]),
  classification: compatibilityClassificationSchema.optional(),
  tokenCostEstimate: tokenCostEstimateSchema.optional(),
  debate: debateVerdictSchema.optional(),
  createdAt: z.number(),
  updatedAt: z.number()
});
export type RebaseConflict = z.infer<typeof conflictSchema>;

export const hookEventKindSchema = z.enum([
  "session_start",
  "user_prompt_submit",
  "pre_tool_use",
  "post_tool_use",
  "stop",
  "session_end",
  "checkpoint"
]);
export type HookEventKind = z.infer<typeof hookEventKindSchema>;

export const hookEventSchema = z.object({
  id: z.string().min(1),
  repoId: z.string().min(1),
  sessionId: z.string().min(1),
  worktreeId: z.string().min(1).nullable(),
  agentKind: z.enum(["codex", "claude", "unknown"]),
  cwd: z.string().min(1),
  kind: hookEventKindSchema,
  receivedAt: z.number(),
  prompt: z.string().optional(),
  toolName: z.string().optional(),
  command: z.string().optional(),
  outcome: z.string().optional(),
  filePaths: z.array(z.string().min(1)).default([]),
  metadata: z.record(z.string(), z.unknown()).default({})
});
export type HookEvent = z.infer<typeof hookEventSchema>;

export const evidencePacketSchema = z.object({
  id: z.string().min(1),
  repoId: z.string().min(1),
  sessionId: z.string().min(1),
  worktreeId: z.string().min(1).nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  expiresAt: z.number(),
  source: z.enum(["hooks", "mcp", "watcher", "mixed"]),
  promptSummary: z.string().optional(),
  planSummary: z.string().optional(),
  hookEvents: z.array(hookEventSchema).default([]),
  git: z.object({
    branch: z.string().nullable(),
    headSha: z.string().nullable(),
    mergeBase: z.string().nullable(),
    diffHash: z.string().nullable(),
    filesTouched: z.array(z.string().min(1)).default([]),
    stats: z.object({
      filesChanged: z.number().int().min(0),
      insertions: z.number().int().min(0),
      deletions: z.number().int().min(0)
    })
  }),
  surfaces: z.array(contractSurfaceSchema).default([]),
  decisionHistory: z
    .array(
      z.object({
        id: z.string().min(1),
        conflictId: z.string().min(1),
        summary: z.string().min(1),
        createdAt: z.number()
      })
    )
    .default([]),
  privacy: z.object({
    retentionDays: z.number().int().positive().default(3),
    redactions: z.array(z.string().min(1)).default([]),
    cloudEligible: z.boolean().default(false)
  })
});
export type EvidencePacket = z.infer<typeof evidencePacketSchema>;

export const cloudEscalationPacketSchema = z.object({
  id: z.string().min(1),
  repoId: z.string().min(1),
  conflictId: z.string().min(1).optional(),
  evidencePacketIds: z.array(z.string().min(1)).default([]),
  provider: z.string().min(1),
  reason: z.string().min(1),
  status: z.enum(["candidate", "sent", "failed"]),
  redactions: z.array(z.string().min(1)).default([]),
  redactedContext: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.number(),
  sentAt: z.number().optional()
});
export type CloudEscalationPacket = z.infer<
  typeof cloudEscalationPacketSchema
>;

export const graphNodeKindSchema = z.enum([
  "repo",
  "worktree",
  "agent",
  "file",
  "surface",
  "conflict",
  "decision",
  "episode",
  "work_order"
]);
export type GraphNodeKind = z.infer<typeof graphNodeKindSchema>;

export const graphEdgeKindSchema = z.enum([
  "contains",
  "runs_in",
  "touches",
  "affects",
  "decides",
  "relates_to"
]);
export type GraphEdgeKind = z.infer<typeof graphEdgeKindSchema>;

export const graphNodeSchema = z.object({
  id: z.string().min(1),
  repoId: z.string().min(1),
  kind: graphNodeKindSchema,
  label: z.string().min(1),
  refId: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  updatedAt: z.number()
});
export type RebaseGraphNode = z.infer<typeof graphNodeSchema>;

export const graphEdgeSchema = z.object({
  id: z.string().min(1),
  repoId: z.string().min(1),
  sourceId: z.string().min(1),
  targetId: z.string().min(1),
  kind: graphEdgeKindSchema,
  metadata: z.record(z.string(), z.unknown()).default({}),
  updatedAt: z.number()
});
export type RebaseGraphEdge = z.infer<typeof graphEdgeSchema>;

export const contractPublicationSchema = z.object({
  id: z.string().min(1),
  repoId: z.string().min(1),
  conflictId: z.string().min(1),
  ownerAgentSessionId: z.string().min(1),
  surface: z.string().min(1),
  shapeSummary: z.string().min(1).max(2000),
  files: z.array(z.string().min(1)).default([]),
  createdAt: z.number()
});
export type ContractPublication = z.infer<typeof contractPublicationSchema>;

export const interventionDirectiveRoleSchema = z.enum([
  "contract_owner",
  "integration_owner",
  "adapter",
  "pause_only",
  "compatibility_owner"
]);
export type InterventionDirectiveRole = z.infer<
  typeof interventionDirectiveRoleSchema
>;

export const mergeContractSchema = z.object({
  id: z.string().min(1),
  repoId: z.string().min(1),
  episodeId: z.string().min(1),
  surface: z.string().min(1),
  ownerAgentSessionId: z.string().min(1).optional(),
  summary: z.string().min(1).max(4000),
  files: z.array(z.string().min(1)).default([]),
  sourcePublicationId: z.string().min(1).optional(),
  updatedAt: z.number()
});
export type MergeContract = z.infer<typeof mergeContractSchema>;

export const coordinationEpisodeSchema = z.object({
  id: z.string().min(1),
  repoId: z.string().min(1),
  surface: z.string().min(1),
  status: z.enum([
    "open",
    "coordinating",
    "coordinated",
    "verifying",
    "safe",
    "blocked",
    "resolved"
  ]),
  risk: riskLevelSchema,
  confidence: z.number().min(0).max(1),
  affectedWorktreeIds: z.array(z.string().min(1)),
  affectedAgentSessionIds: z.array(z.string().min(1)),
  conflictIds: z.array(z.string().min(1)),
  ownerAgentSessionId: z.string().min(1).optional(),
  mergeContract: mergeContractSchema.optional(),
  rocketRideRunIds: z.array(z.string().min(1)).default([]),
  createdAt: z.number(),
  updatedAt: z.number()
});
export type CoordinationEpisode = z.infer<typeof coordinationEpisodeSchema>;

export const mergeRiskStatusSchema = z.enum([
  "safe",
  "warning",
  "blocked",
  "unknown"
]);
export type MergeRiskStatus = z.infer<typeof mergeRiskStatusSchema>;

export const predictedMergeConflictSchema = z.object({
  id: z.string().min(1),
  risk: riskLevelSchema,
  reasonCode: z.string().min(1),
  summary: z.string().min(1).max(1000),
  files: z.array(z.string().min(1)).default([]),
  symbols: z.array(z.string().min(1)).default([]),
  affectedWorktreeIds: z.array(z.string().min(1)).default([]),
  evidence: z.array(z.string().min(1)).default([]),
  blocking: z.boolean()
});
export type PredictedMergeConflict = z.infer<
  typeof predictedMergeConflictSchema
>;

export const mergeRiskEvidenceSchema = z.object({
  label: z.string().min(1),
  detail: z.string().min(1).max(1000),
  files: z.array(z.string().min(1)).default([]),
  worktreeIds: z.array(z.string().min(1)).default([])
});
export type MergeRiskEvidence = z.infer<typeof mergeRiskEvidenceSchema>;

export const mergeRiskAssessmentSchema = z
  .object({
    id: z.string().min(1),
    repoId: z.string().min(1),
    episodeId: z.string().min(1),
    status: mergeRiskStatusSchema,
    risk: riskLevelSchema,
    safe: z.boolean(),
    diffHash: z.string().min(1),
    rocketRideRunId: z.string().min(1).optional(),
    predictedConflicts: z.array(predictedMergeConflictSchema).default([]),
    warnings: z.array(z.string().min(1)).default([]),
    requiredWorkOrders: z.array(z.string().min(1)).default([]),
    evidence: z.array(mergeRiskEvidenceSchema).default([]),
    createdAt: z.number()
  })
  .superRefine((assessment, context) => {
    const hasBlockingConflict = assessment.predictedConflicts.some(
      (conflict) => conflict.blocking
    );
    if (assessment.safe && hasBlockingConflict) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Merge risk cannot be safe while blocking predicted conflicts remain",
        path: ["safe"]
      });
    }
    if (assessment.safe && assessment.risk === "high") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Merge risk cannot be safe while risk is high",
        path: ["risk"]
      });
    }
  });
export type MergeRiskAssessment = z.infer<typeof mergeRiskAssessmentSchema>;

export const coordinationPlanSchema = z.object({
  source: z.enum(["openai", "deterministic"]),
  strategy: z.enum([
    "split_ownership",
    "integration_owner",
    "pause",
    "proceed"
  ]),
  rationale: z.string().min(1).max(2000),
  ownerAgentSessionId: z.string().min(1).optional(),
  integrationOwnerAgentSessionId: z.string().min(1).optional(),
  workOrderIds: z.array(z.string().min(1)).default([]),
  requiredTerms: z.array(z.string().min(1)).default([]),
  validationChecklist: z.array(z.string().min(1)).default([])
});
export type CoordinationPlan = z.infer<typeof coordinationPlanSchema>;

export const workOrderSchema = z.object({
  id: z.string().min(1),
  repoId: z.string().min(1),
  episodeId: z.string().min(1),
  agentSessionId: z.string().min(1),
  role: interventionDirectiveRoleSchema,
  status: z.enum([
    "queued",
    "active",
    "fetched",
    "acknowledged",
    "completed",
    "superseded"
  ]),
  revision: z.number().int().min(1),
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(2000),
  requiredContract: z.string().min(1).max(4000).optional(),
  allowedFiles: z.array(z.string().min(1)).default([]),
  blockedFiles: z.array(z.string().min(1)).default([]),
  sharedFiles: z.array(z.string().min(1)).default([]),
  nextCheckpoint: z.string().min(1).max(500),
  createdAt: z.number(),
  updatedAt: z.number(),
  deliveredAt: z.number().optional(),
  acknowledgedAt: z.number().optional()
});
export type WorkOrder = z.infer<typeof workOrderSchema>;

export const interventionDirectiveSchema = z.object({
  role: interventionDirectiveRoleSchema,
  conflict: z.string().min(1),
  peerAgentName: z.string().min(1).optional(),
  peerWorktreeId: z.string().min(1).optional(),
  peerIntentSummary: z.string().min(1).max(180).optional(),
  sharedSurfaces: z.array(z.string().min(1)).max(5).default([]),
  sharedFiles: z.array(z.string().min(1)).max(5).default([]),
  nextAction: z.string().min(1).max(500),
  planSteps: z.array(z.string().min(1)).max(5).optional()
});
export type InterventionDirective = z.infer<typeof interventionDirectiveSchema>;

export const advisorySchema = z.object({
  id: z.string().min(1),
  repoId: z.string().min(1),
  conflictId: z.string().min(1),
  options: z.array(
    z.object({
      id: z.string().min(1),
      title: z.string().min(1),
      direction: z.string().min(1),
      rationale: z.string().min(1),
      affectedSurfaces: z.array(z.string().min(1)),
      directives: z.array(interventionDirectiveSchema).optional()
    })
  ),
  source: z.enum(["heuristic", "openai"]),
  createdAt: z.number()
});
export type Advisory = z.infer<typeof advisorySchema>;

export const interventionSchema = z.object({
  id: z.string().min(1),
  repoId: z.string().min(1),
  conflictId: z.string().min(1),
  targetAgentSessionIds: z.array(z.string().min(1)),
  draft: z.string().min(1),
  editedDirection: z.string().min(1),
  directive: interventionDirectiveSchema.optional(),
  status: z.enum(["draft", "queued", "fetched", "acknowledged", "cancelled"]),
  createdAt: z.number(),
  sentAt: z.number().optional(),
  fetchedAt: z.number().optional(),
  acknowledgedAt: z.number().optional()
});
export type Intervention = z.infer<typeof interventionSchema>;

export const conflictDecisionSchema = z.object({
  id: z.string().min(1),
  repoId: z.string().min(1),
  conflictId: z.string().min(1),
  selectedOptionId: z.string().min(1),
  selectedOptionTitle: z.string().min(1),
  selectedOptionDirection: z.string().min(1),
  ownerAgentSessionId: z.string().min(1).optional(),
  createdBy: z.enum(["dashboard", "agent"]),
  status: z.enum(["active", "cancelled", "superseded"]),
  createdAt: z.number(),
  updatedAt: z.number()
});
export type ConflictDecision = z.infer<typeof conflictDecisionSchema>;

export const eventSchema = z.object({
  id: z.string().min(1),
  repoId: z.string().min(1),
  type: z.string().min(1),
  message: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.number()
});
export type RebaseEvent = z.infer<typeof eventSchema>;
