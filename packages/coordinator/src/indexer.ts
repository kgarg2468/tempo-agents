import type { ContractSurface, SurfaceKind } from "@tempo/shared";

export interface FileSnapshot {
  path: string;
  content: string;
}

export interface SurfaceInput {
  files: FileSnapshot[];
}

export function extractSurfacesFromDiff(input: SurfaceInput): ContractSurface[] {
  const byId = new Map<string, ContractSurface>();

  for (const file of input.files) {
    for (const surface of extractFileSurfaces(file)) {
      const existing = byId.get(surface.id);
      if (existing) {
        existing.files = [...new Set([...existing.files, ...surface.files])].sort();
        existing.evidence = [...new Set([...existing.evidence, ...surface.evidence])];
        existing.confidence = Math.max(existing.confidence, surface.confidence);
      } else {
        byId.set(surface.id, surface);
      }
    }
  }

  return [...byId.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function extractFileSurfaces(file: FileSnapshot): ContractSurface[] {
  const lowerPath = file.path.toLowerCase();
  const surfaces: ContractSurface[] = [];
  const names = extractLikelyNames(file.content, file.path);

  const pathKind = classifyPath(lowerPath);
  for (const name of names) {
    const kind = chooseKindForName(name, pathKind, lowerPath);
    surfaces.push(makeSurface(name, kind, file.path, pathEvidence(lowerPath, kind)));
  }

  if (surfaces.length === 0 && pathKind !== "unknown") {
    const fallback = fallbackLabelFromPath(file.path, pathKind);
    surfaces.push(makeSurface(fallback, pathKind, file.path, [`${pathKind} path`], 0.55));
  }

  return surfaces;
}

function classifyPath(lowerPath: string): SurfaceKind {
  if (/(schema|model|entity|migration|drizzle|prisma)/.test(lowerPath)) {
    if (/migration/.test(lowerPath)) return "migration";
    return "schema";
  }
  if (/(route|routes|api|controller|handler|endpoint)/.test(lowerPath)) return "api";
  if (/(dto|request|response|payload)/.test(lowerPath)) return "dto";
  if (/(component|components|tsx$|jsx$)/.test(lowerPath)) return "component";
  if (/(types|interfaces|contract)/.test(lowerPath)) return "type";
  if (/(utils|util|helpers)/.test(lowerPath)) return "utility";
  if (/(test|spec)/.test(lowerPath)) return "test";
  return "unknown";
}

function extractLikelyNames(content: string, filePath: string): string[] {
  const names = new Set<string>();
  const patterns = [
    /\binterface\s+([A-Z][A-Za-z0-9_]*)/g,
    /\btype\s+([A-Z][A-Za-z0-9_]*)/g,
    /\bclass\s+([A-Z][A-Za-z0-9_]*)/g,
    /\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)/g,
    /\bdef\s+([A-Za-z_][A-Za-z0-9_]*)/g,
    /\bpublic\s+(?:class|interface|record)\s+([A-Z][A-Za-z0-9_]*)/g
  ];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      if (match[1]) names.add(normalizeName(match[1]));
    }
  }

  for (const match of content.matchAll(/\bsqliteTable\(\s*["']([A-Za-z0-9_-]+)["']/g)) {
    if (match[1]) names.add(tableNameToModelName(match[1]));
  }

  const basename = filePath.split("/").pop() ?? filePath;
  const base = basename.replace(/\.[^.]+$/, "");
  if (/^[A-Z][A-Za-z0-9_]*(Card|Props|Dto|DTO|Controller|Service|Model)?$/.test(base)) {
    names.add(normalizeName(base));
  }

  return [...names];
}

function normalizeName(name: string): string {
  return name.replace(/Props$/, "").replace(/DTO$/, "Dto");
}

function tableNameToModelName(name: string): string {
  const singular = name.replace(/s$/, "");
  return singular
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function chooseKindForName(
  name: string,
  pathKind: SurfaceKind,
  lowerPath: string
): SurfaceKind {
  if (/Props$/.test(name) || /card|component/.test(lowerPath)) return "component";
  if (/Dto$/.test(name) || pathKind === "dto") return "dto";
  if (/Controller$/.test(name) || pathKind === "api") return "api";
  if (pathKind !== "unknown") return pathKind;
  return "type";
}

function makeSurface(
  rawName: string,
  kind: SurfaceKind,
  filePath: string,
  evidence: string[],
  confidence = 0.75
): ContractSurface {
  const baseName = rawName
    .replace(/Card$/, "Card")
    .replace(/Controller$/, "")
    .replace(/Dto$/, "")
    .replace(/DTO$/, "");
  const label = labelFor(baseName, kind, rawName);
  return {
    id: slug(label),
    label,
    kind,
    files: [filePath],
    confidence,
    evidence
  };
}

function labelFor(baseName: string, kind: SurfaceKind, rawName: string): string {
  if (kind === "schema" || kind === "model" || kind === "migration") {
    return `${stripSuffixes(baseName)} model`;
  }
  if (kind === "api") return `${stripSuffixes(baseName)} API`;
  if (kind === "dto") return `${stripSuffixes(baseName)} DTO`;
  if (kind === "component") {
    if (/Card/.test(rawName)) return `${stripSuffixes(rawName)} props`;
    return `${stripSuffixes(baseName)} component`;
  }
  if (kind === "type") return `${stripSuffixes(baseName)} type`;
  return `${stripSuffixes(baseName)} ${kind}`;
}

function stripSuffixes(name: string): string {
  return name
    .replace(/Props$/, "")
    .replace(/Controller$/, "")
    .replace(/Dto$/, "")
    .replace(/DTO$/, "");
}

function fallbackLabelFromPath(filePath: string, kind: SurfaceKind): string {
  const base = filePath
    .split("/")
    .pop()
    ?.replace(/\.[^.]+$/, "")
    .replace(/[-_](.)/g, (_match, letter: string) => letter.toUpperCase());
  return `${base ?? "unknown"} ${kind}`;
}

function pathEvidence(lowerPath: string, kind: SurfaceKind): string[] {
  const evidence = [`${kind} path`];
  if (lowerPath.endsWith(".ts") || lowerPath.endsWith(".tsx")) evidence.push("TS/JS file");
  if (lowerPath.endsWith(".py")) evidence.push("Python file");
  if (lowerPath.endsWith(".java")) evidence.push("Java file");
  return evidence;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
