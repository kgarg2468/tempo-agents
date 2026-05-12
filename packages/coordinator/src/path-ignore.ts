import fs from "node:fs";
import path from "node:path";

const DEFAULT_IGNORED_SEGMENTS = new Set([
  ".git",
  ".tempo",
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".cache",
  "data"
]);

const DEFAULT_IGNORED_BASENAMES = new Set(["next-env.d.ts", ".DS_Store"]);

const DEFAULT_IGNORED_BASENAME_PATTERNS = [
  "*.tsbuildinfo",
  "*.sqlite",
  "*.sqlite-*",
  "*.log",
  "npm-debug.log*",
  "yarn-debug.log*",
  "yarn-error.log*",
  "pnpm-debug.log*"
];

export interface TempoPathFilter {
  isIgnoredPath(filePath: string): boolean;
  filterDiff(diff: string): string;
}

export function createTempoPathFilter(repoRoot: string): TempoPathFilter {
  const rules = readTempoIgnoreRules(repoRoot);
  return {
    isIgnoredPath(filePath: string) {
      const relativePath = toRelativePath(repoRoot, filePath);
      return isBuiltInIgnoredPath(relativePath) || isIgnoredByRules(relativePath, rules);
    },
    filterDiff(diff: string) {
      return filterDiff(diff, (filePath) => {
        const relativePath = normalizeRelativePath(filePath);
        return isBuiltInIgnoredPath(relativePath) || isIgnoredByRules(relativePath, rules);
      });
    }
  };
}

function readTempoIgnoreRules(repoRoot: string): string[] {
  const ignorePath = path.join(repoRoot, ".tempoignore");
  try {
    return fs
      .readFileSync(ignorePath, "utf8")
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
  } catch (_error) {
    return [];
  }
}

function toRelativePath(repoRoot: string, filePath: string): string {
  const relativePath = path.isAbsolute(filePath)
    ? path.relative(repoRoot, filePath)
    : filePath;
  return normalizeRelativePath(relativePath);
}

function normalizeRelativePath(filePath: string): string {
  return filePath.split(path.sep).join("/").replace(/^\.?\//, "");
}

function isBuiltInIgnoredPath(relativePath: string): boolean {
  const segments = relativePath.split("/").filter(Boolean);
  const basename = segments.at(-1) ?? relativePath;
  if (segments.some((segment) => DEFAULT_IGNORED_SEGMENTS.has(segment))) {
    return true;
  }
  if (DEFAULT_IGNORED_BASENAMES.has(basename)) return true;
  return DEFAULT_IGNORED_BASENAME_PATTERNS.some((pattern) =>
    globMatch(basename, pattern)
  );
}

function isIgnoredByRules(relativePath: string, rules: string[]): boolean {
  let ignored = false;
  for (const rawRule of rules) {
    const negated = rawRule.startsWith("!");
    const rule = normalizeRelativePath(negated ? rawRule.slice(1) : rawRule);
    if (!rule || rule === "!") continue;
    if (matchesRule(relativePath, rule)) {
      ignored = !negated;
    }
  }
  return ignored;
}

function matchesRule(relativePath: string, rule: string): boolean {
  const directoryRule = rule.endsWith("/");
  const normalizedRule = directoryRule ? rule.slice(0, -1) : rule;
  if (!normalizedRule) return false;

  if (directoryRule) {
    return (
      relativePath === normalizedRule || relativePath.startsWith(`${normalizedRule}/`)
    );
  }

  if (!normalizedRule.includes("/")) {
    return relativePath
      .split("/")
      .some((segment) => globMatch(segment, normalizedRule));
  }

  return globMatch(relativePath, normalizedRule);
}

function filterDiff(diff: string, isIgnored: (filePath: string) => boolean): string {
  const blocks = diff
    .split(/(?=^diff --git )/gm)
    .filter((block) => block.trim().length > 0);
  return blocks
    .filter((block) => {
      const filePath = filePathFromDiffBlock(block);
      return filePath ? !isIgnored(filePath) : true;
    })
    .join("")
    .trim();
}

function filePathFromDiffBlock(block: string): string | null {
  const firstLine = block.split("\n")[0] ?? "";
  const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(firstLine);
  return match?.[2] ?? null;
}

function globMatch(value: string, pattern: string): boolean {
  const doubleStarPlaceholder = "__TEMPO_DOUBLE_STAR__";
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, doubleStarPlaceholder)
    .replace(/\*/g, "[^/]*")
    .replaceAll(doubleStarPlaceholder, ".*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`).test(value);
}
