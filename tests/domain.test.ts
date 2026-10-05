import { describe, expect, it } from "vitest";
import { analyzeGraph } from "../src/shared/domain/graph";
import { EXAMPLE_PROJECT, type RequestNode } from "../src/shared/domain/types";
import { simulateProject } from "../src/shared/domain/simulation";
import {
  addRequestNode,
  toggleDependency,
} from "../src/features/graph-editor/graphViewModel";
import {
  MAX_DURATION_MS,
  NO_TIMEOUT_MS,
  coerceTimeoutInput,
  formatTimeoutMs,
} from "../src/shared/domain/nodeFields";

function singleNodeProject(patch: Partial<RequestNode>) {
  const node = {
    id: "only",
    name: "单节点",
    durationMs: 500,
    jitterMs: 0,
    dependencyIds: [],
    timeoutMs: 1000,
    retryCount: 0,
    failureRate: 0,
    ...patch,
  };
  return { ...EXAMPLE_PROJECT, nodes: [node] };
}

describe("request dependency graph", () => {
  it("orders a DAG and detects a cycle before simulation", () => {
    const project = structuredClone(EXAMPLE_PROJECT);
    expect(analyzeGraph(project).order).toHaveLength(project.nodes.length);
    const cyclic = {
      ...project,
      nodes: project.nodes.map((node) =>
        node.id === "session" ? { ...node, dependencyIds: ["profile"] } : node,
      ),
    };
    expect(analyzeGraph(cyclic).validation.errors.join(" ")).toContain(
      "循环依赖",
    );
    expect(simulateProject(cyclic).entries).toHaveLength(0);
  });

  it("rejects cyclic edges and accepts valid dependencies", () => {
    const project = {
      ...EXAMPLE_PROJECT,
      nodes: EXAMPLE_PROJECT.nodes.slice(0, 3),
    };
    const accepted = toggleDependency(project, "profile", "flags");
    expect(accepted.error).toBeUndefined();
    const rejected = toggleDependency(accepted.project, "flags", "profile");
    expect(rejected.error).toContain("循环");
    expect(rejected.project).toEqual(accepted.project);
  });

  it("schedules independent roots in parallel and serializes them at concurrency one", () => {
    const project = {
      ...EXAMPLE_PROJECT,
      nodes: EXAMPLE_PROJECT.nodes.slice(0, 2).map((node) => ({
        ...node,
        durationMs: 300,
        jitterMs: 0,
        timeoutMs: 1000,
        retryCount: 0,
        failureRate: 0,
      })),
    };
    const parallel = simulateProject(project);
    const serial = simulateProject({ ...project, concurrencyLimit: 1 });
    expect(parallel.completionMs).toBe(300);
    expect(serial.completionMs).toBe(600);
    expect(serial.entries[1]?.waitMs).toBe(300);
  });

  it("applies jitter modes, timeout caps, bounded retries, and fallback probability", () => {
    const node = {
      id: "a",
      name: "slow",
      durationMs: 1200,
      jitterMs: 400,
      dependencyIds: [],
      timeoutMs: 1000,
      retryCount: 1,
      failureRate: 50,
      fallbackNodeId: "b",
    };
    const fallback = {
      ...node,
      id: "b",
      name: "fallback",
      durationMs: 200,
      jitterMs: 0,
      timeoutMs: 500,
      retryCount: 0,
      failureRate: 0,
      fallbackNodeId: undefined,
    };
    const project = { ...EXAMPLE_PROJECT, nodes: [node, fallback] };
    const low = simulateProject(project, "low");
    const expected = simulateProject(project, "expected");
    const high = simulateProject(project, "high");
    expect(low.completionMs).toBeLessThanOrEqual(expected.completionMs);
    expect(expected.completionMs).toBeLessThanOrEqual(high.completionMs);
    expect(high.warnings.join(" ")).toContain("超时");
    expect(high.entries[0]?.modeledDurationMs).toBe(1650);
    const invalid = {
      ...project,
      nodes: [{ ...node, retryCount: 9 }, fallback],
    };
    expect(simulateProject(invalid).entries).toHaveLength(0);
  });

  it("creates an editable request node with safe defaults", () => {
    const project = { ...EXAMPLE_PROJECT, nodes: [] };
    const next = addRequestNode(project);
    expect(next.nodes).toHaveLength(1);
    expect(next.nodes[0]?.durationMs).toBe(400);
    expect(next.nodes[0]?.dependencyIds).toEqual([]);
  });
});

