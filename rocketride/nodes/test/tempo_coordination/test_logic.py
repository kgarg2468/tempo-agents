import json
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LOGIC_PATH = ROOT / "tempo_coordination" / "logic.py"
spec = importlib.util.spec_from_file_location("tempo_coordination_logic", LOGIC_PATH)
assert spec is not None and spec.loader is not None
logic = importlib.util.module_from_spec(spec)
spec.loader.exec_module(logic)
run_operation = logic.run_operation


def test_fingerprint_operation_builds_typed_fingerprint():
    output = run_operation(
        "fingerprint",
        {
            "repoId": "repo-1",
            "worktreeId": "wt-a",
            "diffHash": "diff-a",
            "createdAt": 1778000000000,
            "files": [
                {
                    "path": "src/shared/task.ts",
                    "content": "export interface Task { id: string; label: string; }",
                }
            ],
            "diff": "diff --git a/src/shared/task.ts b/src/shared/task.ts",
        },
    )

    assert output["fingerprint"]["repoId"] == "repo-1"
    assert output["fingerprint"]["worktreeId"] == "wt-a"
    assert output["fingerprint"]["filesTouched"] == ["src/shared/task.ts"]
    assert output["fingerprint"]["surfaces"][0]["label"] == "Task type"


def test_fingerprint_operation_includes_enforced_contract_terms():
    output = run_operation(
        "fingerprint",
        {
            "repoId": "repo-1",
            "worktreeId": "wt-a",
            "diffHash": "diff-a",
            "createdAt": 1778000000000,
            "files": [
                {
                    "path": "src/shared/task.ts",
                    "content": (
                        "export interface Task { "
                        "id: string; title: string; label: string; "
                        "project: string | null; subtitle: string | null; "
                        "reminderAt: string | null; archived: boolean; "
                        "batchId?: string; }"
                    ),
                }
            ],
        },
    )

    fingerprint = output["fingerprint"]
    evidence = "\n".join(
        [
            fingerprint["semanticSummary"],
            *fingerprint["contractChanges"],
            *fingerprint["surfaces"][0]["evidence"],
        ]
    )
    for term in ["label", "project", "subtitle", "reminderAt", "archived", "batchId"]:
        assert term in evidence


def test_collision_operation_groups_shared_task_surface():
    output = run_operation(
        "collision",
        {
            "fingerprints": [
                fingerprint("fp-a", "wt-a"),
                fingerprint("fp-b", "wt-b"),
            ],
            "plans": [
                agent("agent-a", "wt-a", 1),
                agent("agent-b", "wt-b", 2),
            ],
            "activeDecisions": [],
        },
    )

    assert len(output["conflicts"]) == 1
    assert output["conflicts"][0]["risk"] == "high"
    assert output["episodes"][0]["ownerAgentSessionId"] == "agent-a"


def test_work_order_operation_creates_specific_owner_and_adapter_orders():
    output = run_operation(
        "work-order",
        {
            "conflicts": [conflict()],
            "episodes": [],
            "agents": [
                agent("agent-a", "wt-a", 1),
                agent("agent-b", "wt-b", 2),
            ],
            "decisions": [],
            "publications": [],
            "existingWorkOrders": [],
        },
    )

    roles = {order["agentSessionId"]: order["role"] for order in output["workOrders"]}
    assert roles == {"agent-a": "contract_owner", "agent-b": "adapter"}
    assert output["workOrders"][0]["allowedFiles"] == ["src/shared/task.ts"]


def test_merge_risk_operation_blocks_same_hunk_edits():
    output = run_operation(
        "merge-risk",
        {
            "repoId": "repo-1",
            "episode": episode(),
            "conflicts": [conflict()],
            "fingerprints": [
                fingerprint("fp-a", "wt-a"),
                fingerprint("fp-b", "wt-b"),
            ],
            "workOrders": [
                work_order("work-order-agent-a-r1", "agent-a", "queued"),
                work_order("work-order-agent-b-r1", "agent-b", "queued"),
            ],
            "diffs": [
                {
                    "worktreeId": "wt-a",
                    "diffHash": "diff-a",
                    "diff": "\n".join(
                        [
                            "diff --git a/src/shared/task.ts b/src/shared/task.ts",
                            "@@ -1,1 +1,1 @@",
                            "-export interface Task { id: string }",
                            "+export interface Task { id: string; label: string }",
                        ]
                    ),
                },
                {
                    "worktreeId": "wt-b",
                    "diffHash": "diff-b",
                    "diff": "\n".join(
                        [
                            "diff --git a/src/shared/task.ts b/src/shared/task.ts",
                            "@@ -1,1 +1,1 @@",
                            "-export interface Task { id: string }",
                            "+export interface Task { id: string; subtitle: string | null }",
                        ]
                    ),
                },
            ],
            "createdAt": 1778000000000,
        },
    )

    merge_risk = output["mergeRisk"]
    assert merge_risk["status"] == "blocked"
    assert merge_risk["risk"] == "high"
    assert merge_risk["safe"] is False
    assert merge_risk["predictedConflicts"][0]["reasonCode"] == "same_hunk"
    assert merge_risk["requiredWorkOrders"] == [
        "work-order-agent-a-r1",
        "work-order-agent-b-r1",
    ]


