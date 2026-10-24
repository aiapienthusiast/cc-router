import { Fragment, useId, useMemo, useState } from "react";
import { Clock } from "lucide-react";
import { useT } from "@/i18n";
import { useHostClock } from "@/hooks/useHostClock";
import { modelColor } from "@/lib/modelColor";
import { clockAt, weekCells, HALF_HOURS, type WallClock } from "@/lib/slotSchedule";
import type { SubscriptionDto, VirtualModelDto } from "@/types";
import { DayTypeCalendar, hhmm, type Cell } from "./DayTypeCalendar";
import { RouteNow } from "./RouteNow";
import {
  candidateChain,
  chainKey,
  neutralShade,
  routeNodes,
  uncoveredHours,
  vmModelColors,
  type ChainLink,
} from "./weekChain";

export { candidateChain } from "./weekChain";

/** 墙钟 → 半小时下标 (0 = 周一 00:00)。 */
const indexOf = (c: WallClock) => (c.weekday - 1) * 48 + Math.floor(c.minute / 30);

/**
 * 虚拟模型卡片展开后的「一周时段」: 左边按完整候选链合并的日程, 右边某一刻的路由小图,
 * 下面时间拖动条 +「现在」与那一刻的完整候选链。点日程 / 拖动条 → 路由图跳到那一刻。
 * 只给四个槽位的虚拟模型用 (fallback / jev 不受时段影响, 调用方不渲染)。
 */
export function WeekSchedulePanel({ vm, subsMap }: { vm: VirtualModelDto; subsMap: Map<string, SubscriptionDto> }) {
  const { t } = useT();
  const host = useHostClock();
  // null = 跟随宿主机此刻; 点日程 / 拖动条后钉在那一刻, 点「现在」回到跟随
  const [pinned, setPinned] = useState<WallClock | null>(null);
  const scrubId = useId();

  const colors = useMemo(() => vmModelColors(vm, subsMap), [vm, subsMap]);
  const chains = useMemo(() => weekCells((at) => candidateChain(vm, subsMap, at)), [vm, subsMap]);
  const sequential = vm.mode === "sequential";

  const cells = useMemo<Cell[]>(
    () =>
      chains.map((chain) => {
        if (chain.length === 0) return { key: "", title: "", color: null };
        const key = chainKey(chain);
        if (!sequential) {
          return {
            key,
            title: t("schedule.week.participants", { n: chain.length }),
            subtitle: chain.map((c) => c.sub.display_name).join(t("schedule.day.listSep")),
            color: neutralShade(chain.length, vm.subscription_ids.length),
          };
        }
        const model = chain[0].model;
        return { key, title: chain[0].sub.display_name, subtitle: model, color: colors.get(model) ?? modelColor(model) };
      }),
    [chains, colors, sequential, vm.subscription_ids.length, t],
  );
  const gapHours = uncoveredHours(chains);

  const cursorIdx = pinned ? indexOf(pinned) : host ? indexOf(host) : null;
  const at = cursorIdx === null ? null : clockAt(cursorIdx);
  const isNow = cursorIdx !== null && host !== null && cursorIdx === indexOf(host);
  const chain: ChainLink[] = cursorIdx === null ? [] : chains[cursorIdx];
  const timeText = at ? `${t("schedule.day.one", { d: t(`schedule.wd.${at.weekday}`) })} ${hhmm(at.minute)}` : "—";

  return (
    <section className="vm-week" aria-label={t("schedule.week.title")}>
      <div className="vm-week-head">
        <h3>{t("schedule.week.title")}</h3>
        <span className="vm-week-desc">{t("schedule.week.desc")}</span>
        <span className={gapHours > 0 ? "pill err vm-week-cover" : "pill ok vm-week-cover"}>
          {gapHours > 0 ? t("schedule.week.coverGap", { n: gapHours }) : t("schedule.week.coverFull")}
        </span>
      </div>

      <div className="vm-week-grid">
        <DayTypeCalendar cells={cells} cursor={at} onPick={setPinned} emptyLabel="no_candidate" />
        {at && <RouteNow vmName={vm.name} mode={vm.mode} nodes={routeNodes(vm, subsMap, at, isNow, colors)} />}
      </div>

      <div className="vm-week-scrub">
        <button
          type="button"
          className="vm-week-now"
          aria-pressed={isNow}
          disabled={!host}
          onClick={() => setPinned(null)}
        >
          <Clock size={14} aria-hidden /> {t("schedule.week.now")}
        </button>
        <label htmlFor={scrubId} className="sr-only">
          {t("schedule.week.time")}
        </label>
        <input
          id={scrubId}
          type="range"
          min={0}
          max={HALF_HOURS - 1}
          step={1}
          value={cursorIdx ?? 0}
          aria-valuetext={timeText}
          onChange={(e) => setPinned(clockAt(Number(e.target.value)))}
        />
        <span className="vm-week-time mono">{timeText}</span>
      </div>

      <div className="vm-week-chain">
        <span className="vm-week-chain-label">
          {sequential ? t("schedule.week.chain") : t("schedule.week.participantsLabel")}
        </span>
        {chain.length === 0 ? (
          at && <span className="vm-week-chain-empty">{t("schedule.week.chainEmpty")}</span>
        ) : (
          chain.map((c, i) => (
            <Fragment key={c.sub.id}>
              <span className={i === 0 && sequential ? "vm-week-chain-item first" : "vm-week-chain-item"}>
                {c.sub.display_name} · <span className="mono">{c.model}</span>
              </span>
              {i < chain.length - 1 && (
                <span className="vm-week-chain-sep" aria-hidden>
                  {sequential ? "→" : "/"}
                </span>
              )}
            </Fragment>
          ))
        )}
      </div>

      {colors.size > 0 && (
        <div className="vm-week-legend">
          {[...colors].map(([m, c]) => (
            <span key={m} className="vm-week-legend-item">
              <span className="vm-week-swatch" style={{ background: c.bg, borderLeftColor: c.bar }} />
              <span className="mono">{m}</span>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
