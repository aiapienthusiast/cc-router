// 模型名 → 稳定的色块颜色 (同名永远同色)。bg 是日历格底色, bar 是同色系的深色条 / 图例点。
// 只引用主题变量, 深浅色随主题自动切换。

const FILLS = [
  "--fill-sky",
  "--fill-coral",
  "--fill-butter",
  "--fill-heather",
  "--fill-cactus",
  "--fill-nose",
] as const;

/** FNV-1a 32 位。 */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function modelColor(model: string): { bg: string; bar: string } {
  const fill = FILLS[fnv1a(model) % FILLS.length];
  return {
    bg: `var(${fill})`,
    bar: `color-mix(in srgb, var(${fill}) 45%, var(--ink-2))`,
  };
}
