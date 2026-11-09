// 给 agent 和终端用户看的文字输出。

import { statusLabel } from "./model.ts";
import type { Card, Item } from "./model.ts";

export function itemLines(it: Item, n?: number): string[] {
  const head = `${n === undefined ? "-" : `${n}.`} ${it.id} [${it.severity}] ${it.title}（${statusLabel(it)}）`;
  const lines = [head];
  if (it.location) lines.push(`   位置：${it.location}`);
  lines.push(`   问题：${it.problem}`);
  lines.push(`   建议修法：${it.suggestion}`);
  lines.push(`   影响场景：${it.ue_scenario}`);
  lines.push(`   影响点：${it.ue_impact}`);
  if (it.decision_note) lines.push(`   用户备注：${it.decision_note}`);
  if (it.fix) lines.push(`   修复说明：${it.fix.note}${it.fix.commit ? `（提交 ${it.fix.commit}）` : ""}`);
  if (it.repeats.length) lines.push(`   再次提出：${it.repeats.map((r) => `${r.card_id} 第 ${r.round} 轮`).join("、")}`);
  return lines;
}

export function cardHeading(card: Card): string {
  const where = [card.space_name, card.branch].filter(Boolean).join(" · ");
  const who = [card.reviewer.name, card.reviewer.terminal].filter(Boolean).join(" · ");
  return `${card.id} ${card.title}（${[where, `第 ${card.round} 轮`, who].filter(Boolean).join(" · ")}）`;
}

export function counts(card: Card): string {
  const n = (f: (it: Item) => boolean) => card.items.filter(f).length;
  return [
    `待决策 ${n((it) => it.status === "pending")}`,
    `已决策 ${n((it) => it.status === "decided")}`,
    `已修复 ${n((it) => it.status === "fixed")}`,
    `以后再说 ${n((it) => it.status === "deferred")}`,
  ].join(" / ");
}

/** 发布到面板时不需要流水。 */
export function forPanel(card: Card): Omit<Card, "log"> {
  const { log: _log, ...rest } = card;
  return rest;
}
