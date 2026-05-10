/**
 * Server-side Convex client for use inside Next.js API routes.
 * Uses the public NEXT_PUBLIC_CONVEX_URL endpoint via ConvexHttpClient.
 */
import { ConvexHttpClient } from "convex/browser";

let _client: ConvexHttpClient | null = null;

export function getConvex(): ConvexHttpClient {
  if (_client) return _client;
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) {
    throw new Error(
      "NEXT_PUBLIC_CONVEX_URL is not set. Run `npx convex dev` and copy the URL into .env.local."
    );
  }
  _client = new ConvexHttpClient(url);
  return _client;
}
