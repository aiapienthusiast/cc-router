#!/usr/bin/env node
// 槽位分时段规则的前端求值检查 (零依赖, Node 22.18+ 原生 type stripping 直接 import 纯 TS 模块)。
//   1. src/lib/slot-schedule-cases.json: 与 Rust `subscription::schedule` 的测试读同一份
//   2. 日型分组 / 遮蔽检测 / 校验 / 时段合并 / 色块稳定性
//   3. 源码扫描: 求值与日历组件不得用 `new Date(` 推算星期 / 时刻
import { registerHooks } from "node:module";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SRC = `${ROOT}src/`;

// 与 check-i18n.mjs 相同的解析钩子: `@/x` → src/x(.ts); `.ts` 里的无扩展名相对路径补 `.ts`
const isFile = (p) => existsSync(p) && statSync(p).isFile();
registerHooks({
  resolve(specifier, context, nextResolve) {
    const fromTs = context.parentURL?.endsWith(".ts");
    let base = null;
    if (specifier.startsWith("@/")) base = SRC + specifier.slice(2);
    else if (fromTs && specifier.startsWith(".") && !/\.[cm]?[jt]sx?$|\.json$/.test(specifier)) {
      base = fileURLToPath(new URL(specifier, context.parentURL));
    }
    if (base) {
      for (const cand of [base, `${base}.ts`, `${base}/index.ts`]) {
        if (isFile(cand)) return { url: pathToFileURL(cand).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

const failures = [];
const check = (name, ok, detail = "") => {
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const readJson = (rel) => JSON.parse(readFileSync(ROOT + rel, "utf8"));

const {
  effectiveModel, clockAt, weekCells, groupDayTypes, runs, weeklyHours, ruleIssues, validateRules, HALF_HOURS,
  dayPreset, DAY_PRESETS, crossesMidnight, normalizeSchedules, schedulesEqual,
} = await import("../src/lib/slotSchedule.ts");
const { modelColor, assignModelColors } = await import("../src/lib/modelColor.ts");

// ---- 1. 共享用例表 ----
const toMinute = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
const cases = readJson("src/lib/slot-schedule-cases.json");
check("用例表非空", cases.length >= 15, `实际 ${cases.length}`);
for (const c of cases) {
  const got = effectiveModel(c.default, c.rules, { weekday: c.at.weekday, minute: toMinute(c.at.time) });
  check(`case: ${c.name}`, got === c.expect, `期望 ${JSON.stringify(c.expect)}, 实际 ${JSON.stringify(got)}`);
}

// 用例表没钉住的求值行为 (Rust 侧有对应单测)
const R = (days, start, end, model) => ({ days, start, end, model });
const ALL = [1, 2, 3, 4, 5, 6, 7];
const mon10 = { weekday: 1, minute: 600 };
check("畸形规则被跳过", effectiveModel("", [R([1], "garbage", "18:00", "bad"), R([1], "8:00", "18:00", "bad"), R([1], "24:00", "08:00", "bad"), R([1], "08:00", "08:00", "bad"), R([1], "08:00", "18:00", "good")], mon10) === "good");
check("结果 trim", effectiveModel("", [R([1], "08:00", "18:00", "  m  ")], mon10) === "m");
check("默认值 trim", effectiveModel(" d ", [], mon10) === "d");

// ---- 2. 分组 / 遮蔽 / 校验 ----
const qoder = [R([1, 2, 3, 4, 5], "08:00", "18:00", "deepseek-4.1"), R([1, 2, 3, 4, 5], "18:00", "08:00", "qwen-max")];
const qCells = weekCells((at) => effectiveModel("", qoder, at));
check("weekCells 长度", qCells.length === HALF_HOURS && HALF_HOURS === 336);
check("clockAt(0)=周一 00:00", same(clockAt(0), { weekday: 1, minute: 0 }));
check("clockAt(335)=周日 23:30", same(clockAt(335), { weekday: 7, minute: 1410 }));
const groups = groupDayTypes(qCells, (v) => v ?? "");
check("qoder 日型分组", same(groups.map((g) => g.days), [[1], [2, 3, 4, 5], [6], [7]]), JSON.stringify(groups.map((g) => g.days)));
check("每组 48 格", groups.every((g) => g.cells.length === 48));

const shadow = ruleIssues([R(ALL, "00:00", "24:00", "a"), R(ALL, "10:00", "11:00", "b")]);
check("被盖住的规则报 shadowed", same(shadow, [{ index: 1, kind: "shadowed" }]), JSON.stringify(shadow));
check("正常规则无提示", ruleIssues(qoder).length === 0);
// 「被上面的时段盖住」只看排在前面的规则: 被后面的同模型规则覆盖不算, 重复规则只报后一条
check("被后面的规则覆盖不算被盖住", ruleIssues([R(ALL, "10:00", "11:00", "a"), R(ALL, "00:00", "24:00", "a")]).length === 0);
check("重复规则只报后一条", same(ruleIssues([R(ALL, "00:00", "08:00", "a"), R(ALL, "00:00", "08:00", "a")]), [{ index: 1, kind: "shadowed" }]));
check("起止相同报 same_start_end", same(ruleIssues([R([1], "08:00", "08:00", "a")]), [{ index: 0, kind: "same_start_end" }]));

check("validateRules 通过 qoder", validateRules(qoder) === null);
for (const [name, rules, key] of [
  ["days 空", [R([], "08:00", "18:00", "m")], "schedule.err.days_empty"],
  ["days 越界", [R([8], "08:00", "18:00", "m")], "schedule.err.days_range"],
  ["days 重复", [R([1, 1], "08:00", "18:00", "m")], "schedule.err.days_dup"],
  ["开始 08:15", [R([1], "08:15", "18:00", "m")], "schedule.err.start_format"],
  ["开始 24:00", [R([1], "24:00", "08:00", "m")], "schedule.err.start_24"],
  ["结束 18:20", [R([1], "08:00", "18:20", "m")], "schedule.err.end_format"],
  ["起止相同", [R([1], "08:00", "08:00", "m")], "schedule.err.same"],
  ["模型空白", [R([1], "08:00", "18:00", "  ")], "schedule.err.model_empty"],
  ["17 条", Array.from({ length: 17 }, () => R([1], "08:00", "18:00", "m")), "schedule.err.too_many"],
]) {
  const got = validateRules(rules);
  check(`validateRules: ${name}`, got === key, `期望 ${key}, 实际 ${got}`);
}
check("validateRules 接受 24:00 结束与 16 条", validateRules([R([7], "00:30", "24:00", "m")]) === null
  && validateRules(Array.from({ length: 16 }, () => R([1], "08:00", "18:00", "m"))) === null);

check("weeklyHours 全周", weeklyHours("d", []) === 168);
check("weeklyHours 无默认无规则", weeklyHours("", []) === 0);
check("weeklyHours qoder", weeklyHours("", qoder) === 120, String(weeklyHours("", qoder)));

const monday = qCells.slice(0, 48);
const rs = runs(monday, (v) => v ?? "");
check("runs 周一", same(rs.map((r) => [r.start, r.end, r.value]), [[0, 16, null], [16, 36, "deepseek-4.1"], [36, 48, "qwen-max"]]), JSON.stringify(rs));

// 编辑页用的小工具: 星期快捷项识别 / 跨零点 / 草稿与已存配置比较
check("dayPreset 每天", dayPreset([7, 1, 2, 3, 4, 5, 6]) === "every");
check("dayPreset 工作日", dayPreset([1, 2, 3, 4, 5]) === "workdays");
check("dayPreset 周末", dayPreset([7, 6]) === "weekend");
check("dayPreset 自定义", dayPreset([1, 3]) === "custom" && dayPreset([]) === "custom" && dayPreset([1, 1, 2, 3, 4, 5]) === "custom");
check("DAY_PRESETS 升序", same(DAY_PRESETS.every, ALL) && same(DAY_PRESETS.workdays, [1, 2, 3, 4, 5]) && same(DAY_PRESETS.weekend, [6, 7]));
check("crossesMidnight", crossesMidnight("18:00", "08:00") && !crossesMidnight("18:00", "24:00")
  && !crossesMidnight("08:00", "18:00") && !crossesMidnight("08:00", "08:00") && !crossesMidnight("bad", "08:00"));
check("normalizeSchedules 去空列表并固定槽位顺序",
  same(normalizeSchedules({ haiku: [qoder[0]], fable: [], opus: qoder }), { opus: qoder, haiku: [qoder[0]] }));
check("schedulesEqual 忽略空列表与键顺序", schedulesEqual({ sonnet: [], opus: qoder }, { opus: qoder }));
check("schedulesEqual 规则不同", !schedulesEqual({ opus: qoder }, { opus: [qoder[1], qoder[0]] }));

const c1 = modelColor("deepseek-4.1");
check("modelColor 同名同色", same(c1, modelColor("deepseek-4.1")));
check("modelColor 引用主题变量", /^var\(--fill-/.test(c1.bg) && c1.bar.includes("var(--fill-"));
check("modelColor 不是单一颜色", new Set(["a", "b", "c", "d", "e", "f", "g", "h"].map((m) => modelColor(m).bg)).size > 1);
const trio = ["deepseek-4.1", "qwen-max", "mimo-v2.6-pro"];
const assigned = assignModelColors(trio);
check("assignModelColors 三个模型三种颜色", new Set(trio.map((m) => assigned.get(m)?.bg)).size === 3);
const reordered = assignModelColors(["qwen-max", "mimo-v2.6-pro", "deepseek-4.1", "qwen-max"]);
check("assignModelColors 与传入顺序无关", same([...assigned].sort(), [...reordered].sort()));
check("assignModelColors 引用主题变量", [...assigned.values()].every((c) => /^var\(--fill-/.test(c.bg)));
// 色条用同色系深色 token, 不能混 --ink-*: 暗色下 ink 是浅色, 混出来全是灰
check("色条不混墨色", [...assigned.values(), c1].every((c) => /^var\(--fill-[a-z-]+-bar\)$/.test(c.bar)), c1.bar);
{
  const css = readFileSync(`${SRC}styles.css`, "utf8");
  const fills = new Set([...assignModelColors(["a", "b", "c", "d", "e", "f", "g", "h", "i"]).values()].map((c) => c.bar));
  for (const bar of fills) {
    const token = bar.slice(4, -1);
    const n = css.split(`${token}:`).length - 1;
    check(`${token} 亮 / 暗主题各定义一次`, n === 2, `实际 ${n}`);
  }
}

// ---- 2b. 此刻生效模型 (列表 / 实时路由) 与虚拟模型的候选链 (虚拟模型页一周时段) ----
const { slotModelAt, slotNow, slotSummaryText } = await import("../src/lib/slotNow.ts");
const {
  candidateChain, chainKey, stablyAvailable, vmModelColors, vmWeekCells, uncoveredHours, routeNodes, neutralShade,
} = await import("../src/components/schedule/weekChain.ts");

const SUB = (id, slots, schedules = {}, extra = {}) => ({
  id,
  display_name: id,
  enabled: true,
  state: "healthy",
  model_slots: { fable: "", opus: "", sonnet: "", haiku: "", ...slots },
  slot_schedules: schedules,
  slot_models_now: { fable: null, opus: "from-backend", sonnet: null, haiku: null },
  ...extra,
});
const sat7 = { weekday: 6, minute: 420 };
const qSub = SUB("qoder", { opus: "" }, { opus: qoder });
check("slotModelAt 按规则", slotModelAt(qSub, "opus", mon10) === "deepseek-4.1");
check("slotModelAt 周六早上 (周五夜跨零点)", slotModelAt(qSub, "opus", sat7) === "qwen-max");
check("slotModelAt 周日空档", slotModelAt(qSub, "opus", { weekday: 7, minute: 600 }) === null);
check("slotNow 分时段", same(slotNow(qSub, "opus", mon10), { model: "deepseek-4.1", scheduled: true, neverCalled: false }));
check("slotNow 不会被调用", same(slotNow(SUB("e", {}), "haiku", mon10), { model: null, scheduled: false, neverCalled: true }));
check("slotNow 全天默认", same(slotNow(SUB("d", { sonnet: " m " }), "sonnet", mon10), { model: "m", scheduled: false, neverCalled: false }));
check("slotNow 时钟未到时用后端求值", slotNow(qSub, "opus", null).model === "from-backend");
// 摘要: 用一个把参数原样拼出来的假 t, 只断言选了哪条文案、带了什么参数
const fakeT = (key, params) => (params ? `${key}${JSON.stringify(params)}` : key);
check("摘要 分时段 + 默认不设置", slotSummaryText(qSub, "opus", fakeT) === 'schedule.summary.timedNoDefault{"n":2}');
check("摘要 分时段 + 默认模型",
  slotSummaryText(SUB("x", { opus: " base " }, { opus: [qoder[0]] }), "opus", fakeT) === 'schedule.summary.timed{"n":1,"model":"base"}');
check("摘要 全天", slotSummaryText(SUB("y", { sonnet: "m" }), "sonnet", fakeT) === 'schedule.summary.allDay{"model":"m"}');
check("摘要 不会被调用时不重复", slotSummaryText(SUB("z", {}), "haiku", fakeT) === null);

const dso = SUB("dso", {}, { opus: [R(ALL, "00:30", "08:30", "deepseek-v4-pro")] });
const od = SUB("od", { opus: "mimo-v2.6-pro" });
const off = SUB("off", { opus: "x-model" }, {}, { enabled: false });
const authBad = SUB("bad", { opus: "y-model" }, {}, { state: "auth_failed" });
const cool = SUB("cool", { opus: "z-model" }, {}, { state: "rate_limited" });
const map = new Map([qSub, dso, od, off, authBad, cool].map((s) => [s.id, s]));
const VM = (ids, mode = "sequential", name = "model-opus") => ({ name, mode, subscription_ids: ids });
const opusVm = VM(["qoder", "dso", "od"]);
const ids = (chain) => chain.map((c) => `${c.sub.id}:${c.model}`);
check("候选链 周一 10:00", same(ids(candidateChain(opusVm, map, mon10)), ["qoder:deepseek-4.1", "od:mimo-v2.6-pro"]));
check("候选链 周六 07:00", same(ids(candidateChain(opusVm, map, sat7)), ["qoder:qwen-max", "dso:deepseek-v4-pro", "od:mimo-v2.6-pro"]));
check("停用 / 凭证失效全周不可用, 瞬时状态不影响",
  same(ids(candidateChain(VM(["off", "bad", "cool"]), map, mon10)), ["cool:z-model"]));
check("stablyAvailable", !stablyAvailable(off) && !stablyAvailable(authBad) && stablyAvailable(cool));
check("缺失的订阅跳过", candidateChain(VM(["ghost", "od"]), map, mon10).length === 1);
check("fallback / jev 没有候选链", candidateChain(VM(["od"], "sequential", "model-fallback"), map, mon10).length === 0
  && candidateChain(VM(["od"], "sequential", "model-jev"), map, mon10).length === 0);
check("chainKey 空链与任何非空链不同", chainKey([]) !== chainKey(candidateChain(VM(["od"]), map, mon10))
  && chainKey(candidateChain(opusVm, map, mon10)) !== chainKey(candidateChain(opusVm, map, sat7)));

const colors = vmModelColors(opusVm, map);
check("视图配色覆盖默认与规则里的全部模型",
  same([...colors.keys()].sort(), ["deepseek-4.1", "deepseek-v4-pro", "mimo-v2.6-pro", "qwen-max"]));
check("视图配色互不相同", new Set([...colors.values()].map((c) => c.bg)).size === 4);
const seqCells = vmWeekCells(opusVm, map, colors);
check("顺序模式色条按首选模型着色", seqCells.length === 336 && same(seqCells[20], colors.get("deepseek-4.1")));
const gapVm = VM(["qoder"]);
const gapOf = (vm) => uncoveredHours(weekCells((at) => candidateChain(vm, map, at)));
check("无可用小时数 (qoder 单独)", gapOf(gapVm) === 48, String(gapOf(gapVm)));
check("无可用小时数 (od 全天兜住)", gapOf(opusVm) === 0);
check("没绑订阅 = 168 小时无可用", gapOf(VM([])) === 168);
const rrVm = VM(["qoder", "dso", "od"], "round_robin");
const rrCells = vmWeekCells(rrVm, map, colors);
check("轮询色条用中性色按参与数深浅",
  same(rrCells[20], neutralShade(2, 3)) && same(rrCells[5 * 48 + 14], neutralShade(3, 3)) && !same(neutralShade(2, 3), neutralShade(3, 3)));
check("轮询无参与时为空档", vmWeekCells(VM(["qoder"], "round_robin"), map, colors)[6 * 48 + 20] === null);

const nodes = routeNodes(VM(["off", "qoder", "cool", "od"]), map, mon10, true, colors);
check("路由节点名次", same(nodes.map((n) => n.rank), ["off", "first", "backup", "backup"]), JSON.stringify(nodes.map((n) => n.rank)));
check("路由节点模型", same(nodes.map((n) => n.model), [null, "deepseek-4.1", "z-model", "mimo-v2.6-pro"]));
check("现在时刻带瞬时状态", same(nodes.map((n) => n.status ?? null), [null, null, "rate_limited", null]));
{
  const full = SUB("full", { opus: "q-model" }, {}, { is_dispatchable: false });
  const qmap = new Map([["full", full]]);
  check("本地限额已满在现在时刻标 quota", routeNodes(VM(["full"]), qmap, mon10, true, colors)[0].status === "quota");
  check("本地限额已满不影响一周候选链", candidateChain(VM(["full"]), qmap, mon10).length === 1);
}
check("别的时刻不带瞬时状态", routeNodes(VM(["cool"]), map, mon10, false, colors).every((n) => !n.status));
check("路由节点颜色来自视图配色", same(nodes[1].color, colors.get("deepseek-4.1")));

// ---- 3. 源码扫描: 不得用 new Date( 推算星期 / 时刻 ----
const scan = [`${SRC}lib/slotSchedule.ts`, `${SRC}lib/slotNow.ts`];
const walk = (dir) => {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    const p = `${dir}/${f}`;
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.tsx?$/.test(f)) scan.push(p);
  }
};
walk(`${SRC}components/schedule`);
for (const p of scan) {
  check(`${p.slice(ROOT.length)} 不得出现 new Date(`, !/new\s+Date\s*\(/.test(readFileSync(p, "utf8")));
}

if (failures.length) {
  console.error(`check-slot-schedule: ${failures.length} 项失败\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("check-slot-schedule: 全部通过");