def test_merge_risk_operation_marks_completed_contract_safe():
    item = episode()
    item["status"] = "coordinated"
    item["mergeContract"] = {
        "id": "merge-contract-1",
        "repoId": "repo-1",
        "episodeId": "episode-1",
        "surface": "Task contract",
        "ownerAgentSessionId": "agent-a",
        "summary": "Task includes label and subtitle.",
        "files": ["src/shared/task.ts"],
        "sourcePublicationId": "publication-1",
        "updatedAt": 1778000000000,
    }
    output = run_operation(
        "merge-risk",
        {
            "repoId": "repo-1",
            "episode": item,
            "conflicts": [conflict()],
            "fingerprints": [
                fingerprint("fp-a", "wt-a"),
                fingerprint("fp-b", "wt-b"),
            ],
            "workOrders": [
                work_order("work-order-agent-a-r1", "agent-a", "completed"),
                work_order("work-order-agent-b-r1", "agent-b", "completed"),
            ],
            "diffs": [],
            "createdAt": 1778000000000,
        },
    )

    assert output["mergeRisk"]["status"] == "safe"
    assert output["mergeRisk"]["safe"] is True
    assert output["mergeRisk"]["predictedConflicts"] == []


def test_merge_risk_keeps_same_hunk_blocked_after_completed_work_orders():
    item = episode()
    item["status"] = "coordinated"
    item["mergeContract"] = {
        "id": "merge-contract-1",
        "repoId": "repo-1",
        "episodeId": "episode-1",
        "surface": "Task contract",
        "ownerAgentSessionId": "agent-a",
        "summary": "Task includes label and subtitle.",
        "files": ["src/shared/task.ts"],
        "sourcePublicationId": "publication-1",
        "updatedAt": 1778000000000,
    }

    output = run_operation(
        "merge-risk",
        {
            "repoId": "repo-1",
            "episode": item,
            "conflicts": [conflict()],
            "fingerprints": [
                fingerprint("fp-a", "wt-a"),
                fingerprint("fp-b", "wt-b"),
            ],
            "workOrders": [
                work_order("work-order-agent-a-r1", "agent-a", "completed"),
                work_order("work-order-agent-b-r1", "agent-b", "completed"),
            ],
            "diffs": [
                {
                    "worktreeId": "wt-a",
                    "diffHash": "diff-a",
                    "diff": "\n".join(
                        [
                            "diff --git a/src/shared/task.ts b/src/shared/task.ts",
                            "@@ -1,1 +1,1 @@",
                            "-export interface Task { id: string }",
                            "+export interface Task { id: string; label: string }",
                        ]
                    ),
                },
                {
                    "worktreeId": "wt-b",
                    "diffHash": "diff-b",
                    "diff": "\n".join(
                        [
                            "diff --git a/src/shared/task.ts b/src/shared/task.ts",
                            "@@ -1,1 +1,1 @@",
                            "-export interface Task { id: string }",
                            "+export interface Task { id: string; subtitle: string | null }",
                        ]
                    ),
                },
            ],
            "createdAt": 1778000000000,
        },
    )

    merge_risk = output["mergeRisk"]
    assert merge_risk["status"] == "blocked"
    assert merge_risk["safe"] is False
    assert merge_risk["predictedConflicts"][0]["reasonCode"] == "same_hunk"


