import { beforeEach, describe, expect, it } from "vitest";
import { ProjectRepository } from "../src/shared/repositories/projectRepository";
import { simulateProject } from "../src/shared/domain/simulation";
import {
  EXAMPLE_PROJECT,
  type WorkspaceDocument,
} from "../src/shared/domain/types";

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
      version: 2,
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

  it("migrates legacy zero timeouts to unlimited so saved budgets stay stable", async () => {
    const storage = new MemoryStorage();
    const legacyNode = {
      id: "legacy-api",
      name: "旧接口",
      durationMs: 300,
      jitterMs: 0,
      dependencyIds: [] as string[],
      timeoutMs: 0,
      retryCount: 0,
      failureRate: 0,
    };
    storage.value = {
      version: 1,
      activeProjectId: EXAMPLE_PROJECT.id,
      projects: [
        {
          ...EXAMPLE_PROJECT,
          nodes: [legacyNode],
          scenarios: [
            {
              id: "legacy-scenario",
              name: "旧方案",
              createdAt: 1,
              concurrencyLimit: null,
              completionMs: 300,
              nodes: [{ ...legacyNode }],
              criticalPath: ["legacy-api"],
            },
          ],
        },
      ],
    };
    const loaded = await new ProjectRepository(storage).load();
    expect(loaded.recovered).toBe(true);
    const project = loaded.document.projects[0];
    expect(loaded.document.version).toBe(2);
    expect(project?.nodes[0]?.timeoutMs).toBeNull();
    // 历史数据里的 0 在旧推演中表示“不限制”，迁移后完成时间不变
    expect(project ? simulateProject(project).completionMs : 0).toBe(300);
    // 快照里的节点同样迁移，已保存的完成时间原样保留
    expect(project?.scenarios[0]?.nodes[0]?.timeoutMs).toBeNull();
    expect(project?.scenarios[0]?.completionMs).toBe(300);
  });

  it("keeps literal zero and unlimited timeouts distinct in current documents", async () => {
    const storage = new MemoryStorage();
    const repository = new ProjectRepository(storage);
    const [sessionNode, flagsNode] = EXAMPLE_PROJECT.nodes;
    if (!sessionNode || !flagsNode)
      throw new Error("Example project should have nodes");
    const zeroNode = { ...sessionNode, id: "zero", timeoutMs: 0 };
    const openNode = { ...flagsNode, id: "open", timeoutMs: null };
    const project = { ...EXAMPLE_PROJECT, nodes: [zeroNode, openNode] };
    const document: WorkspaceDocument = {
      version: 2,
      activeProjectId: project.id,
      projects: [project],
    };
    await repository.save(document);
    const loaded = await repository.load();
    expect(loaded.recovered).toBe(false);
    expect(loaded.document.projects[0]?.nodes[0]?.timeoutMs).toBe(0);
    expect(loaded.document.projects[0]?.nodes[1]?.timeoutMs).toBeNull();
  });
});
