// 卡片阶段和验证状态的共用规则。herdr-review 命令（cli/src/model.ts）和 Review 面板
// （review-core.js）都用这份，保证两边归栏一致。本文件是纯函数，不引用 herdr 接口；
// setup 会把它和 review-core.js 一起复制到 mods/review 和 mods/review-tabs。

// 卡片所在栏目，按顺序判断，先命中先返回：
// hidden（不显示）/ pending / decided / fixed / deferred / archived。
// 条目全部 deferred 的卡是"以后再说"副本卡；旧数据里 deferred 项还留在普通卡中时，
// 只看非 deferred 的条目归栏，结果一样正确。
export function cardStage(card) {
  if (card.state === "draft") return "hidden";
  if (card.archived_at) return "archived";
  const items = card.items ?? [];
  if (items.length === 0) return (card.moved ?? []).length ? "hidden" : "fixed";
  const active = items.filter((it) => it.status !== "deferred");
  if (active.length === 0) return "deferred";
  if (active.some((it) => it.status === "pending")) return "pending";
  if (active.some((it) => it.status === "decided" && it.decision === "approve")) return "decided";
  return "fixed";
}

// 已修复卡的验证标签，只对 fixed 阶段的卡有意义：
// none 无需修复 / pending 待验证 / verifying 验证中 / passed 已验证 / failed 验证未通过。
export function verifyState(card) {
  const fixed = (card.items ?? []).filter((it) => it.status === "fixed");
  if (fixed.length === 0) return "none";
  if (fixed.some((it) => it.verify?.result === "fail")) return "failed";
  if (fixed.every((it) => it.verify?.result === "pass")) return "passed";
  if (fixed.some((it) => it.verifier && !it.verify)) return "verifying";
  return "pending";
}

export const VERIFY_LABEL = { none: "无需修复", pending: "待验证", verifying: "验证中", passed: "已验证", failed: "验证未通过" };

// 条目：已决策·通过、还没修复，等待 agent 修复。
export function waitingFix(it) {
  return it.status === "decided" && it.decision === "approve";
}

// 卡里还没验证的已修复项（面板的验证按钮和 verify 命令用）。
export function verifyPending(card) {
  return (card.items ?? []).filter((it) => it.status === "fixed" && !it.verify);
}
