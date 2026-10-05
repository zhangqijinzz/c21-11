/**
 * 节点数值字段的面板契约：输入控件、校验与推演共用同一套上下限，
 * 避免面板允许的值在保存或推演时被另一种规则解释。
 *
 * 超时阈值以毫秒为单位：0 表示 0ms（立即截断单次耗时），
 * “不限制”使用显式哨兵，而不是复用 0，避免一个取值两种含义。
 */
export const NO_TIMEOUT_MS = -1;
export const MAX_DURATION_MS = 60_000;
/** 新建节点与取消“不限制”勾选时回填的默认阈值。 */
export const DEFAULT_TIMEOUT_MS = 1_200;

export interface NumericFieldRule {
  min: number;
  max: number;
  step: number;
}

export const NODE_FIELD_RULES = {
  durationMs: { min: 0, max: MAX_DURATION_MS, step: 10 },
  jitterMs: { min: 0, max: MAX_DURATION_MS, step: 10 },
  timeoutMs: { min: 0, max: MAX_DURATION_MS, step: 50 },
  retryCount: { min: 0, max: 8, step: 1 },
  failureRate: { min: 0, max: 100, step: 1 },
} satisfies Record<string, NumericFieldRule>;

export type NodeNumericField = keyof typeof NODE_FIELD_RULES;

/** 该取值是否为“不限制超时”哨兵。 */
export function isNoTimeout(value: number): boolean {
  return value === NO_TIMEOUT_MS;
}

/** 面板可保存的有限整数字段：必须落在面板上下限内且为整数。 */
export function isValidFiniteField(
  value: unknown,
  field: NodeNumericField,
): value is number {
  const rule = NODE_FIELD_RULES[field];
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= rule.min &&
    value <= rule.max
  );
}

/**
 * 超时阈值允许 0–60000ms 的整数，或“不限制”哨兵；
 * 其余负数、小数、超上限值一律拒绝。
 */
export function isValidTimeoutMs(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    (value === NO_TIMEOUT_MS || isValidFiniteField(value, "timeoutMs"))
  );
}

/**
 * 历史数据兼容：旧版本把 0 当作“不限制”。
 * 仅在读取存储时迁移为哨兵，推演与保存的新数据不再经过这里，
 * 保证老方案的完成预算不会因为 0 的含义变更而凭空变化。
 */
export function migrateTimeoutMs(value: number): number {
  return value === 0 ? NO_TIMEOUT_MS : value;
}

/**
 * 输入框清空视为“不限制”（与勾选框同义）；显式键入 0 仍是 0ms。
 * 无法解析的内容原样交给校验报错，不做静默改写。
 */
export function coerceTimeoutInput(raw: string): number {
  return raw.trim() === "" ? NO_TIMEOUT_MS : Number(raw);
}

/** “不限制”需要一个与毫秒不同的展示文案，避免快照对比里再出现歧义。 */
export function formatTimeoutMs(value: number): string {
  return value === NO_TIMEOUT_MS ? "不限制" : `${value} ms`;
}
