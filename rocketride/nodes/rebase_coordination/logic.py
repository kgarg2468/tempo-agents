import hashlib
import json
import os
import re
import urllib.error
import urllib.request
from typing import Any


class RebaseCoordinationError(Exception):
    pass


CONTRACT_KINDS = {"schema", "model", "migration", "type", "dto", "api"}
LOW_SIGNAL_KINDS = {"test", "utility", "unknown"}
ENFORCED_CONTRACT_TERMS = {
    "label",
    "project",
    "subtitle",
    "reminderAt",
    "archived",
    "batchId",
}


def run_operation(operation: str | None, payload: Any) -> dict[str, Any]:
    value = unwrap_payload(parse_payload(payload))
    if not isinstance(value, dict):
        raise RebaseCoordinationError("Rebase coordination input must be a JSON object")

    op = operation or value.get("operation")
    if op == "fingerprint":
        return {"fingerprint": build_fingerprint(value)}
    if op == "collision":
        conflicts = detect_conflicts(value.get("fingerprints", []))
        episodes = build_coordination(value | {"conflicts": conflicts})["episodes"]
        return {"conflicts": conflicts, "episodes": episodes}
    if op == "work-order":
        return build_coordination(value)
    if op == "merge-risk":
        return {"mergeRisk": build_merge_risk(value)}

    raise RebaseCoordinationError(f"Unsupported Rebase coordination operation: {op}")


def parse_payload(payload: Any) -> Any:
    if isinstance(payload, (bytes, bytearray)):
        payload = payload.decode("utf-8")
    if isinstance(payload, str):
        text = payload.strip()
        if not text:
            raise RebaseCoordinationError("Rebase coordination input was empty")
        return json.loads(text)
    return payload


def unwrap_payload(value: Any) -> Any:
    queue = [value]
    seen = set()
    fallback = value
    while queue:
        current = queue.pop(0)
        marker = id(current)
        if marker in seen:
            continue
        seen.add(marker)
        current = parse_payload(current) if isinstance(current, (str, bytes, bytearray)) else current
        if isinstance(current, dict):
            if has_rebase_input_shape(current):
                return current
            fallback = current
            for key in ("input", "payload", "body", "data", "response", "text", "value"):
                if key in current:
                    queue.append(current[key])
        elif isinstance(current, list):
            queue.extend(current)
    return fallback


def has_rebase_input_shape(value: dict[str, Any]) -> bool:
    return any(
        key in value
        for key in (
            "repoId",
            "fingerprints",
            "conflicts",
            "episodes",
            "workOrders",
            "mergeRisk",
        )
    )


def build_fingerprint(value: dict[str, Any]) -> dict[str, Any]:
    repo_id = require_text(value, "repoId")
    worktree_id = require_text(value, "worktreeId")
    diff_hash = require_text(value, "diffHash")
    files = normalize_files(value.get("files", []))
    surfaces = extract_surfaces(files)
    symbols = extract_symbols(files)
    contract_terms = extract_contract_terms(files)
    if contract_terms:
        add_terms_to_surface_evidence(surfaces, contract_terms)
    surface_labels = [surface["label"] for surface in surfaces]
    files_touched = sorted(file["path"] for file in files)
    if surface_labels:
        summary = f"Changes touch {', '.join(surface_labels)}."
    else:
        summary = f"Changes touch {', '.join(files_touched)}."
    if contract_terms:
        summary = f"{summary} Contract terms: {', '.join(contract_terms)}."

    return {
        "id": stable_id(f"{worktree_id}:{diff_hash}"),
        "repoId": repo_id,
        "worktreeId": worktree_id,
        "diffHash": diff_hash,
        "createdAt": number_or_default(value.get("createdAt"), 1778000000000),
        "filesTouched": files_touched,
        "symbols": symbols,
        "surfaces": surfaces,
        "semanticSummary": summary,
        "contractChanges": unique_in_order([*surface_labels, *contract_terms]),
        "confidence": 0.72 if surfaces else 0.45,
        "source": "heuristic",
    }


