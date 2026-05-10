import { describe, expect, it } from "vitest";
import { extractSurfacesFromDiff } from "./indexer.js";

describe("AST-lite indexer", () => {
  it("detects TypeScript schema and component contract surfaces", () => {
    const surfaces = extractSurfacesFromDiff({
      files: [
        {
          path: "src/db/schema.ts",
          content: "export interface Task { id: string; priority: string }\n"
        },
        {
          path: "src/components/TaskCard.tsx",
          content: "export type TaskCardProps = { task: Task }\n"
        }
      ]
    });

    expect(surfaces.map((surface) => surface.label)).toContain("Task model");
    expect(surfaces.map((surface) => surface.label)).toContain("TaskCard props");
  });

  it("detects Drizzle table declarations as model surfaces", () => {
    const surfaces = extractSurfacesFromDiff({
      files: [
        {
          path: "src/db/schema.ts",
          content: "export const tasks = sqliteTable(\"tasks\", {});\n"
        }
      ]
    });

    expect(surfaces.map((surface) => surface.label)).toContain("Task model");
    expect(surfaces.map((surface) => surface.label)).not.toContain(
      "schema schema model"
    );
  });

  it("detects Python model and route-like surfaces", () => {
    const surfaces = extractSurfacesFromDiff({
      files: [
        {
          path: "app/models/task.py",
          content: "class Task(BaseModel):\n    id: str\n"
        },
        {
          path: "app/routes/tasks.py",
          content: "@router.get('/tasks')\ndef list_tasks():\n    pass\n"
        }
      ]
    });

    expect(surfaces.map((surface) => surface.label)).toContain("Task model");
    expect(surfaces.some((surface) => surface.kind === "api")).toBe(true);
  });

  it("detects Java DTO/controller surfaces", () => {
    const surfaces = extractSurfacesFromDiff({
      files: [
        {
          path: "src/main/java/com/acme/TaskDto.java",
          content: "public class TaskDto { public String priority; }\n"
        },
        {
          path: "src/main/java/com/acme/TaskController.java",
          content: "@RestController public class TaskController {}\n"
        }
      ]
    });

    expect(surfaces.map((surface) => surface.label)).toContain("Task DTO");
    expect(surfaces.map((surface) => surface.label)).toContain("Task API");
  });
});
