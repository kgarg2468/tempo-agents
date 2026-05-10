import { createRebasePathFilter } from "./path-ignore.js";

export interface RedactionResult<T> {
  value: T;
  redactions: string[];
}

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{8,}\b/g,
  /\b((?:OPENAI_)?API_KEY|TOKEN|SECRET|PASSWORD)=([^\s"']+)/gi
];

export function redactForCloud<T>(value: T, repoRoot: string): RedactionResult<T> {
  const filter = createRebasePathFilter(repoRoot);
  const redactions = new Set<string>();

  function redactUnknown(input: unknown): unknown {
    if (typeof input === "string") return redactString(input);
    if (Array.isArray(input)) return input.map((item) => redactUnknown(item));
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input).map(([key, entry]) => [key, redactUnknown(entry)])
      );
    }
    return input;
  }

  function redactString(input: string): string {
    let output = input;
    for (const pattern of SECRET_PATTERNS) {
      output = output.replace(pattern, (match, key: string | undefined) => {
        redactions.add("secret");
        return key ? `${key}=[REDACTED_SECRET]` : "[REDACTED_SECRET]";
      });
    }

    for (const token of pathTokens(output)) {
      if (!filter.isIgnoredPath(token)) continue;
      redactions.add(`path:${token}`);
      output = output.split(token).join("[REDACTED_PATH]");
    }

    return output;
  }

  return {
    value: redactUnknown(value) as T,
    redactions: [...redactions].sort()
  };
}

function pathTokens(value: string): string[] {
  return [
    ...new Set(
      [...value.matchAll(/[A-Za-z0-9._/-]+/g)]
        .map((match) => match[0])
        .map((token) => token.replace(/[.,;:!?]+$/g, ""))
        .filter((token) => token.includes("/") || token.startsWith("."))
    )
  ];
}