def normalize_files(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    files: list[dict[str, str]] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        path = item.get("path")
        content = item.get("content")
        if isinstance(path, str):
            files.append({"path": path, "content": content if isinstance(content, str) else ""})
    return files


def extract_surfaces(files: list[dict[str, str]]) -> list[dict[str, Any]]:
    by_id: dict[str, dict[str, Any]] = {}
    for file in files:
        for surface in extract_file_surfaces(file):
            existing = by_id.get(surface["id"])
            if existing:
                existing["files"] = sorted(set(existing["files"] + surface["files"]))
                existing["evidence"] = sorted(set(existing["evidence"] + surface["evidence"]))
                existing["confidence"] = max(existing["confidence"], surface["confidence"])
            else:
                by_id[surface["id"]] = surface
    return sorted(by_id.values(), key=lambda surface: surface["label"])


def extract_file_surfaces(file: dict[str, str]) -> list[dict[str, Any]]:
    lower_path = file["path"].lower()
    path_kind = classify_path(lower_path)
    surfaces = []
    for name in extract_likely_names(file["content"], file["path"]):
        kind = choose_kind_for_name(name, path_kind, lower_path)
        surfaces.append(make_surface(name, kind, file["path"], path_evidence(lower_path, kind)))

    if not surfaces and path_kind != "unknown":
        surfaces.append(
            make_surface(
                fallback_label_from_path(file["path"], path_kind),
                path_kind,
                file["path"],
                [f"{path_kind} path"],
                0.55,
            )
        )
    return surfaces


def classify_path(lower_path: str) -> str:
    if re.search(r"(schema|model|entity|migration|drizzle|prisma)", lower_path):
        return "migration" if "migration" in lower_path else "schema"
    if re.search(r"(route|routes|api|controller|handler|endpoint)", lower_path):
        return "api"
    if re.search(r"(dto|request|response|payload)", lower_path):
        return "dto"
    if re.search(r"(component|components|tsx$|jsx$)", lower_path):
        return "component"
    if re.search(r"(types|interfaces|contract)", lower_path):
        return "type"
    if re.search(r"(utils|util|helpers)", lower_path):
        return "utility"
    if re.search(r"(test|spec)", lower_path):
        return "test"
    return "unknown"


def extract_likely_names(content: str, file_path: str) -> list[str]:
    names = set()
    patterns = [
        r"\binterface\s+([A-Z][A-Za-z0-9_]*)",
        r"\btype\s+([A-Z][A-Za-z0-9_]*)",
        r"\bclass\s+([A-Z][A-Za-z0-9_]*)",
        r"\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)",
        r"\bdef\s+([A-Za-z_][A-Za-z0-9_]*)",
        r"\bpublic\s+(?:class|interface|record)\s+([A-Z][A-Za-z0-9_]*)",
    ]
    for pattern in patterns:
        for match in re.finditer(pattern, content):
            names.add(normalize_name(match.group(1)))

    for match in re.finditer(r"\bsqliteTable\(\s*[\"']([A-Za-z0-9_-]+)[\"']", content):
        names.add(table_name_to_model_name(match.group(1)))

    basename = file_path.rsplit("/", 1)[-1]
    base = re.sub(r"\.[^.]+$", "", basename)
    if re.match(r"^[A-Z][A-Za-z0-9_]*(Card|Props|Dto|DTO|Controller|Service|Model)?$", base):
        names.add(normalize_name(base))

    return sorted(names)


def normalize_name(name: str) -> str:
    return re.sub(r"Props$", "", re.sub(r"DTO$", "Dto", name))


def table_name_to_model_name(name: str) -> str:
    singular = re.sub(r"s$", "", name)
    return "".join(part[:1].upper() + part[1:] for part in re.split(r"[-_]", singular) if part)


def choose_kind_for_name(name: str, path_kind: str, lower_path: str) -> str:
    if name.endswith("Props") or "card" in lower_path or "component" in lower_path:
        return "component"
    if name.endswith("Dto") or path_kind == "dto":
        return "dto"
    if name.endswith("Controller") or path_kind == "api":
        return "api"
    return path_kind if path_kind != "unknown" else "type"


def make_surface(
    raw_name: str,
    kind: str,
    file_path: str,
    evidence: list[str],
    confidence: float = 0.75,
) -> dict[str, Any]:
    base_name = re.sub(r"(Card|Controller|Dto|DTO)$", lambda match: match.group(1), raw_name)
    label = label_for(base_name, kind, raw_name)
    return {
        "id": slug(label),
        "label": label,
        "kind": kind,
        "files": [file_path],
        "confidence": confidence,
        "evidence": evidence,
    }


def label_for(base_name: str, kind: str, raw_name: str) -> str:
    if kind in {"schema", "model", "migration"}:
        return f"{strip_suffixes(base_name)} model"
    if kind == "api":
        return f"{strip_suffixes(base_name)} API"
    if kind == "dto":
        return f"{strip_suffixes(base_name)} DTO"
    if kind == "component":
        if "Card" in raw_name:
            return f"{strip_suffixes(raw_name)} props"
        return f"{strip_suffixes(base_name)} component"
    if kind == "type":
        return f"{strip_suffixes(base_name)} type"
    return f"{strip_suffixes(base_name)} {kind}"


def strip_suffixes(name: str) -> str:
    return re.sub(r"(Props|Controller|Dto|DTO)$", "", name)


def fallback_label_from_path(file_path: str, kind: str) -> str:
    base = re.sub(r"\.[^.]+$", "", file_path.rsplit("/", 1)[-1])
    base = re.sub(r"[-_](.)", lambda match: match.group(1).upper(), base)
    return f"{base} {kind}"


def path_evidence(lower_path: str, kind: str) -> list[str]:
    evidence = [f"{kind} path"]
    if lower_path.endswith((".ts", ".tsx")):
        evidence.append("TS/JS file")
    if lower_path.endswith(".py"):
        evidence.append("Python file")
    if lower_path.endswith(".java"):
        evidence.append("Java file")
    return evidence


def extract_symbols(files: list[dict[str, str]]) -> dict[str, list[str]]:
    modified = set()
    patterns = [
        r"\binterface\s+([A-Z][A-Za-z0-9_]*)",
        r"\btype\s+([A-Z][A-Za-z0-9_]*)",
        r"\bclass\s+([A-Z][A-Za-z0-9_]*)",
        r"\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)",
        r"\bdef\s+([A-Za-z_][A-Za-z0-9_]*)",
        r"\bpublic\s+(?:class|interface|record)\s+([A-Z][A-Za-z0-9_]*)",
    ]
    for file in files:
        for pattern in patterns:
            for match in re.finditer(pattern, file["content"]):
                modified.add(match.group(1))
    return {"added": [], "modified": sorted(modified), "removed": []}


def extract_contract_terms(files: list[dict[str, str]]) -> list[str]:
    found = set()
    for file in files:
        content = file["content"]
        for term in ENFORCED_CONTRACT_TERMS:
            if re.search(rf"\b{re.escape(term)}\b", content):
                found.add(term)
    return sorted(found)


def add_terms_to_surface_evidence(
    surfaces: list[dict[str, Any]],
    contract_terms: list[str],
) -> None:
    for surface in surfaces:
        evidence = list(surface.get("evidence", []))
        evidence.extend(f"Contract term: {term}" for term in contract_terms)
        surface["evidence"] = unique_in_order(evidence)


def detect_conflicts(fingerprints_value: Any) -> list[dict[str, Any]]:
    fingerprints = fingerprints_value if isinstance(fingerprints_value, list) else []
    sorted_fingerprints = sorted(
        [item for item in fingerprints if isinstance(item, dict)],
        key=lambda item: str(item.get("id", "")),
    )
    conflicts = []
    for index, left in enumerate(sorted_fingerprints):
        for right in sorted_fingerprints[index + 1 :]:
            if left.get("worktreeId") == right.get("worktreeId"):
                continue
            conflict = compare_fingerprints(left, right)
            if conflict:
                conflicts.append(conflict)
    return conflicts


def compare_fingerprints(left: dict[str, Any], right: dict[str, Any]) -> dict[str, Any] | None:
    left_surfaces = as_list(left.get("surfaces"))
    right_surfaces = as_list(right.get("surfaces"))
    shared_surface_labels = intersection(
        [surface.get("label") for surface in left_surfaces if isinstance(surface, dict)],
        [surface.get("label") for surface in right_surfaces if isinstance(surface, dict)],
    )
    shared_files = intersection(as_list(left.get("filesTouched")), as_list(right.get("filesTouched")))
    shared_symbols = intersection(
        as_list(left.get("symbols", {}).get("added")) + as_list(left.get("symbols", {}).get("modified")),
        as_list(right.get("symbols", {}).get("added")) + as_list(right.get("symbols", {}).get("modified")),
    )
    if not shared_surface_labels and not shared_files and not shared_symbols:
        return None

    shared_surfaces = [
        surface
        for surface in left_surfaces + right_surfaces
        if isinstance(surface, dict) and surface.get("label") in shared_surface_labels
    ]
    assessment = assess_risk(shared_surfaces, shared_files, shared_symbols)
    if assessment["risk"] == "low":
        return None

    kinds = {surface.get("kind") for surface in shared_surfaces if isinstance(surface, dict)}
    conflict_type = "schema" if "schema" in kinds else "api" if "api" in kinds else "component" if "component" in kinds else "type" if kinds & {"type", "dto"} else "unknown"
    created_at = max(number_or_default(left.get("createdAt"), 0), number_or_default(right.get("createdAt"), 0))
    evidence = [
        *[
            f"{reason['label']}: {reason['detail']}"
            for reason in assessment["riskReasons"]
        ],
        *[f"Both fingerprints touch {surface}" for surface in shared_surface_labels],
        *[f"File overlap: {file}" for file in shared_files],
        *[f"Both worktrees changed {symbol}" for symbol in shared_symbols],
    ]
    return {
        "id": conflict_id(left, right, assessment["primarySurface"]),
        "repoId": str(left.get("repoId") or right.get("repoId") or "repo"),
        "status": "open",
        "risk": assessment["risk"],
        "confidence": clamp(max(float(left.get("confidence", 0)), float(right.get("confidence", 0))) - (0.03 if assessment["risk"] == "high" else 0.08)),
        "type": conflict_type,
        "title": f"{assessment['primarySurface']} overlap",
        "summary": f"Two worktrees are changing {assessment['primarySurface']}.",
        "primarySurface": assessment["primarySurface"],
        "affectedWorktreeIds": [str(left.get("worktreeId")), str(right.get("worktreeId"))],
        "affectedSurfaces": assessment["affectedSurfaces"] or [assessment["primarySurface"]],
        "evidence": evidence,
        "riskReasons": assessment["riskReasons"],
        "createdAt": created_at,
        "updatedAt": created_at,
    }


def assess_risk(
    shared_surfaces: list[dict[str, Any]],
    shared_files: list[str],
    shared_symbols: list[str],
) -> dict[str, Any]:
    affected_surfaces = sorted({str(surface.get("label")) for surface in shared_surfaces})
    roots = contract_root_counts(shared_surfaces)
    top_root = sorted(roots.items(), key=lambda item: (-item[1], item[0]))[0][0] if roots else None
    primary_surface = (
        f"{top_root} contract"
        if top_root
        else affected_surfaces[0] if affected_surfaces else shared_files[0] if shared_files else shared_symbols[0] if shared_symbols else "shared surface"
    )
    if top_root:
        return {
            "risk": "high",
            "primarySurface": primary_surface,
            "affectedSurfaces": affected_surfaces,
            "riskReasons": [
                {
                    "label": "Shared contract root",
                    "detail": f"Both worktrees touch {top_root} contract surfaces.",
                    "weight": 90,
                }
            ],
        }

    meaningful = next(
        (surface for surface in shared_surfaces if surface.get("kind") not in LOW_SIGNAL_KINDS),
        None,
    )
    if meaningful:
        return {
            "risk": "medium",
            "primarySurface": primary_surface,
            "affectedSurfaces": affected_surfaces,
            "riskReasons": [
                {
                    "label": "Shared surface",
                    "detail": f"Both worktrees touch {meaningful.get('label')}.",
                    "weight": 60,
                }
            ],
        }

    risky_file = next((file for file in shared_files if is_risky_file(file)), None)
    if risky_file:
        return {
            "risk": "medium",
            "primarySurface": primary_surface,
            "affectedSurfaces": affected_surfaces,
            "riskReasons": [
                {
                    "label": "Shared contract file",
                    "detail": f"Both worktrees changed {risky_file}.",
                    "weight": 55,
                }
            ],
        }

    if shared_symbols:
        return {
            "risk": "medium",
            "primarySurface": primary_surface,
            "affectedSurfaces": affected_surfaces,
            "riskReasons": [
                {
                    "label": "Shared symbol",
                    "detail": f"Both worktrees changed {shared_symbols[0]}.",
                    "weight": 50,
                }
            ],
        }

    return {"risk": "low", "primarySurface": primary_surface, "affectedSurfaces": affected_surfaces, "riskReasons": []}


def contract_root_counts(surfaces: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for surface in surfaces:
        if surface.get("kind") not in CONTRACT_KINDS:
            continue
        root = contract_root(str(surface.get("label", "")))
        if not root:
            continue
        counts[root] = counts.get(root, 0) + surface_weight(str(surface.get("kind")))
    return counts


def contract_root(label: str) -> str | None:
    if re.match(r"^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+API$", label):
        return None
    root = re.sub(r"\s+(model|type|DTO|API|contract)$", "", label, flags=re.IGNORECASE).strip()
    if not root or re.match(r"^(routecontext|schema|unknown)$", root, flags=re.IGNORECASE):
        return None
    if re.match(r"^[A-Z]+$", root):
        return None
    return root


def surface_weight(kind: str) -> int:
    if kind in {"schema", "model"}:
        return 100
    if kind == "migration":
        return 95
    if kind in {"type", "dto"}:
        return 90
    if kind == "api":
        return 80
    if kind == "component":
        return 60
    if kind == "utility":
        return 20
    if kind == "test":
        return 10
    return 25


def build_coordination(value: dict[str, Any]) -> dict[str, Any]:
    repo_id = infer_repo_id(value)
    conflicts = [conflict for conflict in as_list(value.get("conflicts")) if isinstance(conflict, dict) and conflict.get("status") == "open"]
    agents = [agent for agent in as_list(value.get("agents") or value.get("plans")) if isinstance(agent, dict)]
    decisions = [decision for decision in as_list(value.get("decisions") or value.get("activeDecisions")) if isinstance(decision, dict)]
    publications = [publication for publication in as_list(value.get("publications")) if isinstance(publication, dict)]
    existing_episodes = [
        episode
        for episode in as_list(value.get("episodes")) + as_list(value.get("existingEpisodes"))
        if isinstance(episode, dict)
    ]
    existing_work_orders = [order for order in as_list(value.get("existingWorkOrders")) if isinstance(order, dict)]
    created_at = number_or_default(value.get("createdAt"), 1778000000000)
    episodes = []
    work_orders = []

    for group in connected_conflict_groups(conflicts):
        affected_worktree_ids = sorted({worktree for conflict in group for worktree in as_list(conflict.get("affectedWorktreeIds"))})
        affected_agents = sorted(
            [agent for agent in agents if agent.get("worktreeId") in affected_worktree_ids],
            key=lambda agent: (number_or_default(agent.get("joinedAt"), 0), str(agent.get("displayName", "")), str(agent.get("id", ""))),
        )
        if len(affected_worktree_ids) < 2 or len(affected_agents) < 2:
            continue
        conflict_ids = sorted(str(conflict.get("id")) for conflict in group)
        surface = str(group[0].get("primarySurface") or "shared surface")
        episode_id = stable_id_parts("coordination-episode", repo_id, surface, "|".join(affected_worktree_ids))
        existing_episode = find_existing_episode(existing_episodes, episode_id, surface, affected_worktree_ids)
        owner_id = select_owner(group, affected_agents, decisions, existing_episode)
        merge_contract = build_merge_contract(repo_id, episode_id, surface, conflict_ids, owner_id, publications, created_at)
        coordinated = is_coordinated(episode_id, [str(agent.get("id")) for agent in affected_agents], merge_contract, existing_work_orders)
        episode = {
            "id": episode_id,
            "repoId": repo_id,
            "surface": surface,
            "status": "coordinated" if coordinated else "coordinating",
            "risk": "medium" if coordinated else highest_risk([str(conflict.get("risk", "low")) for conflict in group]),
            "confidence": max([float(conflict.get("confidence", 0)) for conflict in group] + [0]),
            "affectedWorktreeIds": affected_worktree_ids,
            "affectedAgentSessionIds": [str(agent.get("id")) for agent in affected_agents],
            "conflictIds": conflict_ids,
            "rocketRideRunIds": unique_in_order(as_list((existing_episode or {}).get("rocketRideRunIds"))),
            "createdAt": number_or_default((existing_episode or {}).get("createdAt"), created_at),
            "updatedAt": created_at,
        }
        if owner_id:
            episode["ownerAgentSessionId"] = owner_id
        if merge_contract:
            episode["mergeContract"] = merge_contract
        episodes.append(episode)

        if coordinated:
            continue
        for agent in affected_agents:
            work_orders.append(
                build_work_order(repo_id, episode, agent, owner_id, merge_contract, group, created_at, affected_agents)
            )

    result = {"episodes": episodes, "workOrders": work_orders}
    coordination_plan = build_openai_coordination_plan(value, result, created_at)
    if coordination_plan:
        result["workOrders"] = apply_coordination_plan_to_work_orders(
            result["workOrders"],
            coordination_plan,
            episodes,
            agents,
            created_at,
        )
        coordination_plan["workOrderIds"] = [
            str(order.get("id")) for order in result["workOrders"]
        ]
        result["coordinationPlan"] = coordination_plan
    return result


def build_merge_risk(value: dict[str, Any]) -> dict[str, Any]:
    repo_id = infer_repo_id(value)
    episode = merge_risk_episode(value, repo_id)
    episode_id = str(episode.get("id") or "episode-none")
    created_at = number_or_default(value.get("createdAt"), number_or_default(episode.get("updatedAt"), 1778000000000))
    work_orders = [
        order
        for order in as_list(value.get("workOrders"))
        if isinstance(order, dict) and str(order.get("episodeId")) == episode_id
    ]
    incomplete_work_order_ids = [
        str(order.get("id"))
        for order in work_orders
        if order.get("status") not in {"completed", "superseded"}
    ]
    conflicts = [
        conflict
        for conflict in as_list(value.get("conflicts"))
        if isinstance(conflict, dict)
        and (
            str(conflict.get("id")) in set(as_list(episode.get("conflictIds")))
            or not episode.get("conflictIds")
        )
    ]
    diffs = [diff for diff in as_list(value.get("diffs")) if isinstance(diff, dict)]
    fingerprints = [
        fingerprint
        for fingerprint in as_list(value.get("fingerprints"))
        if isinstance(fingerprint, dict)
        and str(fingerprint.get("worktreeId")) in set(as_list(episode.get("affectedWorktreeIds")))
    ]

    predicted = []
    evidence = []
    warnings = []
    predicted.extend(predicted_conflicts_from_diffs(repo_id, diffs, evidence, warnings))
    predicted.extend(
        predicted_conflicts_from_contracts(
            repo_id,
            episode,
            conflicts,
            fingerprints,
            evidence,
            bool(episode.get("mergeContract")),
        )
    )

    coordination_complete = bool(episode.get("mergeContract")) and (
        episode.get("status") in {"coordinated", "safe"}
        or (
            bool(work_orders)
            and all(order.get("status") in {"completed", "superseded"} for order in work_orders)
        )
    )
    if coordination_complete:
        predicted = [
            item
            for item in predicted
            if item.get("reasonCode")
            not in {"shared_contract_without_contract", "open_high_conflict"}
        ]
        incomplete_work_order_ids = []

    blocking_predictions = [
        item for item in predicted if item.get("risk") == "high" and item.get("blocking")
    ]
    if blocking_predictions or incomplete_work_order_ids:
        status = "blocked"
        risk = "high"
        safe = False
    elif predicted or warnings:
        status = "warning"
        risk = "medium"
        safe = True
    else:
        status = "safe"
        risk = "low"
        safe = True

    diff_hash = merge_risk_diff_hash(episode, fingerprints, diffs)
    return {
        "id": stable_id_parts("merge-risk", repo_id, episode_id, diff_hash, str(created_at)),
        "repoId": repo_id,
        "episodeId": episode_id,
        "status": status,
        "risk": risk,
        "safe": safe,
        "diffHash": diff_hash,
        "predictedConflicts": unique_predicted_conflicts(predicted),
        "warnings": unique_in_order(warnings),
        "requiredWorkOrders": unique_in_order(incomplete_work_order_ids),
        "evidence": evidence,
        "createdAt": created_at,
    }


def merge_risk_episode(value: dict[str, Any], repo_id: str) -> dict[str, Any]:
    episode = value.get("episode")
    if isinstance(episode, dict):
        return episode
    episodes = [item for item in as_list(value.get("episodes")) if isinstance(item, dict)]
    if episodes:
        return episodes[0]
    return {
        "id": "episode-none",
        "repoId": repo_id,
        "surface": "repo",
        "status": "safe",
        "risk": "low",
        "affectedWorktreeIds": [],
        "affectedAgentSessionIds": [],
        "conflictIds": [],
        "rocketRideRunIds": [],
        "createdAt": number_or_default(value.get("createdAt"), 1778000000000),
        "updatedAt": number_or_default(value.get("createdAt"), 1778000000000),
    }


def predicted_conflicts_from_diffs(
    repo_id: str,
    diffs: list[dict[str, Any]],
    evidence: list[dict[str, Any]],
    warnings: list[str],
) -> list[dict[str, Any]]:
    parsed = [parse_diff_input(diff) for diff in diffs]
    predicted = []
    for index, left in enumerate(parsed):
        for right in parsed[index + 1 :]:
            shared_files = sorted(set(left["files"]).intersection(right["files"]))
            for file_path in shared_files:
                if is_generated_path(file_path):
                    continue
                if left["huge"] or right["huge"] or file_path in left["binary"] or file_path in right["binary"]:
                    warnings.append(f"Unknown merge risk for binary or huge file {file_path}.")
                    continue
                if file_path in left["deleted"] or file_path in right["deleted"]:
                    predicted.append(
                        predicted_conflict(
                            repo_id,
                            "delete_vs_edit",
                            "high",
                            f"One worktree deletes {file_path} while another edits it.",
                            [file_path],
                            [],
                            [left["worktreeId"], right["worktreeId"]],
                            [f"Delete/edit overlap in {file_path}"],
                            True,
                        )
                    )
                    evidence.append(
                        merge_risk_evidence(
                            "Delete/edit overlap",
                            f"One worktree deletes {file_path} while another edits it.",
                            [file_path],
                            [left["worktreeId"], right["worktreeId"]],
                        )
                    )
                    continue
                if hunks_overlap(left["hunks"].get(file_path, []), right["hunks"].get(file_path, [])):
                    predicted.append(
                        predicted_conflict(
                            repo_id,
                            "same_hunk",
                            "high",
                            f"Two worktrees edit the same hunk in {file_path}.",
                            [file_path],
                            [],
                            [left["worktreeId"], right["worktreeId"]],
                            [f"Overlapping hunks in {file_path}"],
                            True,
                        )
                    )
                    evidence.append(
                        merge_risk_evidence(
                            "Shared hunk",
                            f"Both worktrees edit {file_path} in overlapping line ranges.",
                            [file_path],
                            [left["worktreeId"], right["worktreeId"]],
                        )
                    )
                else:
                    predicted.append(
                        predicted_conflict(
                            repo_id,
                            "same_file",
                            "medium",
                            f"Two worktrees edit {file_path} in different hunks.",
                            [file_path],
                            [],
                            [left["worktreeId"], right["worktreeId"]],
                            [f"Same file changed in {file_path}"],
                            False,
                        )
                    )
                    warnings.append(f"Multiple worktrees edit {file_path}; hunks do not overlap.")
    return predicted


def predicted_conflicts_from_contracts(
    repo_id: str,
    episode: dict[str, Any],
    conflicts: list[dict[str, Any]],
    fingerprints: list[dict[str, Any]],
    evidence: list[dict[str, Any]],
    has_contract: bool,
) -> list[dict[str, Any]]:
    predicted = []
    high_conflicts = [conflict for conflict in conflicts if conflict.get("risk") == "high"]
    if high_conflicts and not has_contract:
        files = sorted({file for fingerprint in fingerprints for file in as_list(fingerprint.get("filesTouched"))})
        symbols = sorted({
            symbol
            for fingerprint in fingerprints
            for symbol in as_list((fingerprint.get("symbols") or {}).get("added")) + as_list((fingerprint.get("symbols") or {}).get("modified"))
        })
        worktrees = as_list(episode.get("affectedWorktreeIds"))
        predicted.append(
            predicted_conflict(
                repo_id,
                "shared_contract_without_contract",
                "high",
                f"{episode.get('surface', 'Shared contract')} has no published compatible contract yet.",
                files,
                symbols,
                worktrees,
                [f"Open high-risk conflict: {conflict.get('title')}" for conflict in high_conflicts],
                True,
            )
        )
        evidence.append(
            merge_risk_evidence(
                "Missing merge contract",
                "A high-risk shared surface needs an owner contract before agents continue.",
                files,
                worktrees,
            )
        )
    return predicted


def parse_diff_input(value: dict[str, Any]) -> dict[str, Any]:
    diff = str(value.get("diff") or "")
    worktree_id = str(value.get("worktreeId") or "unknown-worktree")
    files = set()
    deleted = set()
    binary = set()
    hunks: dict[str, list[tuple[int, int]]] = {}
    current_file = None
    huge = len(diff) > 200_000
    for line in diff.splitlines():
        match = re.match(r"diff --git a/(.+?) b/(.+)$", line)
        if match:
            current_file = match.group(2)
            files.add(current_file)
            continue
        if current_file and line.startswith("deleted file mode"):
            deleted.add(current_file)
            continue
        if current_file and line.startswith("Binary files "):
            binary.add(current_file)
            continue
        hunk = re.match(r"@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@", line)
        if current_file and hunk:
            start = int(hunk.group(1))
            length = int(hunk.group(2) or "1")
            hunks.setdefault(current_file, []).append((start, start + max(length, 1) - 1))
    return {
        "worktreeId": worktree_id,
        "diffHash": str(value.get("diffHash") or stable_id(diff)),
        "files": sorted(files),
        "deleted": deleted,
        "binary": binary,
        "hunks": hunks,
        "huge": huge,
    }


def hunks_overlap(left: list[tuple[int, int]], right: list[tuple[int, int]]) -> bool:
    if not left or not right:
        return False
    for left_start, left_end in left:
        for right_start, right_end in right:
            if left_start <= right_end and right_start <= left_end:
                return True
    return False


def is_generated_path(file_path: str) -> bool:
    return bool(
        re.search(
            r"(^|/)(node_modules|dist|build|coverage|\.next|\.turbo|\.rebase)/|(\.tsbuildinfo|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$",
            file_path,
        )
    )


def predicted_conflict(
    repo_id: str,
    reason_code: str,
    risk: str,
    summary: str,
    files: list[str],
    symbols: list[str],
    worktree_ids: list[str],
    evidence: list[str],
    blocking: bool,
) -> dict[str, Any]:
    return {
        "id": stable_id_parts("predicted", repo_id, reason_code, "|".join(files), "|".join(worktree_ids)),
        "risk": risk,
        "reasonCode": reason_code,
        "summary": summary,
        "files": sorted(files),
        "symbols": sorted(symbols),
        "affectedWorktreeIds": unique_in_order(worktree_ids),
        "evidence": evidence,
        "blocking": blocking,
    }


def merge_risk_evidence(
    label: str,
    detail: str,
    files: list[str],
    worktree_ids: list[str],
) -> dict[str, Any]:
    return {
        "label": label,
        "detail": detail,
        "files": sorted(files),
        "worktreeIds": unique_in_order(worktree_ids),
    }


def unique_predicted_conflicts(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_id: dict[str, dict[str, Any]] = {}
    for item in items:
        by_id.setdefault(str(item.get("id")), item)
    return [by_id[key] for key in sorted(by_id)]


def merge_risk_diff_hash(
    episode: dict[str, Any],
    fingerprints: list[dict[str, Any]],
    diffs: list[dict[str, Any]],
) -> str:
    parts = [
        str(episode.get("id") or "episode-none"),
        *sorted(str(fingerprint.get("diffHash")) for fingerprint in fingerprints if fingerprint.get("diffHash")),
        *sorted(str(diff.get("diffHash")) for diff in diffs if diff.get("diffHash")),
    ]
    return stable_id_parts(*parts)


def connected_conflict_groups(conflicts: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    by_surface: dict[str, list[dict[str, Any]]] = {}
    for conflict in conflicts:
        by_surface.setdefault(str(conflict.get("primarySurface") or "shared surface"), []).append(conflict)

    groups = []
    for surface_conflicts in by_surface.values():
        remaining = {str(conflict.get("id")) for conflict in surface_conflicts}
        by_id = {str(conflict.get("id")): conflict for conflict in surface_conflicts}
        while remaining:
            first_id = sorted(remaining)[0]
            queue = [first_id]
            component_ids = set()
            component_worktrees = set()
            while queue:
                current_id = queue.pop(0)
                if current_id in component_ids:
                    continue
                conflict = by_id.get(current_id)
                if not conflict:
                    continue
                component_ids.add(current_id)
                remaining.discard(current_id)
                component_worktrees.update(as_list(conflict.get("affectedWorktreeIds")))
                for candidate in surface_conflicts:
                    candidate_id = str(candidate.get("id"))
                    if candidate_id not in remaining:
                        continue
                    if any(worktree in component_worktrees for worktree in as_list(candidate.get("affectedWorktreeIds"))):
                        queue.append(candidate_id)
            groups.append([by_id[conflict_id] for conflict_id in sorted(component_ids)])
    return sorted(groups, key=lambda group: str(group[0].get("primarySurface", "")) if group else "")


def select_owner(
    conflicts: list[dict[str, Any]],
    agents: list[dict[str, Any]],
    decisions: list[dict[str, Any]],
    existing_episode: dict[str, Any] | None,
) -> str | None:
    conflict_ids = {str(conflict.get("id")) for conflict in conflicts}
    active_decisions = sorted(
        [
            decision
            for decision in decisions
            if decision.get("status") == "active"
            and decision.get("ownerAgentSessionId")
            and decision.get("conflictId") in conflict_ids
        ],
        key=lambda decision: number_or_default(decision.get("updatedAt"), 0),
        reverse=True,
    )
    if active_decisions:
        return str(active_decisions[0]["ownerAgentSessionId"])
    existing_owner = (existing_episode or {}).get("ownerAgentSessionId")
    if existing_owner and any(agent.get("id") == existing_owner for agent in agents):
        return str(existing_owner)
    for conflict in conflicts:
        recommended = (conflict.get("classification") or {}).get("recommendedOwnerWorktreeId")
        if recommended:
            owner = next((agent for agent in agents if agent.get("worktreeId") == recommended), None)
            if owner:
                return str(owner.get("id"))
    return str(agents[0].get("id")) if agents else None


def build_merge_contract(
    repo_id: str,
    episode_id: str,
    surface: str,
    conflict_ids: list[str],
    owner_id: str | None,
    publications: list[dict[str, Any]],
    updated_at: int,
) -> dict[str, Any] | None:
    candidates = [
        publication
        for publication in publications
        if publication.get("conflictId") in conflict_ids
        and (not owner_id or publication.get("ownerAgentSessionId") == owner_id)
    ]
    if not candidates:
        return None
    publication = sorted(candidates, key=lambda item: number_or_default(item.get("createdAt"), 0), reverse=True)[0]
    return {
        "id": stable_id_parts("merge-contract", episode_id, str(publication.get("id"))),
        "repoId": repo_id,
        "episodeId": episode_id,
        "surface": surface,
        "ownerAgentSessionId": str(publication.get("ownerAgentSessionId")),
        "summary": str(publication.get("shapeSummary")),
        "files": as_list(publication.get("files")),
        "sourcePublicationId": str(publication.get("id")),
        "updatedAt": updated_at,
    }


def build_work_order(
    repo_id: str,
    episode: dict[str, Any],
    agent: dict[str, Any],
    owner_id: str | None,
    merge_contract: dict[str, Any] | None,
    conflicts: list[dict[str, Any]],
    created_at: int,
    agents: list[dict[str, Any]],
) -> dict[str, Any]:
    agent_id = str(agent.get("id"))
    role = "contract_owner" if owner_id == agent_id else "adapter"
    revision = 2 if merge_contract and merge_contract.get("sourcePublicationId") else 1
    owner = next((candidate for candidate in agents if candidate.get("id") == owner_id), None)
    owner_name = str((owner or {}).get("displayName") or "the contract owner")
    shared_files = sorted({
        evidence.replace("File overlap: ", "", 1)
        for conflict in conflicts
        for evidence in as_list(conflict.get("evidence"))
        if isinstance(evidence, str) and evidence.startswith("File overlap: ")
    })
    contract_summary = (
        str(merge_contract.get("summary"))
        if merge_contract
        else f"{owner_name} owns {episode['surface']}; preserve that public shape before dependent edits."
    )
    allowed_files = sorted(set(shared_files + as_list((merge_contract or {}).get("files"))))
    return {
        "id": stable_id_parts("work-order", str(episode["id"]), agent_id, str(revision)),
        "repoId": repo_id,
        "episodeId": str(episode["id"]),
        "agentSessionId": agent_id,
        "role": role,
        "status": "queued",
        "revision": revision,
        "title": f"Own {episode['surface']}" if role == "contract_owner" else f"Adapt to {episode['surface']}",
        "summary": (
            f"{agent.get('displayName')} owns {episode['surface']}. Publish the canonical contract, then checkpoint before downstream edits."
            if role == "contract_owner"
            else f"{owner_name} owns {episode['surface']}. Adapt this worktree to the required contract, keep changes additive where possible, then checkpoint."
        ),
        "requiredContract": contract_summary,
        "allowedFiles": allowed_files,
        "blockedFiles": [],
        "sharedFiles": shared_files,
        "nextCheckpoint": (
            "Publish the contract shape with rebase_checkpoint before dependent edits."
            if role == "contract_owner"
            else "Checkpoint after adapting to the owner contract and before final response."
        ),
        "createdAt": created_at,
        "updatedAt": created_at,
    }


def build_openai_coordination_plan(
    value: dict[str, Any],
    deterministic_result: dict[str, Any],
    created_at: int,
) -> dict[str, Any] | None:
    mode = str(value.get("plannerMode") or "optional")
    if mode not in {"optional", "required", "disabled"}:
        mode = "optional"
    if mode == "disabled":
        return None
    if not deterministic_result.get("episodes") or not deterministic_result.get("workOrders"):
        return None

    api_key = os.environ.get("OPENAI_API_KEY")
    fixture = os.environ.get("REBASE_OPENAI_PLANNER_FIXTURE")
    if not api_key:
        if mode == "required":
            raise RebaseCoordinationError(
                "OpenAI planner is required but OPENAI_API_KEY is not configured in the RocketRide environment"
            )
        return None

    try:
        raw_plan = json.loads(fixture) if fixture else request_openai_coordination_plan(value, deterministic_result)
        return normalize_openai_coordination_plan(raw_plan, deterministic_result, created_at)
    except Exception as error:
        if mode == "required":
            if isinstance(error, RebaseCoordinationError):
                raise
            raise RebaseCoordinationError(f"OpenAI coordination planner failed: {error}") from error
        return None


def request_openai_coordination_plan(
    value: dict[str, Any],
    deterministic_result: dict[str, Any],
) -> dict[str, Any]:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RebaseCoordinationError("OPENAI_API_KEY is not configured")
    model = os.environ.get("OPENAI_MODEL") or "gpt-5.4-mini"
    body = {
        "model": model,
        "response_format": {"type": "json_object"},
        "max_completion_tokens": 1800,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are Rebase's coordination planner for parallel coding agents. "
                    "Use agent intent, fingerprints, diffs, conflicts, and existing contracts "
                    "to assign ownership and produce concrete work orders. Return JSON only. "
                    "Do not claim merge safety; deterministic merge-risk checks are authoritative."
                ),
            },
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "requiredShape": {
                            "strategy": "split_ownership | integration_owner | pause | proceed",
                            "rationale": "short reason",
                            "ownerAgentSessionId": "agent id that owns semantic contract",
                            "integrationOwnerAgentSessionId": "optional agent id that owns exact overlapping file text",
                            "requiredTerms": ["required compatibility terms"],
                            "validationChecklist": ["checks agents must satisfy"],
                            "workOrders": [
                                {
                                    "agentSessionId": "agent id",
                                    "role": "contract_owner | integration_owner | adapter",
                                    "summary": "concrete assignment",
                                    "allowedFiles": ["paths"],
                                    "blockedFiles": ["paths"],
                                    "requiredContract": "contract/integration terms",
                                    "validationChecklist": ["checks"]
                                }
                            ],
                        },
                        "agents": compact_agents(as_list(value.get("agents") or value.get("plans"))),
                        "fingerprints": clip_json(as_list(value.get("fingerprints")), 12_000),
                        "diffs": clip_json(as_list(value.get("diffs")), 16_000),
                        "conflicts": clip_json(as_list(value.get("conflicts")), 12_000),
                        "decisions": clip_json(as_list(value.get("decisions") or value.get("activeDecisions")), 6_000),
                        "publications": clip_json(as_list(value.get("publications")), 10_000),
                        "deterministicWorkOrders": clip_json(deterministic_result.get("workOrders"), 10_000),
                    },
                    separators=(",", ":"),
                ),
            },
        ],
    }
    request = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "authorization": f"Bearer {api_key}",
            "content-type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            response_body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:500]
        raise RebaseCoordinationError(f"OpenAI planner HTTP {error.code}: {detail}") from error
    content = (((response_body.get("choices") or [{}])[0].get("message") or {}).get("content"))
    if not content:
        raise RebaseCoordinationError("OpenAI planner response was empty")
    parsed = json.loads(content)
    if not isinstance(parsed, dict):
        raise RebaseCoordinationError("OpenAI planner response was not an object")
    return parsed


