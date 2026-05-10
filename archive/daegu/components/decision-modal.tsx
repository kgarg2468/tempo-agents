"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Send } from "lucide-react";

export interface DecisionModalData {
  _id: string;
  decision: "fire" | "spare";
  reasoning: string;
  email_draft: string;
  status: "pending" | "approved" | "rejected" | "sent";
}

export function DecisionModal({
  open,
  onOpenChange,
  decision,
  employeeName,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  decision: DecisionModalData | null;
  employeeName: string;
}) {
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!decision) return null;

  const act = async (action: "approve" | "reject") => {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(`/api/decisions/${decision._id}/${action}`, { method: "POST" });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || `Failed to ${action}`);
      }
      onOpenChange(false);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const isPending = decision.status === "pending";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onClose={() => onOpenChange(false)}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            {employeeName}
            <Badge variant={decision.decision === "fire" ? "active" : "spared"}>
              {decision.decision === "fire" ? "Terminate" : "Spare"}
            </Badge>
          </DialogTitle>
          <DialogDescription>
            The Claw has rendered judgment. Approve to dispatch the email.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 max-h-[52vh] overflow-y-auto pr-1">
          <div>
            <div className="text-[8px] font-mono tracking-[0.22em] text-[var(--text-dim)] uppercase mb-2">Reasoning</div>
            <p className="text-[11px] font-mono text-[var(--text-muted)] whitespace-pre-wrap leading-relaxed">
              {decision.reasoning}
            </p>
          </div>

          <div>
            <div className="text-[8px] font-mono tracking-[0.22em] text-[var(--text-dim)] uppercase mb-2">Email Draft</div>
            <pre className="border border-[var(--border)] bg-[var(--surface-raised)] p-4 text-[10px] font-mono text-[var(--text-muted)] whitespace-pre-wrap leading-relaxed">
{decision.email_draft}
            </pre>
          </div>
        </div>

        {error ? (
          <div className="border border-[var(--accent)]/60 bg-[var(--accent-dim)]/20 p-3">
            <p className="text-[10px] font-mono text-[var(--accent)]">{error}</p>
          </div>
        ) : null}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => act("reject")}
            disabled={!isPending || busy !== null}
          >
            {busy === "reject" ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            Spare Them
          </Button>
          <Button
            variant="fire"
            onClick={() => act("approve")}
            disabled={!isPending || busy !== null || decision.decision !== "fire"}
          >
            {busy === "approve" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
            Send It
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
