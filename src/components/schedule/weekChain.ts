// 虚拟模型页「一周时段」的纯计算: 某一时刻的候选链、一周色条、无可用小时数、路由小图节点。
// 纯 TS (scripts/check-slot-schedule.mjs 直接 import): 只许 type-only import 与同样纯的模块。
//
// 图的口径 (spec §6.3): 按时段规则算, 再叠加稳定状态 —— 停用与凭证失效的订阅全周不可用;
// 冷却 / 限流 / 限额这类会自己恢复的瞬时状态不进一周图, 只在路由小图的「现在」时刻打状态点。
import { assignModelColors } from "@/lib/modelColor";
import { weekCells, type WallClock } from "@/lib/slotSchedule";
import { slotModelAt } from "@/lib/slotNow";
import { vmNameToSlot } from "@/lib/virtualModels";
import type { FourSlot, SubscriptionDto, VirtualModelDto } from "@/types";
import type { RouteNowNode } from "./RouteNow";

type Color = { bg: string; bar: string };
export type ChainLink = { sub: SubscriptionDto; model: string };

/** 停用与凭证失效需要用户介入, 视为全周不可用。 */
export function stablyAvailable(sub: SubscriptionDto): boolean {
  return sub.enabled !== false && sub.state !== "auth_failed";
}

/** fallback / jev 不受四槽时段影响, 返回 null。 */
function fourSlotOf(vm: VirtualModelDto): FourSlot | null {
  return vmNameToSlot(vm.name);
}

/** at 时刻的候选链: 按绑定顺序, 只留稳定可用且此刻有生效模型的订阅。fallback / jev 为空。 */
export function candidateChain(
  vm: VirtualModelDto,
  subsMap: Map<string, SubscriptionDto>,
  at: WallClock,
): ChainLink[] {
  const slot = fourSlotOf(vm);
  if (slot === null) return [];
  const out: ChainLink[] = [];
  for (const id of vm.subscription_ids) {
    const sub = subsMap.get(id);
    if (!sub || !stablyAvailable(sub)) continue;
    const model = slotModelAt(sub, slot, at);
    if (model !== null) out.push({ sub, model });
  }
  return out;
}

/** 日程合并用的 key: 完整候选链。空链为空串, 非空链总含「|」, 两者不会相同。 */
export function chainKey(chain: ChainLink[]): string {
  return chain.map((c) => `${c.sub.id}|${c.model}`).join(">");
}

/** 本视图 (一张虚拟模型卡片) 出现的全部模型: 绑定订阅本槽位的默认值与规则模型, 一张配色表共用。 */
export function vmModelColors(vm: VirtualModelDto, subsMap: Map<string, SubscriptionDto>): Map<string, Color> {
  const slot = fourSlotOf(vm);
  const models: string[] = [];
  if (slot !== null) {
    for (const id of vm.subscription_ids) {
      const sub = subsMap.get(id);
      if (!sub) continue;
      const def = (sub.model_slots[slot] ?? "").trim();
      if (def) models.push(def);
      for (const r of sub.slot_schedules?.[slot] ?? []) {
        const m = r.model.trim();
        if (m) models.push(m);
      }
    }
  }
  return assignModelColors(models);
}

/** 轮询 / 会话亲和没有固定首选: 中性色, 参与的订阅越多越深。 */
export function neutralShade(n: number, max: number): Color {
  const r = max > 0 ? Math.min(1, n / max) : 0;
  return {
    bg: `color-mix(in srgb, var(--ink-4) ${Math.round(12 + 30 * r)}%, var(--surface-2))`,
    bar: `color-mix(in srgb, var(--ink-2) ${Math.round(25 + 55 * r)}%, var(--surface-2))`,
  };
}

/** 一周 336 格的颜色: 顺序模式按首选模型, 轮询 / 亲和按参与数; 无可用为 null。 */
export function vmWeekCells(
  vm: VirtualModelDto,
  subsMap: Map<string, SubscriptionDto>,
  colors: Map<string, Color>,
): (Color | null)[] {
  const max = vm.subscription_ids.length;
  return weekCells((at) => {
    const chain = candidateChain(vm, subsMap, at);
    if (chain.length === 0) return null;
    if (vm.mode !== "sequential") return neutralShade(chain.length, max);
    return colors.get(chain[0].model) ?? null;
  });
}

/** 一周 336 格的候选链里为空 (请求会 503) 的小时数。 */
export function uncoveredHours(chains: ChainLink[][]): number {
  return chains.filter((c) => c.length === 0).length / 2;
}

/**
 * 路由小图的节点: 全部绑定订阅按顺序, 第一个可用的为首选, 其后可用的为备选, 其余不可用。
 * isNow 为真 (游标就在宿主机此刻) 时才给可用节点标瞬时状态。
 */
export function routeNodes(
  vm: VirtualModelDto,
  subsMap: Map<string, SubscriptionDto>,
  at: WallClock,
  isNow: boolean,
  colors: Map<string, Color>,
): RouteNowNode[] {
  const slot = fourSlotOf(vm);
  if (slot === null) return [];
  let seenFirst = false;
  const out: RouteNowNode[] = [];
  for (const id of vm.subscription_ids) {
    const sub = subsMap.get(id);
    if (!sub) continue;
    const model = stablyAvailable(sub) ? slotModelAt(sub, slot, at) : null;
    const rank = model === null ? "off" : seenFirst ? "backup" : "first";
    if (model !== null) seenFirst = true;
    out.push({
      name: sub.display_name,
      model,
      rank,
      color: model !== null ? colors.get(model) : undefined,
      status: model !== null && isNow ? transientStatus(sub) : null,
    });
  }
  return out;
}

function transientStatus(sub: SubscriptionDto): RouteNowNode["status"] {
  if (sub.state === "rate_limited") return "rate_limited";
  if (sub.state === "transient_error" || sub.state === "quota_exhausted") return "cooldown";
  return null;
}
