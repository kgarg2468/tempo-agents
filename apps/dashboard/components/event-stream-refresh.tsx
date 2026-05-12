"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const coordinatorUrl =
  process.env.NEXT_PUBLIC_TEMPO_COORDINATOR_URL ?? "http://127.0.0.1:3747";

export function EventStreamRefresh() {
  const router = useRouter();

  useEffect(() => {
    const wsUrl = coordinatorUrl.replace(/^http/, "ws");
    const socket = new WebSocket(`${wsUrl}/api/events/stream`);
    socket.addEventListener("message", () => {
      router.refresh();
    });
    return () => {
      socket.close();
    };
  }, [router]);

  return null;
}
