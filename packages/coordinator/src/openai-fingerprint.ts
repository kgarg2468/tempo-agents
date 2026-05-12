import OpenAI from "openai";
import { z } from "zod";
import type { Fingerprint } from "@tempo/shared";
import { fingerprintSchema } from "@tempo/shared";
import {
  createHeuristicFingerprint,
  type HeuristicFingerprintInput
} from "./fingerprint.js";

export interface StructuredFingerprintInput extends HeuristicFingerprintInput {
  diff: string;
}

export interface FingerprintModelInput {
  diff: string;
  files: StructuredFingerprintInput["files"];
  heuristic: Fingerprint;
}

export type FingerprintModelInvoker = (
  input: FingerprintModelInput
) => Promise<unknown>;

export interface StructuredFingerprintOptions {
  modelInvoker?: FingerprintModelInvoker;
  cache?: Map<string, FingerprintModelOutput>;
  env?: Record<string, string | undefined>;
}

const modelOutputSchema = z.object({
  semanticSummary: z.string().min(1).max(1200),
  likelyContractChanges: z.array(z.string().min(1)).max(30).default([]),
  confidence: z.number().min(0).max(1),
  symbols: z
    .object({
      added: z.array(z.string()).default([]),
      modified: z.array(z.string()).default([]),
      removed: z.array(z.string()).default([])
    })
    .optional()
});

type FingerprintModelOutput = z.infer<typeof modelOutputSchema>;

const defaultModelCache = new Map<string, FingerprintModelOutput>();

export async function createStructuredFingerprint(
  input: StructuredFingerprintInput,
  options: StructuredFingerprintOptions = {}
): Promise<Fingerprint> {
  const heuristic = createHeuristicFingerprint(input);
  const cache = options.cache ?? defaultModelCache;
  const cached = cache.get(input.diffHash);
  if (cached) {
    return mergeModelOutput(heuristic, cached);
  }

  const invoker =
    options.modelInvoker ?? createOpenAiInvoker(options.env ?? process.env);
  if (!invoker) return heuristic;

  try {
    const raw = await invoker({
      diff: input.diff,
      files: input.files,
      heuristic
    });
    const parsed = modelOutputSchema.parse(raw);
    cache.set(input.diffHash, parsed);
    return mergeModelOutput(heuristic, parsed);
  } catch (_error) {
    return heuristic;
  }
}

function mergeModelOutput(
  heuristic: Fingerprint,
  modelOutput: FingerprintModelOutput
): Fingerprint {
  return fingerprintSchema.parse({
    ...heuristic,
    semanticSummary: modelOutput.semanticSummary,
    symbols: modelOutput.symbols ?? heuristic.symbols,
    contractChanges:
      modelOutput.likelyContractChanges.length > 0
        ? modelOutput.likelyContractChanges
        : heuristic.contractChanges,
    confidence: modelOutput.confidence,
    source: "mixed"
  });
}

function createOpenAiInvoker(
  env: Record<string, string | undefined>
): FingerprintModelInvoker | null {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const model = env.OPENAI_MODEL ?? "gpt-5.4-mini";
  const client = new OpenAI({ apiKey });

  return async ({ diff, files, heuristic }) => {
    const response = await client.chat.completions.create({
      model,
      response_format: { type: "json_object" },
      max_completion_tokens: 700,
      messages: [
        {
          role: "system",
          content:
            "You fingerprint live code diffs for a local conflict detector. Return compact JSON only."
        },
        {
          role: "user",
          content: JSON.stringify({
            requiredShape: {
              semanticSummary: "one concise sentence",
              likelyContractChanges: ["surface labels"],
              confidence: "number 0..1",
              symbols: {
                added: ["symbol names"],
                modified: ["symbol names"],
                removed: ["symbol names"]
              }
            },
            heuristic: {
              filesTouched: heuristic.filesTouched,
              surfaces: heuristic.surfaces,
              symbols: heuristic.symbols
            },
            files: files.map((file) => ({
              path: file.path,
              contentPreview: file.content.slice(0, 4000)
            })),
            diff: diff.slice(0, 16_000)
          })
        }
      ]
    });
    const content = response.choices[0]?.message.content;
    if (!content) {
      throw new Error("OpenAI fingerprint response was empty");
    }
    return JSON.parse(content) as unknown;
  };
}
