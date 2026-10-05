import {
  EXAMPLE_PROJECT,
  type LatencyProject,
  type RequestNode,
  type ScenarioSnapshot,
  type WorkspaceDocument,
} from "../domain/types";
import { IndexedDbService } from "../services/indexedDbService";
import { migrateTimeoutMs } from "../domain/nodeFields";

const FALLBACK_KEY = "latency-lab.workspace.v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseNode(
  value: unknown,
  legacyZeroMeansNoTimeout: boolean,
): RequestNode | undefined {
  if (!isRecord(value)) return undefined;
  const {
    id,
    name,
    durationMs,
    jitterMs,
    dependencyIds,
    timeoutMs,
    retryCount,
    failureRate,
    fallbackNodeId,
  } = value;
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    !Array.isArray(dependencyIds)
  )
    return undefined;
  if (
    !isFiniteNumber(durationMs) ||
    !isFiniteNumber(jitterMs) ||
    !isFiniteNumber(timeoutMs) ||
    !isFiniteNumber(retryCount) ||
    !isFiniteNumber(failureRate)
  )
    return undefined;
  return {
    id,
    name,
    durationMs,
    jitterMs,
    dependencyIds: dependencyIds.filter(
      (id): id is string => typeof id === "string",
    ),
    // 只有 v1 历史数据里的 0 才迁移；v2 的 0 保留 0ms 本义。
    timeoutMs: legacyZeroMeansNoTimeout
      ? migrateTimeoutMs(timeoutMs)
      : timeoutMs,
    retryCount,
    failureRate,
    ...(typeof fallbackNodeId === "string" ? { fallbackNodeId } : {}),
  };
}

function parseScenario(
  value: unknown,
  legacyZeroMeansNoTimeout: boolean,
): ScenarioSnapshot | undefined {
  if (
    !isRecord(value) ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.criticalPath)
  )
    return undefined;
  const { id, name, createdAt, concurrencyLimit, completionMs } = value;
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    typeof createdAt !== "number" ||
    typeof completionMs !== "number"
  )
    return undefined;
  return {
    id,
    name,
    createdAt,
    completionMs,
    concurrencyLimit:
      typeof concurrencyLimit === "number" && concurrencyLimit > 0
        ? concurrencyLimit
        : null,
    nodes: value.nodes
      .map((node: unknown) => parseNode(node, legacyZeroMeansNoTimeout))
      .filter((node): node is RequestNode => Boolean(node)),
    criticalPath: value.criticalPath.filter(
      (id): id is string => typeof id === "string",
    ),
  };
}

function parseProject(
  value: unknown,
  legacyZeroMeansNoTimeout: boolean,
): { project: LatencyProject; recovered: boolean } | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.title !== "string"
  )
    return undefined;
  const sourceNodes = Array.isArray(value.nodes) ? value.nodes : [];
  const parsedNodes = sourceNodes.map((node) =>
    parseNode(node, legacyZeroMeansNoTimeout),
  );
  const nodes = parsedNodes.filter((node): node is RequestNode =>
    Boolean(node),
  );
  const nodeIds = new Set(nodes.map((node) => node.id));
  let recovered =
    !Array.isArray(value.nodes) || nodes.length !== sourceNodes.length;
  const safeNodes = nodes.map((node) => {
    const dependencyIds = node.dependencyIds.filter(
      (id) => id !== node.id && nodeIds.has(id),
    );
    const validFallback =
      node.fallbackNodeId &&
      node.fallbackNodeId !== node.id &&
      nodeIds.has(node.fallbackNodeId)
        ? node.fallbackNodeId
        : undefined;
    if (
      dependencyIds.length !== node.dependencyIds.length ||
      validFallback !== node.fallbackNodeId
    )
      recovered = true;
    return {
      ...node,
      dependencyIds,
      ...(validFallback
        ? { fallbackNodeId: validFallback }
        : { fallbackNodeId: undefined }),
    };
  });
  const scenarioSource = Array.isArray(value.scenarios) ? value.scenarios : [];
  const scenarios = scenarioSource
    .map((scenario) => parseScenario(scenario, legacyZeroMeansNoTimeout))
    .filter((scenario): scenario is ScenarioSnapshot => Boolean(scenario));
  if (
    !Array.isArray(value.scenarios) ||
    scenarios.length !== scenarioSource.length
  )
    recovered = true;
  const now = Date.now();
  const project: LatencyProject = {
    id: value.id,
    title: value.title,
    nodes: safeNodes,
    concurrencyLimit:
      typeof value.concurrencyLimit === "number" && value.concurrencyLimit > 0
        ? Math.floor(value.concurrencyLimit)
        : null,
    scenarios,
    createdAt:
      typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
        ? value.createdAt
        : now,
    updatedAt:
      typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt)
        ? value.updatedAt
        : now,
  };
  return { project, recovered };
}