def normalize_openai_coordination_plan(
    raw_plan: dict[str, Any],
    deterministic_result: dict[str, Any],
    created_at: int,
) -> dict[str, Any]:
    if not isinstance(raw_plan, dict):
        raise RebaseCoordinationError("OpenAI coordination plan must be an object")
    strategy = str(raw_plan.get("strategy") or "split_ownership")
    if strategy not in {"split_ownership", "integration_owner", "pause", "proceed"}:
        strategy = "split_ownership"
    deterministic_orders = [
        order for order in as_list(deterministic_result.get("workOrders")) if isinstance(order, dict)
    ]
    agent_ids = {str(order.get("agentSessionId")) for order in deterministic_orders}
    owner_id = text_or_none(raw_plan.get("ownerAgentSessionId")) or text_or_none(
        (deterministic_result.get("episodes") or [{}])[0].get("ownerAgentSessionId")
        if isinstance(deterministic_result.get("episodes"), list)
        and deterministic_result.get("episodes")
        else None
    )
    integration_owner_id = text_or_none(raw_plan.get("integrationOwnerAgentSessionId"))
    if integration_owner_id and integration_owner_id not in agent_ids:
        integration_owner_id = None
    if owner_id and owner_id not in agent_ids:
        owner_id = None
    work_orders = [
        order for order in as_list(raw_plan.get("workOrders")) if isinstance(order, dict)
    ]
    return {
        "source": "openai",
        "strategy": strategy,
        "rationale": bounded_text(raw_plan.get("rationale"), "OpenAI produced a coordination plan.", 2000),
        **({"ownerAgentSessionId": owner_id} if owner_id else {}),
        **({"integrationOwnerAgentSessionId": integration_owner_id} if integration_owner_id else {}),
        "workOrderIds": [],
        "requiredTerms": bounded_text_list(raw_plan.get("requiredTerms"), 30),
        "validationChecklist": bounded_text_list(raw_plan.get("validationChecklist"), 30),
        "_rawWorkOrders": work_orders,
        "_createdAt": created_at,
    }


