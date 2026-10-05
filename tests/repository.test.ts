import { beforeEach, describe, expect, it } from "vitest";
import { ProjectRepository } from "../src/shared/repositories/projectRepository";
import {
  EXAMPLE_PROJECT,
  type WorkspaceDocument,
} from "../src/shared/domain/types";
import { simulateProject } from "../src/shared/domain/simulation";

class MemoryStorage {
  value: unknown = undefined;
  failWrite = false;
  async read(): Promise<unknown> {
    return this.value;
  }
  async write(value: WorkspaceDocument): Promise<void> {
    if (this.failWrite) throw new Error("simulated IndexedDB quota failure");
    this.value = structuredClone(value);
  }
}

describe("project repository recovery", () => {
  beforeEach(() => localStorage.clear());

  it("provides a usable example when both stores are empty or damaged", async () => {
    const storage = new MemoryStorage();
    storage.value = { version: 99, projects: "broken" };
    const loaded = await new ProjectRepository(storage).load();
    expect(loaded.recovered).toBe(true);
    expect(loaded.document.projects[0]?.id).toBe(EXAMPLE_PROJECT.id);
    expect(loaded.document.projects[0]?.nodes.length).toBeGreaterThan(0);
  });

  it("restores the local recovery copy when IndexedDB data is malformed", async () => {
    const storage = new MemoryStorage();
    const repository = new ProjectRepository(storage);
    const document: WorkspaceDocument = {
      version: 2,
      activeProjectId: EXAMPLE_PROJECT.id,
      projects: [structuredClone(EXAMPLE_PROJECT)],
    };
    await repository.save(document);
    storage.value = { version: 1, projects: [{ id: 5, nodes: [] }] };
    const loaded = await repository.load();
    expect(loaded.recovered).toBe(true);
    expect(loaded.document.projects[0]?.nodes).toHaveLength(
      EXAMPLE_PROJECT.nodes.length,
    );
  });

  it("keeps readable projects while dropping malformed project rows and broken edges", async () => {
    const storage = new MemoryStorage();
    storage.value = {
      version: 1,
      activeProjectId: EXAMPLE_PROJECT.id,
      projects: [
        {
          ...EXAMPLE_PROJECT,
          nodes: [
            { ...EXAMPLE_PROJECT.nodes[0], dependencyIds: ["missing"] },
            { damaged: true },
          ],
        },
        { id: 9, title: null },
      ],
    };
    const loaded = await new ProjectRepository(storage).load();
    expect(loaded.document.projects).toHaveLength(1);
    expect(loaded.document.projects[0]?.nodes).toHaveLength(1);
    expect(loaded.document.projects[0]?.nodes[0]?.dependencyIds).toEqual([]);
    expect(loaded.recovered).toBe(true);
  });

  it("keeps a local recovery copy when IndexedDB saving fails", async () => {
    const storage = new MemoryStorage();
    storage.failWrite = true;
    const repository = new ProjectRepository(storage);
    const document: WorkspaceDocument = {
      version: 2,
      activeProjectId: EXAMPLE_PROJECT.id,
      projects: [structuredClone(EXAMPLE_PROJECT)],
    };
    await expect(repository.save(document)).rejects.toThrow(
      "IndexedDB quota failure",
    );
    storage.failWrite = false;
    const loaded = await repository.load();
    expect(loaded.document.projects[0]?.id).toBe(EXAMPLE_PROJECT.id);
    expect(loaded.recovered).toBe(true);
  });

  it("migrates legacy v1 timeout zeroes to the no-timeout sentinel", async () => {
    const storage = new MemoryStorage();
    storage.value = {
      version: 1,
      activeProjectId: "legacy",
      projects: [
        {
          id: "legacy",
          title: "旧方案",
          createdAt: 1,
          updatedAt: 1,
          concurrencyLimit: null,
          nodes: [
            {
              id: "n0",
              name: "旧节点",
              durationMs: 500,
              jitterMs: 0,
              dependencyIds: [],
              timeoutMs: 0,
              retryCount: 0,
              failureRate: 0,
            },
          ],
          scenarios: [
            {
              id: "s0",
              name: "旧快照",
              createdAt: 1,
              concurrencyLimit: null,
              completionMs: 500,
              criticalPath: ["n0"],
              nodes: [
                {
                  id: "n0",
                  name: "旧节点",
                  durationMs: 500,
                  jitterMs: 0,
                  dependencyIds: [],
                  timeoutMs: 0,
                  retryCount: 0,
                  failureRate: 0,
                },
              ],
            },
          ],
        },
      ],
    };
    const loaded = await new ProjectRepository(storage).load();
    expect(loaded.document.version).toBe(2);
    expect(loaded.document.projects[0]?.nodes[0]?.timeoutMs).toBe(-1);
    expect(loaded.document.projects[0]?.scenarios[0]?.nodes[0]?.timeoutMs).toBe(
      -1,
    );
    // 迁移后按新规则重算，预算与旧语义一致，不会因 0 变成 0ms 而凭空变化。
    const migrated = simulateProject(loaded.document.projects[0]!, "expected");
    expect(migrated.completionMs).toBe(500);
    expect(migrated.warnings.join(" ")).not.toContain("超时");
  });

  it("keeps a v2 zero as a 0ms threshold instead of re-migrating it", async () => {
    const storage = new MemoryStorage();
    storage.value = {
      version: 2,
      activeProjectId: "fresh",
      projects: [
        {
          id: "fresh",
          title: "新方案",
          createdAt: 1,
          updatedAt: 1,
          concurrencyLimit: null,
          nodes: [
            {
              id: "n0",
              name: "新节点",
              durationMs: 500,
              jitterMs: 0,
              dependencyIds: [],
              timeoutMs: 0,
              retryCount: 0,
              failureRate: 0,
            },
          ],
          scenarios: [],
        },
      ],
    };
    const loaded = await new ProjectRepository(storage).load();
    expect(loaded.document.projects[0]?.nodes[0]?.timeoutMs).toBe(0);
  });
});
