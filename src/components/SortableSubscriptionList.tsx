import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useMemo } from "react";
import { Link } from "react-router";
import { GripVertical, X } from "lucide-react";
import { ProviderLogo } from "@/components/ProviderLogo";
import { stateTone } from "@/components/StatusBadge";
import { WeekStrip } from "@/components/schedule/WeekStrip";
import { useHostClock } from "@/hooks/useHostClock";
import { useRouteFlashState } from "@/hooks/useRouteFlash";
import { useT } from "@/i18n";
import { isAnthropicPassthrough } from "@/lib/authTypes";
import { modelColor } from "@/lib/modelColor";
import { weekCells } from "@/lib/slotSchedule";
import { slotModelAt, slotNow, slotNowText, slotSummaryText, type SlotNowView } from "@/lib/slotNow";
import { jevModelOf } from "@/lib/virtualModels";
import type { SubscriptionDto, SubscriptionSlot, VirtualModelName } from "@/types";

type Color = { bg: string; bar: string };

interface Props {
  subscriptionIds: string[];
  subscriptions: Map<string, SubscriptionDto>;
  /** null 表示 fallback 模式: 订阅会原样透传请求 model,不走 slot 映射 */
  slot: SubscriptionSlot | null;
  /** 用于关联实时路由事件: 同一订阅在不同 vm 槽位下独立闪烁 */
  vmName: VirtualModelName;
  /** 本卡片的模型配色表 (vmModelColors); 给了就在行尾画该订阅本槽位的一周小条 */
  colors?: Map<string, Color>;
  /** 卡片展开「一周时段」时为真: 四槽位行再加配置摘要与「编辑槽位」链接 */
  detailed?: boolean;
  onChange: (ids: string[]) => void;
  onRemove: (id: string) => void;
}

export function SortableSubscriptionList({
  subscriptionIds,
  subscriptions,
  slot,
  vmName,
  colors,
  detailed = false,
  onChange,
  onRemove,
}: Props) {
  const { t } = useT();
  const clock = useHostClock();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = subscriptionIds.indexOf(String(active.id));
    const newIndex = subscriptionIds.indexOf(String(over.id));
    if (oldIndex < 0 || newIndex < 0) return;
    onChange(arrayMove(subscriptionIds, oldIndex, newIndex));
  }

  if (subscriptionIds.length === 0) {
    return <div className="endpoint-empty compact">{t("sortableSub.empty")}</div>;
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={subscriptionIds} strategy={verticalListSortingStrategy}>
        <div className="endpoint-list">
          {subscriptionIds.map((id, idx) => {
            const sub = subscriptions.get(id);
            // fallback 卡片三态: 配置了兜底槽 → 槽值; 未配置且透传类 → 「原样透传」;
            // 未配置且翻译类 → 警示 (dispatch 层会跳过该候选)。
            const isJevCard = vmName === "model-jev";
            const fallbackModel = sub?.model_slots.fallback?.trim() ?? "";
            // 四槽位: 按宿主机此刻求值 (分时段规则), 不再直接显示默认值
            const slotView = !isJevCard && slot !== null && sub ? slotNow(sub, slot, clock) : null;
            const realModel = isJevCard
              ? (sub && jevModelOf(sub)) || t("sortableSub.passthrough")
              : slot === null
                ? fallbackModel || t("sortableSub.passthrough")
                : slotView
                  ? slotNowText(slotView, t)
                  : "?";
            const fallbackSkipped =
              !isJevCard && slot === null && !fallbackModel && !!sub && !isAnthropicPassthrough(sub.auth_type);
            return (
              <SortableRow
                key={id}
                id={id}
                vmName={vmName}
                priority={idx + 1}
                sub={sub}
                iconId={sub?.provider_icon}
                realModel={realModel}
                slotView={slotView}
                slot={slot}
                colors={colors}
                detailed={detailed}
                fallbackSkipped={fallbackSkipped}
                onRemove={() => onRemove(id)}
              />
            );
          })}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function SortableRow({
  id,
  vmName,
  priority,
  sub,
  iconId,
  realModel,
  slotView,
  slot,
  colors,
  detailed,
  fallbackSkipped,
  onRemove,
}: {
  id: string;
  vmName: VirtualModelName;
  priority: number;
  sub: SubscriptionDto | undefined;
  iconId: string | undefined;
  realModel: string;
  /** 四槽位卡片: 此刻生效模型的显示信息; fallback / jev 为 null */
  slotView: SlotNowView | null;
  slot: SubscriptionSlot | null;
  colors?: Map<string, Color>;
  detailed: boolean;
  /** fallback 卡片专用: 翻译类订阅未配置兜底槽, dispatch 会跳过 → 显示警示替代模型名 */
  fallbackSkipped?: boolean;
  onRemove: () => void;
}) {
  const { t } = useT();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const flash = useRouteFlashState(vmName, id);
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };

  const tone = sub ? stateTone(sub.state) : "neutral";
  const dotClass =
    tone === "ok" ? "" : tone === "err" ? " err" : tone === "warn" ? " warn" : " idle";
  const flashClass = flash ? ` route-flash-${flash.kind}` : "";

  // 该订阅本槽位一周何时可用 (只看时段规则, 与编辑页预览同口径)
  const stripCells = useMemo(() => {
    if (!colors || !sub || slot === null) return null;
    return weekCells((at) => {
      const m = slotModelAt(sub, slot, at);
      return m === null ? null : (colors.get(m) ?? modelColor(m));
    });
  }, [colors, sub, slot]);

  return (
    <div ref={setNodeRef} style={style} className={`endpoint compact${flashClass}`}>
      <button className="grip" {...attributes} {...listeners} type="button" aria-label={t("sortableSub.dragHandle")}>
        <GripVertical size={12} strokeWidth={1.6} />
      </button>
      <span className="priority mono">{priority}</span>
      <ProviderLogo iconId={iconId} size={18} iconSize={11} />
      <div className="endpoint-info">
        <div className="endpoint-name">
          <span className={`endpoint-status${dotClass}`} aria-hidden />
          {sub?.display_name ?? t("common.notFound")}
        </div>
        {fallbackSkipped ? (
          <div className="endpoint-model">
            <span className="pill err">{t("sortableSub.fallbackSkipped")}</span>
          </div>
        ) : slotView?.neverCalled ? (
          <div className="endpoint-model">
            <span className="pill warn">{realModel}</span>
          </div>
        ) : (
          <>
            <div className={slotView && slotView.model === null ? "endpoint-model off" : "endpoint-model mono"}>
              {realModel}
            </div>
            {slotView?.scheduled && <span className="slot-now-mark">{t("schedule.now.scheduled")}</span>}
          </>
        )}
      </div>
      {detailed && slotView && sub && slot !== null && (
        <>
          {/* 默认为空且无规则时摘要为 null: 行内已有「不会被调用」 */}
          <span className="endpoint-summary">{slotSummaryText(sub, slot, t)}</span>
          <Link className="endpoint-edit-link" to={`/subscriptions/${sub.id}`}>
            {t("schedule.summary.edit")}
          </Link>
        </>
      )}
      {stripCells && (
        <div className="endpoint-week">
          <WeekStrip
            cells={stripCells}
            height={8}
            label={t("schedule.week.rowStripAria", { name: sub?.display_name ?? "", slot: `model-${slot}` })}
          />
        </div>
      )}
      <button className="remove" onClick={onRemove} type="button" aria-label={t("sortableSub.remove")}>
        <X size={12} strokeWidth={2} />
      </button>
    </div>
  );
}
