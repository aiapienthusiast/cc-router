import { Fragment } from "react";
import { useT } from "@/i18n";
import { modelColor } from "@/lib/modelColor";
import type { RoutingMode } from "@/types";

export type RouteNowNode = {
  name: string;
  /** 该时刻的生效模型; null = 此时不提供 */
  model: string | null;
  rank: "first" | "backup" | "off";
  /** 该模型在本视图的配色 (assignModelColors), 与日程 / 色条一致; 缺省退回 modelColor */
  color?: { bg: string; bar: string };
  /** 瞬时状态, 只在「现在」时刻由调用方给出 */
  status?: "cooldown" | "rate_limited" | "quota" | null;
};

// 画布几何 (px)。TS 与 styles.css 的 .sched-rn-* 成对: 盒子尺寸在这里, 字号 / 描边在 CSS。
const W = 410;
const HUB_W = 104;
const NODE_LEFT = 150;
const NODE_W = 124;
const NODE_H = 44;
const INFO_LEFT = 288;
const STEP = 88;
const MIN_H = 120;

type Tone = "first" | "backup" | "on" | "off";

const STATUS_KEY: Record<NonNullable<RouteNowNode["status"]>, string> = {
  cooldown: "schedule.route.cooldown",
  rate_limited: "schedule.route.rateLimited",
  quota: "schedule.route.quotaFull",
};

/**
 * 某一时刻的路由小图: 左边虚拟模型, 右边按候选顺序排的订阅。
 * 顺序模式: 首选实线 + 陶土色描边, 备选虚线; 轮询 / 会话亲和没有固定首选, 可用的都画实线。
 * 不可用的一律灰。连线沿用 SketchDefs 的 #ccr-rough-canvas 抖动。
 */
export function RouteNow({ vmName, nodes, mode }: { vmName: string; nodes: RouteNowNode[]; mode: RoutingMode }) {
  const { t } = useT();
  const n = nodes.length;
  const h = Math.max(MIN_H, n * STEP + 36);
  const hubCy = h / 2;
  const top0 = (h - ((n - 1) * STEP + NODE_H)) / 2;
  // 没有生效模型的节点一律按不可用画, 连线 / 标签与「此时不可用」一致
  const toneOf = (node: RouteNowNode): Tone =>
    node.rank === "off" || node.model === null ? "off" : mode !== "sequential" ? "on" : node.rank;
  const tagOf: Record<Tone, string> = {
    first: t("schedule.route.first"),
    backup: t("schedule.route.backup"),
    on: t("schedule.route.participating"),
    off: "—",
  };

  return (
    <div className="sched-rn-wrap">
      <div
        className="sched-rn"
        style={{ width: W, height: h }}
        role="group"
        aria-label={t("schedule.route.aria", { vm: vmName })}
      >
        <svg className="sched-rn-edges" width={W} height={h} viewBox={`0 0 ${W} ${h}`} aria-hidden>
          <g filter="url(#ccr-rough-canvas)">
            {/* 撑满画布的隐形框: 只剩一条水平连线时组的包围盒高度为 0, 滤镜会把线吞掉 */}
            <rect width={W} height={h} fill="none" stroke="none" />
            {nodes.map((node, i) => {
              const y = top0 + i * STEP + NODE_H / 2;
              const tone = toneOf(node);
              return (
                <g key={i} className={`sched-rn-edge ${tone}`}>
                  <path d={`M${HUB_W} ${hubCy} C ${HUB_W + 24} ${hubCy} ${NODE_LEFT - 26} ${y} ${NODE_LEFT - 4} ${y}`} />
                  <path className="head" d={`M${NODE_LEFT - 10} ${y - 4} L${NODE_LEFT - 4} ${y} L${NODE_LEFT - 10} ${y + 4}`} />
                </g>
              );
            })}
          </g>
        </svg>

        <div className="sched-rn-hub mono" style={{ top: hubCy - NODE_H / 2, width: HUB_W, height: NODE_H }} title={vmName}>
          {vmName}
        </div>

        {nodes.map((node, i) => {
          const top = top0 + i * STEP;
          const tone = toneOf(node);
          const on = tone !== "off";
          return (
            <Fragment key={i}>
              <div
                className={`sched-rn-node ${tone}`}
                style={{ top, left: NODE_LEFT, width: NODE_W, height: NODE_H }}
                title={node.name}
              >
                {node.name}
              </div>
              <div className="sched-rn-info" style={{ top: top + 3, left: INFO_LEFT, width: W - INFO_LEFT }}>
                <div className={on ? "sched-rn-model mono" : "sched-rn-model mono off"} title={node.model ?? undefined}>
                  {on ? node.model : t("schedule.route.unavailable")}
                </div>
                <div className="sched-rn-meta">
                  <span
                    className="sched-rn-swatch"
                    style={{ background: on ? (node.color ?? modelColor(node.model!)).bar : "var(--line)" }}
                  />
                  <span>{tagOf[tone]}</span>
                  {node.status && (
                    <span className={`sched-rn-status ${node.status}`}>
                      {t(STATUS_KEY[node.status])}
                    </span>
                  )}
                </div>
              </div>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