def test_merge_risk_allows_same_hunk_when_final_file_hashes_match():
    item = episode()
    item["status"] = "coordinated"
    item["mergeContract"] = {
        "id": "merge-contract-1",
        "repoId": "repo-1",
        "episodeId": "episode-1",
        "surface": "Task contract",
        "ownerAgentSessionId": "agent-a",
        "summary": "Task includes label and subtitle.",
        "files": ["src/shared/task.ts"],
        "sourcePublicationId": "publication-1",
        "updatedAt": 1778000000000,
    }

    output = run_operation(
        "merge-risk",
        {
            "repoId": "repo-1",
            "episode": item,
            "conflicts": [conflict()],
            "fingerprints": [
                fingerprint("fp-a", "wt-a"),
                fingerprint("fp-b", "wt-b"),
            ],
            "workOrders": [
                work_order("work-order-agent-a-r1", "agent-a", "completed"),
                work_order("work-order-agent-b-r1", "agent-b", "completed"),
            ],
            "diffs": [
                {
                    "worktreeId": "wt-a",
                    "diffHash": "diff-a",
                    "fileHashes": {"src/shared/task.ts": "same-final-hash"},
                    "diff": "\n".join(
                        [
                            "diff --git a/src/shared/task.ts b/src/shared/task.ts",
                            "@@ -1,1 +1,1 @@",
                            "-export interface Task { id: string }",
                            "+export interface Task { id: string; label: string; subtitle: string | null }",
                        ]
                    ),
                },
                {
                    "worktreeId": "wt-b",
                    "diffHash": "diff-b",
                    "fileHashes": {"src/shared/task.ts": "same-final-hash"},
                    "diff": "\n".join(
                        [
                            "diff --git a/src/shared/task.ts b/src/shared/task.ts",
                            "@@ -1,1 +1,1 @@",
                            "-export interface Task { id: string }",
                            "+export interface Task { id: string; label: string; subtitle: string | null }",
                        ]
                    ),
                },
            ],
            "createdAt": 1778000000000,
        },
    )

    merge_risk = output["mergeRisk"]
    assert merge_risk["status"] == "safe"
    assert merge_risk["safe"] is True
    assert merge_risk["predictedConflicts"] == []


def test_work_order_operation_references_owner_snapshot_after_publication():
    output = run_operation(
        "work-order",
        {
            "conflicts": [conflict()],
            "episodes": [],
            "agents": [
                {**agent("agent-a", "wt-a", 1), "currentPlan": "Add label and project to tasks."},
                {**agent("agent-b", "wt-b", 2), "currentPlan": "Add subtitle and reminder time to tasks."},
            ],
            "decisions": [
                {
                    "id": "decision-1",
                    "repoId": "repo-1",
                    "conflictId": "conflict-1",
                    "selectedOptionId": "split-ownership",
                    "selectedOptionTitle": "Split ownership",
                    "selectedOptionDirection": "agent-a owns Task contract.",
                    "ownerAgentSessionId": "agent-a",
                    "createdBy": "agent",
                    "status": "active",
                    "createdAt": 1778000000000,
                    "updatedAt": 1778000000000,
                }
            ],
            "publications": [
                {
                    "id": "publication-1",
                    "repoId": "repo-1",
                    "conflictId": "conflict-1",
                    "ownerAgentSessionId": "agent-a",
                    "surface": "Task contract",
                    "shapeSummary": "Task includes label, project, subtitle, and reminderAt.",
                    "files": ["src/shared/task.ts"],
                    "snapshotSetId": "snapshot-1",
                    "fileSnapshots": [
                        {
                            "path": "src/shared/task.ts",
                            "sha256": "hash-1",
                            "content": "export interface Task {}",
                            "sizeBytes": 24,
                            "capturedAt": 1778000000000,
                        }
                    ],
                    "createdAt": 1778000000000,
                }
            ],
            "existingWorkOrders": [],
        },
    )

    adapter_order = next(
        order for order in output["workOrders"] if order["agentSessionId"] == "agent-b"
    )
    assert adapter_order["requiredSnapshotPublicationId"] == "publication-1"
    assert adapter_order["requiredFeatureTerms"] == ["subtitle", "reminderAt"]
    assert adapter_order["blockedFiles"] == []


