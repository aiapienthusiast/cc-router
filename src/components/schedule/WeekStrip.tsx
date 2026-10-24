import { runs } from "@/lib/slotSchedule";

type Color = { bg: string; bar: string } | null;

/**
 * 一周色条: 336 个半小时格压成连续同色段, 每段按格数占宽。null = 此时无模型, 露出斜线底。
 * 宽度随父容器, 高度默认 10px。
 */
export function WeekStrip({ cells, height = 10, label }: { cells: Color[]; height?: number; label: string }) {
  return (
    <div className="sched-strip" role="img" aria-label={label} style={{ height }}>
      {runs(cells, (c) => (c ? `${c.bg}|${c.bar}` : "")).map((r) => (
        <span key={r.start} style={{ flexGrow: r.end - r.start, background: r.value?.bar ?? "transparent" }} />
      ))}
    </div>
  );
}