function parseWorkspace(
  value: unknown,
): { document: WorkspaceDocument; recovered: boolean } | undefined {
  if (
    !isRecord(value) ||
    (value.version !== 1 && value.version !== 2) ||
    !Array.isArray(value.projects)
  )
    return undefined;
  // 仅 v1 沿用“0 = 不限制”的旧语义并迁移；v2 的 0 保持 0ms。
  const legacyZeroMeansNoTimeout = value.version === 1;
  const parsed = value.projects.map((project) =>
    parseProject(project, legacyZeroMeansNoTimeout),
  );
  const projects = parsed
    .filter((entry): entry is { project: LatencyProject; recovered: boolean } =>
      Boolean(entry),
    )
    .map((entry) => entry.project);
  if (!projects.length) return undefined;
  const firstProject = projects[0];
  if (!firstProject) return undefined;
  const activeProjectId = projects.some(
    (project) => project.id === value.activeProjectId,
  )
    ? String(value.activeProjectId)
    : firstProject.id;
  const recovered =
    projects.length !== parsed.length ||
    parsed.some((entry) => entry?.recovered);
  // v1 数据已完成语义迁移，统一按 v2 落库。
  return { document: { version: 2, activeProjectId, projects }, recovered };
}

export interface WorkspaceStorage {
  read(): Promise<unknown>;
  write(value: WorkspaceDocument): Promise<void>;
}

export class ProjectRepository {
  constructor(
    private readonly storage: WorkspaceStorage = new IndexedDbService(),
  ) {}

  async load(): Promise<{ document: WorkspaceDocument; recovered: boolean }> {
    try {
      const stored = parseWorkspace(await this.storage.read());
      if (stored) return stored;
      const local = localStorage.getItem(FALLBACK_KEY);
      if (local) {
        try {
          const fallback = parseWorkspace(JSON.parse(local) as unknown);
          if (fallback) return { ...fallback, recovered: true };
        } catch {
          localStorage.removeItem(FALLBACK_KEY);
        }
      }
    } catch {
      const local = localStorage.getItem(FALLBACK_KEY);
      if (local) {
        try {
          const fallback = parseWorkspace(JSON.parse(local) as unknown);
          if (fallback) return { ...fallback, recovered: true };
        } catch {
          localStorage.removeItem(FALLBACK_KEY);
        }
      }
    }
    return {
      document: {
        version: 2,
        activeProjectId: EXAMPLE_PROJECT.id,
        projects: [structuredClone(EXAMPLE_PROJECT)],
      },
      recovered: true,
    };
  }

  async save(document: WorkspaceDocument): Promise<void> {
    let indexedDbError: unknown;
    try {
      await this.storage.write(document);
    } catch (error) {
      indexedDbError = error;
    }
    try {
      localStorage.setItem(FALLBACK_KEY, JSON.stringify(document));
    } catch (error) {
      if (!indexedDbError) throw error;
    }
    if (indexedDbError) throw indexedDbError;
  }
}