def test_work_order_operation_uses_openai_plan_fixture_for_integration_owner(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setenv(
        "TEMPO_OPENAI_PLANNER_FIXTURE",
        json.dumps(
            {
                "strategy": "split_ownership",
                "rationale": "Labels owns the contract and integrates overlapping files.",
                "ownerAgentSessionId": "agent-a",
                "integrationOwnerAgentSessionId": "agent-a",
                "workOrders": [
                    {
                        "agentSessionId": "agent-a",
                        "role": "integration_owner",
                        "summary": "Converge shared task files to the combined shape.",
                        "allowedFiles": ["src/shared/task.ts"],
                        "requiredContract": "Task includes label and subtitle.",
                        "validationChecklist": ["No same-hunk blockers remain"],
                    },
                    {
                        "agentSessionId": "agent-b",
                        "role": "adapter",
                        "summary": "Adapt reminder work to the integrated shape.",
                        "allowedFiles": ["src/shared/task.ts"],
                        "requiredContract": "Task includes label and subtitle.",
                    },
                ],
            }
        ),
    )

    output = run_operation(
        "work-order",
        {
            "plannerMode": "required",
            "conflicts": [conflict()],
            "episodes": [],
            "agents": [
                agent("agent-a", "wt-a", 1),
                agent("agent-b", "wt-b", 2),
            ],
            "decisions": [],
            "publications": [],
            "existingWorkOrders": [],
        },
    )

    assert output["coordinationPlan"]["source"] == "openai"
    roles = {order["agentSessionId"]: order["role"] for order in output["workOrders"]}
    assert roles == {"agent-a": "integration_owner", "agent-b": "adapter"}
    assert output["workOrders"][0]["allowedFiles"] == ["src/shared/task.ts"]


def test_operation_accepts_json_text_payloads():
    output = run_operation(
        "merge-risk",
        json.dumps({"episodes": [], "workOrders": []}),
    )

    assert output["mergeRisk"]["safe"] is True


def test_operation_accepts_rocketride_text_wrapped_payloads():
    output = run_operation(
        "fingerprint",
        {
            "text": [
                json.dumps(
                    {
                        "repoId": "repo-1",
                        "worktreeId": "wt-a",
                        "diffHash": "diff-a",
                        "files": [
                            {
                                "path": "src/shared/task.ts",
                                "content": "export interface Task { id: string }",
                            }
                        ],
                    }
                )
            ]
        },
    )

    assert output["fingerprint"]["repoId"] == "repo-1"


def fingerprint(identifier, worktree_id):
    return {
        "id": identifier,
        "repoId": "repo-1",
        "worktreeId": worktree_id,
        "diffHash": f"diff-{worktree_id}",
        "createdAt": 1778000000000,
        "filesTouched": ["src/shared/task.ts"],
        "symbols": {"added": [], "modified": ["Task"], "removed": []},
        "surfaces": [
            {
                "id": "task-type",
                "label": "Task type",
                "kind": "type",
                "files": ["src/shared/task.ts"],
                "confidence": 0.9,
                "evidence": ["Task interface"],
            }
        ],
        "semanticSummary": "Task type changed.",
        "contractChanges": ["Task type"],
        "confidence": 0.9,
        "source": "heuristic",
    }


def conflict():
    return {
        "id": "conflict-1",
        "repoId": "repo-1",
        "status": "open",
        "risk": "high",
        "confidence": 0.9,
        "type": "type",
        "title": "Task contract overlap",
        "summary": "Two worktrees are changing Task contract.",
        "primarySurface": "Task contract",
        "affectedWorktreeIds": ["wt-a", "wt-b"],
        "affectedSurfaces": ["Task type"],
        "evidence": ["File overlap: src/shared/task.ts"],
        "riskReasons": [],
        "createdAt": 1778000000000,
        "updatedAt": 1778000000000,
    }


def episode():
    return {
        "id": "episode-1",
        "repoId": "repo-1",
        "surface": "Task contract",
        "status": "coordinating",
        "risk": "high",
        "confidence": 0.9,
        "affectedWorktreeIds": ["wt-a", "wt-b"],
        "affectedAgentSessionIds": ["agent-a", "agent-b"],
        "conflictIds": ["conflict-1"],
        "ownerAgentSessionId": "agent-a",
        "rocketRideRunIds": [],
        "createdAt": 1778000000000,
        "updatedAt": 1778000000000,
    }


def work_order(identifier, agent_id, status):
    return {
        "id": identifier,
        "repoId": "repo-1",
        "episodeId": "episode-1",
        "agentSessionId": agent_id,
        "role": "contract_owner" if agent_id == "agent-a" else "adapter",
        "status": status,
        "revision": 1,
        "title": "Coordinate Task contract",
        "summary": "Coordinate Task contract.",
        "requiredContract": "Task contract",
        "allowedFiles": ["src/shared/task.ts"],
        "blockedFiles": [],
        "sharedFiles": ["src/shared/task.ts"],
        "nextCheckpoint": "Checkpoint after adapting.",
        "createdAt": 1778000000000,
        "updatedAt": 1778000000000,
    }


def agent(identifier, worktree_id, joined_at):
    return {
        "id": identifier,
        "repoId": "repo-1",
        "worktreeId": worktree_id,
        "agentKind": "codex",
        "coordinationRole": "feature",
        "cwd": f"/tmp/{worktree_id}",
        "displayName": identifier,
        "lastCheckpointAt": 1778000000000,
        "joinedAt": joined_at,
    }
