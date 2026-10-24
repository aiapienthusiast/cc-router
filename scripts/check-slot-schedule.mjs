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

// ---- 3. 源码扫描: 不得用 new Date( 推算星期 / 时刻 ----
const scan = [`${SRC}lib/slotSchedule.ts`];
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