def apply_coordination_plan_to_work_orders(
    deterministic_orders: list[dict[str, Any]],
    coordination_plan: dict[str, Any],
    episodes: list[dict[str, Any]],
    agents: list[dict[str, Any]],
    created_at: int,
) -> list[dict[str, Any]]:
    raw_orders = [
        order for order in as_list(coordination_plan.pop("_rawWorkOrders", [])) if isinstance(order, dict)
    ]
    coordination_plan.pop("_createdAt", None)
    base_by_agent = {
        str(order.get("agentSessionId")): dict(order)
        for order in deterministic_orders
        if isinstance(order, dict)
    }
    episode = episodes[0] if episodes else {}
    episode_id = str(episode.get("id") or "episode-none")
    repo_id = str(episode.get("repoId") or infer_repo_id({"episodes": episodes}))
    all_agent_ids = [str(agent.get("id")) for agent in agents if agent.get("id")]
    for raw_order in raw_orders:
        agent_id = text_or_none(raw_order.get("agentSessionId"))
        if not agent_id or agent_id not in all_agent_ids:
            continue
        base = base_by_agent.get(agent_id) or {
            "id": stable_id_parts("work-order", episode_id, agent_id, "openai", str(created_at)),
            "repoId": repo_id,
            "episodeId": episode_id,
            "agentSessionId": agent_id,
            "status": "queued",
            "revision": 1,
            "sharedFiles": [],
            "createdAt": created_at,
            "updatedAt": created_at,
        }
        role = str(raw_order.get("role") or base.get("role") or "adapter")
        if role not in {"contract_owner", "integration_owner", "adapter"}:
            role = "adapter"
        validation = bounded_text_list(raw_order.get("validationChecklist"), 10)
        next_checkpoint = bounded_text(
            raw_order.get("nextCheckpoint"),
            "Checkpoint after satisfying this OpenAI coordination work order.",
            500,
        )
        if validation:
            next_checkpoint = bounded_text(
                f"{next_checkpoint} Validate: {'; '.join(validation)}",
                next_checkpoint,
                500,
            )
        base_by_agent[agent_id] = {
            **base,
            "role": role,
            "title": bounded_text(raw_order.get("title"), title_for_role(role, episode), 200),
            "summary": bounded_text(raw_order.get("summary"), str(base.get("summary") or "Follow the OpenAI coordination plan."), 2000),
            "requiredContract": bounded_text(raw_order.get("requiredContract"), str(base.get("requiredContract") or coordination_plan.get("rationale") or "Follow the OpenAI coordination plan."), 4000),
            "allowedFiles": bounded_path_list(raw_order.get("allowedFiles") or base.get("allowedFiles")),
            "blockedFiles": bounded_path_list(raw_order.get("blockedFiles") or base.get("blockedFiles")),
            "sharedFiles": bounded_path_list(raw_order.get("sharedFiles") or base.get("sharedFiles")),
            "nextCheckpoint": next_checkpoint,
            "updatedAt": created_at,
        }
    return sorted(base_by_agent.values(), key=lambda order: str(order.get("agentSessionId")))