describe("timeout threshold semantics", () => {
  it("treats 0 as a 0ms threshold that truncates the attempt immediately", () => {
    const zero = singleNodeProject({ durationMs: 500, timeoutMs: 0 });
    const result = simulateProject(zero, "high");
    expect(result.entries).toHaveLength(1);
    expect(result.completionMs).toBe(0);
    expect(result.warnings.join(" ")).toContain("超时");
  });

  it("uses only the explicit sentinel for an unbounded timeout", () => {
    const unbounded = singleNodeProject({
      durationMs: 500,
      timeoutMs: NO_TIMEOUT_MS,
    });
    const result = simulateProject(unbounded, "high");
    expect(result.completionMs).toBe(500);
    expect(result.warnings.join(" ")).not.toContain("超时");
  });

  it("distinguishes the same graph under 0ms, finite and unbounded thresholds", () => {
    const atZero = simulateProject(
      singleNodeProject({ durationMs: 500, timeoutMs: 0 }),
      "expected",
    ).completionMs;
    const finite = simulateProject(
      singleNodeProject({ durationMs: 500, timeoutMs: 300 }),
      "expected",
    ).completionMs;
    const unbounded = simulateProject(
      singleNodeProject({ durationMs: 500, timeoutMs: NO_TIMEOUT_MS }),
      "expected",
    ).completionMs;
    expect(atZero).toBe(0);
    expect(finite).toBe(300);
    expect(unbounded).toBe(500);
  });

  it("rejects negative, decimal and over-limit thresholds like the panel limits", () => {
    for (const timeoutMs of [-2, 0.5, MAX_DURATION_MS + 1, Number.NaN]) {
      const errors = analyzeGraph(
        singleNodeProject({ timeoutMs }),
      ).validation.errors.join(" ");
      expect(errors).toContain("超时");
    }
    expect(
      analyzeGraph(singleNodeProject({ timeoutMs: NO_TIMEOUT_MS })).validation
        .errors,
    ).toEqual([]);
  });

  it("rejects decimals and over-limit values for the other numeric fields", () => {
    expect(
      analyzeGraph(
        singleNodeProject({ durationMs: 12.5 }),
      ).validation.errors.join(" "),
    ).toContain("预计耗时");
    expect(
      analyzeGraph(
        singleNodeProject({ durationMs: MAX_DURATION_MS + 1 }),
      ).validation.errors.join(" "),
    ).toContain("预计耗时");
    expect(
      analyzeGraph(singleNodeProject({ jitterMs: -1 })).validation.errors.join(
        " ",
      ),
    ).toContain("延迟波动");
    expect(
      analyzeGraph(
        singleNodeProject({ failureRate: 2.5 }),
      ).validation.errors.join(" "),
    ).toContain("失败概率");
  });

  it("maps a cleared input to the sentinel while an explicit 0 stays 0ms", () => {
    expect(coerceTimeoutInput("")).toBe(NO_TIMEOUT_MS);
    expect(coerceTimeoutInput("   ")).toBe(NO_TIMEOUT_MS);
    expect(coerceTimeoutInput("0")).toBe(0);
    expect(formatTimeoutMs(NO_TIMEOUT_MS)).toBe("不限制");
    expect(formatTimeoutMs(0)).toBe("0 ms");
  });
});
