"use server";

import { revalidatePath } from "next/cache";
import { coordinatorUrl } from "./tempo-api";

export async function updateConflictStatus(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  await coordinatorMutation(`/api/conflicts/${id}/status`, { status });
  revalidateTempoPages();
}

export async function generateAdvisory(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  await coordinatorMutation(`/api/conflicts/${id}/advisory`, {});
  revalidateTempoPages();
}

export async function sendIntervention(formData: FormData) {
  const conflictId = String(formData.get("conflictId") ?? "");
  const draft = String(formData.get("draft") ?? "");
  const editedDirection = String(formData.get("editedDirection") ?? "");
  const targetAgentSessionIds = JSON.parse(
    String(formData.get("targetAgentSessionIds") ?? "[]")
  ) as string[];
  const ownerAgentSessionId = String(formData.get("ownerAgentSessionId") ?? "");

  await coordinatorMutation("/api/interventions", {
    conflictId,
    targetAgentSessionIds,
    draft,
    editedDirection,
    ...(ownerAgentSessionId ? { ownerAgentSessionId } : {})
  });
  revalidateTempoPages();
}

export async function recordDecision(formData: FormData) {
  const conflictId = String(formData.get("conflictId") ?? "");
  const selectedOptionId = String(formData.get("selectedOptionId") ?? "");
  const selectedOptionTitle = String(formData.get("selectedOptionTitle") ?? "");
  const selectedOptionDirection = String(
    formData.get("selectedOptionDirection") ?? ""
  );
  const ownerAgentSessionId = String(formData.get("ownerAgentSessionId") ?? "");

  await coordinatorMutation("/api/decisions", {
    conflictId,
    selectedOptionId,
    selectedOptionTitle,
    selectedOptionDirection,
    ...(ownerAgentSessionId ? { ownerAgentSessionId } : {}),
    createdBy: "dashboard"
  });
  revalidateTempoPages();
}

async function coordinatorMutation(pathname: string, payload: unknown) {
  const token = process.env.TEMPO_LOCAL_TOKEN;
  if (!token) {
    throw new Error("TEMPO_LOCAL_TOKEN is required for dashboard mutations.");
  }
  const response = await fetch(`${coordinatorUrl}${pathname}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(payload),
    cache: "no-store"
  });
  if (!response.ok) {
    throw new Error(`Tempo coordinator returned ${response.status} for ${pathname}`);
  }
}

function revalidateTempoPages() {
  revalidatePath("/sessions");
  revalidatePath("/conflicts");
  revalidatePath("/interventions");
  revalidatePath("/agents");
}