def title_for_role(role: str, episode: dict[str, Any]) -> str:
    surface = str(episode.get("surface") or "shared surface")
    if role == "contract_owner":
        return f"Own {surface}"
    if role == "integration_owner":
        return f"Integrate {surface} files"
    return f"Adapt to {surface}"


def find_existing_episode(
    episodes: list[dict[str, Any]],
    episode_id: str,
    surface: str,
    affected_worktree_ids: list[str],
) -> dict[str, Any] | None:
    target = "|".join(affected_worktree_ids)
    for episode in episodes:
        if episode.get("id") == episode_id:
            return episode
    for episode in episodes:
        if episode.get("surface") == surface and "|".join(sorted(as_list(episode.get("affectedWorktreeIds")))) == target:
            return episode
    return None


def is_coordinated(
    episode_id: str,
    agent_ids: list[str],
    merge_contract: dict[str, Any] | None,
    existing_work_orders: list[dict[str, Any]],
) -> bool:
    if not merge_contract:
        return False
    return all(
        any(
            order.get("episodeId") == episode_id
            and order.get("agentSessionId") == agent_id
            and order.get("status") == "completed"
            for order in existing_work_orders
        )
        for agent_id in agent_ids
    )


def infer_repo_id(value: dict[str, Any]) -> str:
    for key in ("repoId",):
        if isinstance(value.get(key), str) and value[key]:
            return value[key]
    for collection_key in ("conflicts", "fingerprints", "agents", "plans"):
        for item in as_list(value.get(collection_key)):
            if isinstance(item, dict) and isinstance(item.get("repoId"), str) and item["repoId"]:
                return item["repoId"]
    return "repo"


def is_risky_file(file_path: str) -> bool:
    return bool(re.search(r"(schema|model|entity|migration|route|routes|api|dto|types|interfaces|contract)", file_path, re.IGNORECASE))


def conflict_id(left: dict[str, Any], right: dict[str, Any], surface: str) -> str:
    return stable_id_parts(*sorted([str(left.get("repoId")), str(left.get("worktreeId")), str(right.get("worktreeId")), surface]))


def stable_id(value: str) -> str:
    return hashlib.sha1(value.encode("utf-8")).hexdigest()[:16]


def stable_id_parts(*parts: str) -> str:
    return stable_id(":".join(parts))


def slug(value: str) -> str:
    return re.sub(r"^-|-$", "", re.sub(r"[^a-z0-9]+", "-", value.lower()))


def intersection(left: list[Any], right: list[Any]) -> list[str]:
    right_set = {str(item) for item in right if isinstance(item, str)}
    return sorted({str(item) for item in left if isinstance(item, str) and str(item) in right_set})


def as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def unique_in_order(values: list[Any]) -> list[str]:
    seen = set()
    result = []
    for value in values:
        text = str(value)
        if text in seen:
            continue
        seen.add(text)
        result.append(text)
    return result


def text_or_none(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text or None


def bounded_text(value: Any, fallback: str, limit: int) -> str:
    text = text_or_none(value) or fallback
    return text[:limit]


def bounded_text_list(value: Any, limit: int) -> list[str]:
    return [str(item).strip()[:1000] for item in as_list(value) if str(item).strip()][:limit]


def bounded_path_list(value: Any) -> list[str]:
    return unique_in_order([str(item).strip() for item in as_list(value) if str(item).strip()])[:40]


def compact_agents(agents: list[Any]) -> list[dict[str, Any]]:
    return [
        {
            "id": str(agent.get("id")),
            "worktreeId": str(agent.get("worktreeId")),
            "displayName": str(agent.get("displayName") or ""),
            "coordinationRole": str(agent.get("coordinationRole") or ""),
            "currentPlan": str(agent.get("currentPlan") or "")[:2000],
        }
        for agent in agents
        if isinstance(agent, dict) and agent.get("id")
    ]


def clip_json(value: Any, limit: int) -> Any:
    text = json.dumps(value, separators=(",", ":"), default=str)
    if len(text) <= limit:
        return value
    return json.loads(text[:limit] + '"..."') if text.startswith('"') else text[:limit]


def require_text(value: dict[str, Any], key: str) -> str:
    text = value.get(key)
    if not isinstance(text, str) or not text:
        keys = ", ".join(sorted(str(item) for item in value.keys()))
        raise RebaseCoordinationError(
            f"Rebase coordination input missing {key}; keys: {keys}"
        )
    return text


def number_or_default(value: Any, default: int) -> int:
    return int(value) if isinstance(value, (int, float)) else default


def highest_risk(risks: list[str]) -> str:
    if "high" in risks:
        return "high"
    if "medium" in risks:
        return "medium"
    return "low"


def clamp(value: float) -> float:
    return min(1, max(0, value))
