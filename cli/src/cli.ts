#!/usr/bin/env node
// herdr-review 命令入口。数据只由这个命令写入，Review 面板读文件显示，写操作也调用这个命令。

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { cardsDir, trashDir } from "./paths.ts";
import { fileURLToPath } from "node:url";
import { CliError, applyDecision, cardStage, isOpen, statusLabel, verifyPending, waitingFix } from "./model.ts";
import type { Card, DecideAction, Item, Submitted } from "./model.ts";
import { validateSubmission } from "./validate.ts";
import { dedupeItems, findItem, makeCopyCard, nextId, publishExpiredDrafts, readAll, readAllMaintained, retireCard, withLock, writeCard } from "./store.ts";
import { actor, appName, detect, sameWorktree, terminalInfo } from "./context.ts";
import type { Ctx } from "./context.ts";
import { cardHeading, counts, forPanel, itemLines } from "./format.ts";
import { HELP, SCHEMA } from "./texts.ts";

interface Args {
  _: string[];
  flags: Record<string, string | true>;
  multi: Record<string, string[]>;
}

const VALUE_FLAGS = new Set(["file", "cwd", "agent", "note", "commit", "same", "card", "timeout", "fixer", "verifier", "app", "name", "format", "from", "bin"]);

export function parseArgs(argv: string[]): Args {
  const args: Args = { _: [], flags: {}, multi: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      args._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--") && a.length > 2) {
      let key = a.slice(2);
      let val: string | true = true;
      const eq = key.indexOf("=");
      if (eq >= 0) {
        val = key.slice(eq + 1);
        key = key.slice(0, eq);
      } else if (VALUE_FLAGS.has(key)) {
        if (i + 1 >= argv.length) throw new CliError(`--${key} 后面需要一个值`, 2);
        val = argv[++i];
      }
      args.flags[key] = val;
      (args.multi[key] ??= []).push(String(val));
    } else {
      args._.push(a);
    }
  }
  return args;
}

const now = () => new Date().toISOString();
const str = (v: string | true | undefined): string | undefined => (typeof v === "string" ? v : undefined);
const print = (text: string): void => {
  process.stdout.write(`${text}\n`);
};
const printJson = (value: unknown): void => print(JSON.stringify(value, null, 2));

function ctxOf(args: Args, git = true, locate = git): Ctx {
  return detect({ cwd: str(args.flags.cwd), agent: str(args.flags.agent), git, locate });
}

function requireUser(ctx: Ctx, what: string): void {
  if (ctx.isAgent) {
    throw new CliError(`${what}只能由用户在 Review 面板中操作，agent 不能代替用户决策。`, 3);
  }
  // 查不到终端里运行的是什么，不能当作用户放行
  if (ctx.identityUnknown) {
    throw new CliError(
      `无法确认调用者身份：hc get ${ctx.terminal} 查询失败（hc 不在 PATH、超时或返回异常）。${what}只能由用户在 Review 面板中操作；如果你是用户，请在 Review 面板里完成，或确认 hc 可用后重试。`,
      3,
    );
  }
}

function ids(list: string[]): string[] {
  return list.flatMap((v) => v.split(/[,\s]+/)).map((v) => v.trim().toUpperCase()).filter(Boolean);
}

function readInput(args: Args): string {
  const file = str(args.flags.file);
  let raw: string;
  if (file) {
    try {
      raw = readFileSync(resolve(file), "utf8");
    } catch {
      throw new CliError(`读不到文件 ${file}`, 2);
    }
  } else if (args.flags.stdin) {
    raw = readFileSync(0, "utf8");
  } else {
    throw new CliError("请用 --file <文件> 或 --stdin 提供 review 内容。运行 herdr-review schema 查看格式。", 2);
  }
  raw = raw.replace(/^﻿/, "");
  if (raw.includes("�")) {
    throw new CliError("提交内容里有乱码（编码不是 UTF-8）。请先把 JSON 用 UTF-8 写入文件，再用 --file 提交。", 2);
  }
  return raw;
}

function freshItem(s: Submitted, id: string): Item {
  return { ...s, id, status: "pending", decision: null, decision_note: "", fixer: null, fix: null, verifier: null, verify: null, repeats: [] };
}

function itemNo(id: string): number {
  return Number(id.split("-")[1]) || 0;
}

const STAGE_LABEL: Record<string, string> = { hidden: "不显示", pending: "待决策", decided: "已决策", fixed: "已修复", deferred: "以后再说", archived: "已归档" };

// ---------- review agent ----------

function cardCreate(args: Args) {
  const raw = readInput(args);
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new CliError(`提交内容不是合法的 JSON：${(e as Error).message}。运行 herdr-review schema 查看格式。`, 2);
  }
  const sub = validateSubmission(data);
  const ctx = ctxOf(args);
  const result = withLock(() => {
    const cards = readAll();
    publishExpiredDrafts(cards);
    const id = nextId(cards);
    const at = now();
    // 副本卡和从副本卡拉出的卡不计入轮次
    const round = cards.filter((c) => !c.origin && c.reviewer.terminal === ctx.terminal && sameWorktree(c, ctx)).length + 1;
    const old = cards
      .filter((c) => c.state === "published" && sameWorktree(c, ctx))
      .flatMap((c) => c.items.filter(isOpen));
    const items = sub.items.map((s, i) => freshItem(s, `${id}-${i + 1}`));
    const draft = old.length > 0 && items.length > 0;
    const who = actor(ctx);
    const card: Card = {
      schema: 1,
      id,
      state: draft ? "draft" : "published",
      compared: true,
      title: sub.title,
      scope: sub.scope,
      summary: sub.summary,
      space_id: ctx.space_id,
      space_name: ctx.space_name,
      repo_root: ctx.repo_root,
      branch: ctx.branch,
      head: ctx.head,
      cwd: ctx.cwd,
      reviewer: { terminal: ctx.terminal, app: ctx.app, name: ctx.app ? appName(ctx.app) : "用户", title: ctx.title },
      round,
      created_at: at,
      published_at: draft ? null : at,
      merged: [],
      origin: null,
      moved: [],
      archived_at: null,
      archived_by: null,
      ...(draft ? { compare_with: old.map((it) => it.id) } : {}),
      items,
      log: [{ at, actor: who, action: draft ? "提交草稿，等待比对" : "创建并发布" }],
    };
    writeCard(card);
    return { card, old };
  });
  const { card, old } = result;
  const base = {
    card_id: card.id,
    round: card.round,
    status: card.state,
    items: card.items.map((it) => it.id),
    space: card.space_name,
    worktree: card.repo_root,
    ...(ctx.terminalUnconfirmed
      ? {
          notice: card.space_id
            ? "没能确认你在哪个 herdr-app 终端，卡片按目录归到了上面的 space，修复时面板不会标出负责 review 的终端。"
            : "没能确认你在哪个 herdr-app 终端，卡片没有记录 space，面板按目录匹配；匹配不到时面板上不显示，请把卡片编号告诉用户。",
        }
      : {}),
  };
  if (card.state === "published") {
    printJson({ ...base, message: card.items.length ? "已发布到 Review 面板，等待用户决策" : "已发布：本轮未发现问题" });
    return;
  }
  printJson({
    ...base,
    compare_with: old.map((it) => ({
      id: it.id,
      status: statusLabel(it),
      severity: it.severity,
      title: it.title,
      location: it.location,
      problem: it.problem,
    })),
    next: `逐项比对：本轮哪些条目和 compare_with 里的旧项是同一个问题。比对后运行 herdr-review card publish ${card.id}，重复项用 --same 本轮编号=旧编号 标出（可写多个 --same）；没有重复项时不带 --same。只标重复，不修改本轮结论内容。`,
  });
}

function cardPublish(args: Args) {
  const cardId = args._[2]?.toUpperCase();
  if (!cardId) throw new CliError("用法：herdr-review card publish <卡号> [--same 本轮编号=旧编号 ...]", 2);
  const pairs = (args.multi.same ?? []).flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
  const ctx = ctxOf(args, false);
  const card = withLock(() => {
    const cards = readAll();
    const card = cards.find((c) => c.id === cardId);
    if (!card) throw new CliError(`找不到卡片 ${cardId}`, 4);
    if (card.state !== "draft") throw new CliError(`${cardId} 已经发布，不需要再发布`, 4);
    const allowed = new Set(card.compare_with ?? []);
    const errors: string[] = [];
    const used = new Set<string>();
    const merges: { mine: Item; old: { card: Card; item: Item } }[] = [];
    for (const pair of pairs) {
      const m = /^(R\d+-\d+)=(R\d+-\d+)$/i.exec(pair);
      if (!m) {
        errors.push(`"${pair}" 格式不对，应写成 本轮编号=旧编号，例如 ${cardId}-1=R12-2`);
        continue;
      }
      const a = m[1].toUpperCase();
      const b = m[2].toUpperCase();
      const mine = card.items.find((it) => it.id === a);
      const old = findItem(cards, b);
      if (!mine) errors.push(`${a} 不是 ${cardId} 的条目`);
      else if (used.has(a)) errors.push(`${a} 被标记了多次，一条只能对应一个旧项`);
      if (!allowed.has(b) || !old) errors.push(`${b} 不在这次需要比对的旧项（compare_with）里`);
      else if (old.item.status === "fixed") errors.push(`${b} 已经修复。已修复的问题再次出现按新问题处理，去掉这条 --same`);
      if (mine && old && allowed.has(b)) {
        used.add(a);
        merges.push({ mine, old });
      }
    }
    if (errors.length) throw new CliError(["没有发布，请修改后重试：", ...errors.map((e) => `- ${e}`)].join("\n"), 2);
    const at = now();
    const who = actor(ctx);
    const touched = new Map<string, Card>();
    for (const { mine, old } of merges) {
      const { status: _s, decision: _d, decision_note: _n, fixer: _f, fix: _x, repeats: _r, ...content } = mine;
      old.item.repeats.push({ card_id: card.id, round: card.round, at, item: content });
      old.card.log.push({ at, actor: who, action: "再次提出", item: old.item.id, note: `${card.id} 第 ${card.round} 轮的 ${mine.id}` });
      touched.set(old.card.id, old.card);
      card.items = card.items.filter((it) => it.id !== mine.id);
      card.merged.push({ id: mine.id, into: old.item.id });
    }
    card.state = "published";
    card.compared = true;
    card.published_at = at;
    delete card.compare_with;
    card.log.push({ at, actor: who, action: merges.length ? `完成比对并发布，${merges.length} 项为旧问题再次提出` : "完成比对并发布，全部是新问题" });
    for (const c of touched.values()) writeCard(c);
    writeCard(card);
    return card;
  });
  printJson({
    card_id: card.id,
    status: "published",
    items: card.items.map((it) => it.id),
    merged: card.merged,
    message: "已发布到 Review 面板，等待用户决策",
  });
}

// ---------- 查看 ----------

function scoped(args: Args, ctx: Ctx, cards: Card[]): Card[] {
  return args.flags.all ? cards : cards.filter((c) => sameWorktree(c, ctx));
}

function cardList(args: Args) {
  const ctx = ctxOf(args);
  const cards = scoped(args, ctx, readAllMaintained());
  if (args.flags.json) return printJson({ cards: cards.map(forPanel) });
  if (!cards.length) return print(args.flags.all ? "还没有 review 卡" : "当前 worktree 还没有 review 卡（--all 查看全部）");
  for (const c of cards) print(`${cardHeading(c)}${c.state === "draft" ? " [草稿，未发布]" : ""}${c.archived_at ? " [已归档]" : ""}\n   ${counts(c)}`);
}

// 用户删除一张卡：卡片文件移到 review/trash/，card restore 可以恢复。编号不会复用。
function cardDelete(args: Args, restore: boolean) {
  const ctx = ctxOf(args, false);
  requireUser(ctx, restore ? "恢复卡片" : "删除卡片");
  const id = args._[2]?.toUpperCase();
  if (!id || !/^R\d+$/.test(id)) throw new CliError(`用法：herdr-review card ${restore ? "restore" : "delete"} <卡号>`, 2);
  withLock(() => {
    mkdirSync(trashDir(), { recursive: true });
    const live = join(cardsDir(), `${id}.json`);
    const trashed = join(trashDir(), `${id}.json`);
    const [from, to] = restore ? [trashed, live] : [live, trashed];
    if (!existsSync(from)) throw new CliError(restore ? `回收站里没有卡片 ${id}` : `找不到卡片 ${id}`, 4);
    renameSync(from, to);
  });
  print(restore ? `已恢复 ${id}` : `已删除 ${id}，可以用 herdr-review card restore ${id} 恢复`);
}

function cardShow(args: Args) {
  const id = args._[2]?.toUpperCase();
  if (!id) throw new CliError("用法：herdr-review card show <卡号>", 2);
  const card = readAllMaintained().find((c) => c.id === id);
  if (!card) throw new CliError(`找不到卡片 ${id}`, 4);
  if (args.flags.json) return printJson(card);
  const lines = [cardHeading(card), `范围：${card.scope || "未填写"}`, `结论：${card.summary || "未填写"}`, counts(card)];
  if (card.state === "draft") lines.push("状态：草稿，未发布");
  if (card.archived_at) lines.push(`状态：已归档（${card.archived_by ?? "用户"} · ${card.archived_at}）`);
  if (!card.compared) lines.push("注意：这张卡未完成与旧问题的比对");
  card.items.forEach((it, i) => lines.push("", ...itemLines(it, i + 1)));
  if (card.merged.length) lines.push("", `本轮与旧问题重复：${card.merged.map((m) => `${m.id} → ${m.into}`).join("、")}`);
  print(lines.join("\n"));
}

function todo(args: Args) {
  const ctx = ctxOf(args);
  const cards = readAllMaintained().filter((c) => c.state === "published");
  const wanted = ids(args._.slice(1));
  const cardId = str(args.flags.card)?.toUpperCase();
  let rows: { card: Card; item: Item }[];
  const notes: string[] = [];
  if (wanted.length) {
    rows = [];
    for (const id of wanted) {
      const hit = findItem(cards, id);
      if (!hit) notes.push(`${id}：找不到`);
      else if (!waitingFix(hit.item)) notes.push(`${id}：当前是"${statusLabel(hit.item)}"，不需要修复`);
      else rows.push(hit);
    }
  } else {
    const pool = cardId ? cards.filter((c) => c.id === cardId) : scoped(args, ctx, cards);
    rows = pool.flatMap((card) => card.items.filter(waitingFix).map((item) => ({ card, item })));
  }
  if (args.flags.json) {
    return printJson({
      items: rows.map(({ card, item }) => ({ card_id: card.id, card_title: card.title, repo_root: card.repo_root, ...item })),
      notes,
    });
  }
  const lines: string[] = [];
  if (!rows.length) lines.push(wanted.length || cardId ? "没有需要修复的项" : "当前 worktree 没有需要修复的项（已决策·通过、未修复）");
  let last = "";
  rows.forEach(({ card, item }, i) => {
    if (card.id !== last) {
      lines.push("", cardHeading(card));
      last = card.id;
    }
    lines.push(...itemLines(item, i + 1));
    if (item.fixer) lines.push(`   交给：${item.fixer.name}${item.fixer.terminal ? ` · ${item.fixer.terminal}` : ""}`);
  });
  if (notes.length) lines.push("", ...notes);
  if (rows.length) lines.push("", '修完每项后运行：herdr-review item fixed <编号> --note "改了什么" [--commit 提交号]');
  print(lines.join("\n").trim());
}

const DEFERRED_INTRO =
  "以下 review 项（来自 herdr-review）目前是“以后再说”，用户还没有通过，先用于讨论：请分析问题和修法，不要修改代码，也不要运行 herdr-review item fixed。需要修复时，请用户先在 Review 面板中将其标为通过，再用 herdr-review todo 查看并修复。";

function deferred(args: Args) {
  const ctx = ctxOf(args);
  const rows = scoped(args, ctx, readAllMaintained().filter((c) => c.state === "published")).flatMap((card) =>
    card.items.filter((it) => it.status === "deferred").map((item) => ({ card, item })),
  );
  const format = str(args.flags.format) ?? (args.flags.json ? "json" : "text");
  if (format === "json") return printJson({ items: rows.map(({ card, item }) => ({ card_id: card.id, ...item })) });
  if (!rows.length) return print("没有\"以后再说\"的项");
  if (format === "md") {
    // 这些项用户还没有通过，导出的文字只用于讨论，不能写成修复指令（itemFixed 只接受已通过的项）
    const lines = [DEFERRED_INTRO, ""];
    rows.forEach(({ item }, i) => lines.push(...itemLines(item, i + 1), ""));
    return print(lines.join("\n").trim());
  }
  const lines: string[] = [];
  rows.forEach(({ card, item }, i) => lines.push(...itemLines(item, i + 1), `   来自：${cardHeading(card)}`));
  print(lines.join("\n"));
}

function listAll(args: Args) {
  const cards = readAllMaintained();
  printJson({ cards: cards.filter((c) => c.state === "published").map(forPanel), drafts: cards.filter((c) => c.state === "draft").length });
  void args;
}

function parseTimeout(v: string | undefined): number {
  if (!v) return 30 * 60_000;
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h)?$/i.exec(v.trim());
  if (!m) throw new CliError(`--timeout 格式不对：${v}，例如 90s、30m、2h`, 2);
  const unit = (m[2] ?? "s").toLowerCase();
  return Number(m[1]) * (unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1000);
}

async function wait(args: Args) {
  const ctx = ctxOf(args);
  const limit = parseTimeout(str(args.flags.timeout));
  let cardId = str(args.flags.card)?.toUpperCase();
  if (!cardId) {
    const mine = readAllMaintained().filter((c) => c.reviewer.terminal === ctx.terminal && sameWorktree(c, ctx));
    cardId = mine.at(-1)?.id;
    if (!cardId) throw new CliError("没有找到你在当前 worktree 提交的卡片，请用 --card 指定卡号", 4);
  }
  const start = Date.now();
  for (;;) {
    const cards = readAllMaintained();
    const card = cards.find((c) => c.id === cardId);
    if (!card) throw new CliError(`找不到卡片 ${cardId}`, 4);
    if (card.state === "published" && !card.items.some((it) => it.status === "pending")) {
      const lines = [`${card.id} 已处理完：${counts(card)}`];
      const line = (it: Item, where = "") => `- ${it.id} ${it.title}：${statusLabel(it)}${where}${it.decision_note ? `（备注：${it.decision_note}）` : ""}`;
      for (const it of card.items) lines.push(line(it));
      // 选了“以后再说”的项已移到副本卡，不在这张卡里；按现在所在的卡补上
      const moved = [...new Set((card.moved ?? []).map((m) => m.item))].map((id) => findItem(cards, id)).filter((h) => h && h.card.id !== card.id);
      if (moved.length) {
        lines.push("", "移到以后再说的项：");
        for (const h of moved) lines.push(line(h!.item, `（现在在 ${h!.card.id}）`));
      }
      return print(lines.join("\n"));
    }
    if (Date.now() - start > limit) {
      const left = card.items.filter((it) => it.status === "pending").length;
      throw new CliError(`等待超时：${card.id} 还有 ${left} 项待决策。用户可能暂时离开；可以结束本轮，或再次运行 herdr-review wait --card ${card.id} 继续等待。`, 3);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// ---------- 用户决策与修复 ----------

const DECIDE_FLAGS: Record<string, DecideAction> = {
  approve: "approve",
  reject: "reject",
  defer: "defer",
  pending: "pending",
  undo: "pending",
  reopen: "reopen",
};

function mutateItems(itemIds: string[], fn: (hit: { card: Card; item: Item }, at: string) => void): Card[] {
  return withLock(() => {
    const cards = readAll();
    const dupes = dedupeItems(cards);
    const errors: string[] = [];
    const hits = itemIds.map((id) => {
      const hit = findItem(cards, id);
      if (!hit) errors.push(`找不到条目 ${id}`);
      else if (hit.card.state !== "published") errors.push(`${id} 所在的卡片还是草稿`);
      return hit;
    });
    if (errors.length) throw new CliError(errors.join("\n"), 4);
    const at = now();
    const touched = new Map<string, Card>();
    for (const hit of hits) {
      fn(hit!, at);
      touched.set(hit!.card.id, hit!.card);
    }
    for (const c of [...touched.values(), ...dupes]) writeCard(c);
    return [...touched.values()];
  });
}

function itemDecide(args: Args) {
  const ctx = ctxOf(args, false);
  requireUser(ctx, "决策");
  const list = ids(args._.slice(2));
  const actions = Object.keys(DECIDE_FLAGS).filter((k) => args.flags[k]);
  if (!list.length || actions.length !== 1) {
    throw new CliError("用法：herdr-review item decide <编号...> --approve|--reject|--defer|--pending|--reopen [--note 备注]", 2);
  }
  const action = DECIDE_FLAGS[actions[0]];
  const note = str(args.flags.note);
  const who = actor(ctx);
  const result: string[] = [];
  withLock(() => {
    const cards = readAll();
    const dupes = dedupeItems(cards);
    const errors: string[] = [];
    const hits = list.map((id) => {
      const hit = findItem(cards, id);
      if (!hit) errors.push(`找不到条目 ${id}`);
      else if (hit.card.state !== "published") errors.push(`${id} 所在的卡片还是草稿`);
      return hit;
    });
    if (errors.length) throw new CliError(errors.join("\n"), 4);
    const typed = hits as { card: Card; item: Item }[];
    // "以后再说"的项被 approve/reject/pending 时要从副本卡拉出；先记下编号再改状态。
    const pullIds = new Set(
      action === "defer" || action === "reopen" ? [] : typed.filter((h) => h.item.status === "deferred").map((h) => h.item.id),
    );
    const at = now();
    const transitions = new Map<string, { from: string; to: string }>();
    const touched = new Map<string, Card>();
    const touch = (c: Card) => touched.set(c.id, c);
    // 接收条目的卡要先写（先写目标卡再写源卡，中断时条目不会丢）；拉出后空了的副本卡、拉出的卡移到回收站。
    const receivers = new Set<Card>();
    const retired = new Set<Card>();
    const moveItem = (from: Card, to: Card, it: Item) => {
      from.items = from.items.filter((x) => x.id !== it.id);
      to.items.push(it);
      to.items.sort((a, b) => itemNo(a.id) - itemNo(b.id));
      receivers.add(to);
      touch(from);
      touch(to);
      if (from.origin && from.items.length === 0) retired.add(from);
    };
    const groupBy = (hs: { card: Card; item: Item }[]) => {
      const map = new Map<Card, { card: Card; item: Item }[]>();
      for (const h of hs) {
        const rows = map.get(h.card) ?? [];
        rows.push(h);
        map.set(h.card, rows);
      }
      return map;
    };
    // 先统一过状态规则并记流水：任一项不合法就整体不写。
    for (const hit of typed) {
      const { from, to } = applyDecision(hit.item, action, note);
      transitions.set(hit.item.id, { from, to });
      hit.card.log.push({ at, actor: who, action: "决策", item: hit.item.id, from, to, ...(note ? { note } : {}) });
      touch(hit.card);
    }
    const suffix = new Map<string, string>();
    if (action === "defer") {
      // 移到原卡的副本卡；同一张原卡的以后再说项都放在同一张副本卡里。
      // 从副本卡拉出的卡（有 origin）按它的原卡找副本卡；找不到且整张卡都放回以后再说时，原地变回副本卡。
      for (const [src, group] of groupBy(typed)) {
        const root = src.origin ?? src.id;
        const copy = cards.find((c) => c !== src && c.origin === root && c.state === "published" && cardStage(c) === "deferred");
        if (!copy && src.origin && src.items.every((it) => it.status === "deferred")) {
          for (const h of group) suffix.set(h.item.id, `（副本卡 ${src.id}）`);
          continue;
        }
        let target = copy;
        if (!target) {
          target = makeCopyCard(src, nextId(cards), [], at, root);
          cards.push(target);
        }
        for (const h of group) {
          moveItem(src, target, h.item);
          // 灰字“N 项已移到以后再说”只记在原卡上
          if (!src.origin) (src.moved ??= []).push({ item: h.item.id, to: target.id, at });
          src.log.push({ at, actor: who, action: "移到副本卡", item: h.item.id, note: target.id });
          target.log.push({ at, actor: who, action: "移入", item: h.item.id, note: `来自 ${src.id}` });
          suffix.set(h.item.id, `（副本卡 ${target.id}）`);
        }
      }
    } else if (pullIds.size) {
      // 从以后再说拉出：副本卡的项全部选中时原地改状态（副本卡整体进入对应栏目）；
      // 只拉出一部分时，拉出的项组成新卡（origin 同副本卡），剩下的留在副本卡。
      // --restore（面板撤销“以后再说”）：条目回到 moved 记录里的原卡，原卡删掉这条 moved。
      let pulls = typed.filter((h) => pullIds.has(h.item.id));
      if (args.flags.restore) {
        const rest: typeof pulls = [];
        for (const h of pulls) {
          const from = h.card;
          const home = cards.find((c) => c !== from && c.state === "published" && !c.archived_at
            && (c.moved ?? []).some((m) => m.item === h.item.id && m.to === from.id));
          if (!home) {
            rest.push(h);
            continue;
          }
          moveItem(from, home, h.item);
          home.moved = (home.moved ?? []).filter((m) => m.item !== h.item.id);
          home.log.push({ at, actor: who, action: "撤销移到以后再说", item: h.item.id, note: `从 ${from.id} 移回` });
          from.log.push({ at, actor: who, action: "移回原卡", item: h.item.id, note: home.id });
          suffix.set(h.item.id, `（回到 ${home.id}）`);
        }
        pulls = rest;
      }
      for (const [src, group] of groupBy(pulls)) {
        // applyDecision 已改状态，不能再看 status；pullIds 只含拉出前是 deferred 的项。
        // 副本卡的项全部被选中（每张卡的项都在 pullIds 里）时原地改状态，否则拉出组成新卡。
        const allOut = src.items.every((it) => pullIds.has(it.id));
        if (allOut) {
          for (const h of group) suffix.set(h.item.id, `（副本卡 ${src.id}）`);
          continue;
        }
        const nc = makeCopyCard(src, nextId(cards), [], at);
        nc.log = [{ at, actor: who, action: "从以后再说拉入", note: `来自 ${src.id}` }];
        cards.push(nc);
        for (const h of group) {
          moveItem(src, nc, h.item);
          nc.log.push({ at, actor: who, action: "拉入", item: h.item.id });
          src.log.push({ at, actor: who, action: "拉出到新卡", item: h.item.id, note: nc.id });
          suffix.set(h.item.id, `（新卡 ${nc.id}）`);
        }
      }
    }
    for (const hit of typed) {
      const t = transitions.get(hit.item.id)!;
      result.push(`${hit.item.id}：${t.from} → ${t.to}${suffix.get(hit.item.id) ?? ""}`);
    }
    for (const c of retired) c.log.push({ at, actor: who, action: "条目已全部移走，移到回收站" });
    const all = new Set([...touched.values(), ...dupes]);
    for (const c of all) if (receivers.has(c)) writeCard(c);
    for (const c of all) if (!receivers.has(c) && !retired.has(c)) writeCard(c);
    for (const c of retired) retireCard(c);
  });
  print(result.join("\n"));
}

function itemAssign(args: Args) {
  const ctx = ctxOf(args, false);
  const list = ids(args._.slice(2));
  const fixer = str(args.flags.fixer);
  const verifier = str(args.flags.verifier);
  if (!list.length || (!fixer && !verifier)) {
    throw new CliError("用法：herdr-review item assign <编号...> --fixer <终端编号|new> [--app codex] [--name 名称]；交给 agent 验证用 --verifier", 2);
  }
  if (fixer && verifier) throw new CliError("--fixer 和 --verifier 只能指定一个", 2);
  requireUser(ctx, verifier ? "指定验证 agent" : "指定修复 agent");
  const target = verifier ?? fixer!;
  const terminal = target === "new" ? null : target;
  let app = str(args.flags.app) ?? null;
  if (!app && terminal) app = terminalInfo(terminal).app;
  const name = str(args.flags.name) ?? `${appName(app)}${terminal ? "" : "（新开）"}`;
  const who = actor(ctx);
  if (verifier) {
    mutateItems(list, ({ card, item }, at) => {
      if (item.status !== "fixed") throw new CliError(`${item.id} 当前是"${statusLabel(item)}"，只有已修复的项可以指定验证 agent`, 4);
      item.verifier = { terminal, app, name, at };
      card.log.push({ at, actor: who, action: "交给 agent 验证", item: item.id, note: `${name}${terminal ? ` · ${terminal}` : ""}` });
    });
    print(`已交给 ${name}${terminal ? ` · ${terminal}` : ""} 验证：${list.join("、")}`);
    return;
  }
  mutateItems(list, ({ card, item }, at) => {
    if (!waitingFix(item)) throw new CliError(`${item.id} 当前是"${statusLabel(item)}"，只有"已决策·通过"的项可以交给 agent 修复`, 4);
    item.fixer = { terminal, app, name, at };
    card.log.push({ at, actor: who, action: "交给 agent 修复", item: item.id, note: `${name}${terminal ? ` · ${terminal}` : ""}` });
  });
  print(`已交给 ${name}${terminal ? ` · ${terminal}` : ""}：${list.join("、")}`);
}

const PLACEHOLDER = /^(无|没有|略|已修复|修复了|done|fixed|ok|-+|\.+)$/i;

function itemFixed(args: Args) {
  // 修复记录要写上是哪个终端修的，需要核对终端编号
  const ctx = ctxOf(args, false, true);
  const list = ids(args._.slice(2));
  const note = str(args.flags.note)?.trim() ?? "";
  if (!list.length) throw new CliError('用法：herdr-review item fixed <编号...> --note "改了什么" [--commit 提交号]', 2);
  if (!note || PLACEHOLDER.test(note)) throw new CliError('请用 --note 写明改了什么，例如 --note "refresh 失败时清理会话并跳转登录页"', 2);
  const commit = str(args.flags.commit) ?? null;
  const who = actor(ctx);
  mutateItems(list, ({ card, item }, at) => {
    if (!waitingFix(item)) {
      throw new CliError(`${item.id} 当前是"${statusLabel(item)}"，只有用户已通过（已决策·通过）的项才能标记已修复`, 4);
    }
    item.status = "fixed";
    item.fix = { note, commit, by: who, terminal: ctx.terminal, title: ctx.title, app: ctx.app, at };
    // 重新修复的项要重新验证
    item.verify = null;
    item.verifier = null;
    card.log.push({ at, actor: who, action: "标记已修复", item: item.id, from: "已决策·通过", to: "已修复", note });
  });
  print(`已标记修复：${list.join("、")}`);
}

// ---------- 验证 ----------

// 列出已修复卡里还没验证的项，供验证的 agent 使用。
function verify(args: Args) {
  const ctx = ctxOf(args);
  const cards = readAllMaintained().filter((c) => c.state === "published");
  const cardId = str(args.flags.card)?.toUpperCase();
  if (cardId && !cards.some((c) => c.id === cardId)) throw new CliError(`找不到卡片 ${cardId}`, 4);
  const pool = cardId ? cards.filter((c) => c.id === cardId) : scoped(args, ctx, cards);
  const rows = pool.filter((c) => cardStage(c) === "fixed").flatMap((card) => verifyPending(card).map((item) => ({ card, item })));
  if (args.flags.json) {
    return printJson({ items: rows.map(({ card, item }) => ({ card_id: card.id, card_title: card.title, ...item })) });
  }
  const lines: string[] = [];
  if (!rows.length) lines.push(cardId ? `${cardId} 没有待验证的项` : "当前 worktree 没有待验证的项（已修复卡里未验证的项）");
  let last = "";
  rows.forEach(({ card, item }, i) => {
    if (card.id !== last) {
      lines.push("", cardHeading(card));
      last = card.id;
    }
    lines.push(...itemLines(item, i + 1));
    if (item.fix) lines.push(`   修复：${item.fix.by}`);
    if (item.verifier) lines.push(`   验证：已交给 ${item.verifier.name}${item.verifier.terminal ? ` · ${item.verifier.terminal}` : ""}`);
  });
  if (rows.length) lines.push("", '逐项验证后运行：herdr-review item verify <编号> --pass | --fail --note "原因"');
  print(lines.join("\n").trim());
}

// agent 标记验证结果。--fail 必须写原因；卡片已归档时拒绝。
function itemVerify(args: Args) {
  const ctx = ctxOf(args, false, true);
  const list = ids(args._.slice(2));
  const pass = Boolean(args.flags.pass);
  const fail = Boolean(args.flags.fail);
  const note = str(args.flags.note)?.trim() ?? "";
  if (!list.length || pass === fail) {
    throw new CliError('用法：herdr-review item verify <编号...> --pass | --fail --note "原因"', 2);
  }
  if (fail && !note) throw new CliError("验证未通过必须用 --note 写明原因", 2);
  const who = actor(ctx);
  const result = pass ? "pass" : "fail";
  withLock(() => {
    const cards = readAll();
    const dupes = dedupeItems(cards);
    const errors: string[] = [];
    const hits = list.map((id) => {
      const hit = findItem(cards, id);
      if (!hit) errors.push(`找不到条目 ${id}`);
      else if (hit.card.state !== "published") errors.push(`${id} 所在的卡片还是草稿`);
      else if (hit.card.archived_at) errors.push(`${id} 所在的卡片 ${hit.card.id} 已归档，不需要验证`);
      else if (hit.item.status !== "fixed") errors.push(`${id} 当前是"${statusLabel(hit.item)}"，只有已修复的项可以验证`);
      return hit;
    });
    if (errors.length) throw new CliError(errors.join("\n"), 4);
    const at = now();
    const touched = new Map<string, Card>();
    for (const hit of hits as { card: Card; item: Item }[]) {
      hit.item.verify = { result, note, by: who, terminal: ctx.terminal, title: ctx.title, at };
      hit.card.log.push({ at, actor: who, action: result === "pass" ? "验证通过" : "验证未通过", item: hit.item.id, note });
      touched.set(hit.card.id, hit.card);
    }
    for (const c of [...touched.values(), ...dupes]) writeCard(c);
  });
  print(`已标记验证${pass ? "通过" : "未通过"}：${list.join("、")}`);
}

// ---------- 归档（只能用户操作） ----------

function cardArchive(args: Args, unarchive: boolean) {
  const ctx = ctxOf(args, false);
  requireUser(ctx, unarchive ? "撤销归档" : "归档卡片");
  const id = args._[2]?.toUpperCase();
  if (!id || !/^R\d+$/.test(id)) throw new CliError(`用法：herdr-review card ${unarchive ? "unarchive" : "archive"} <卡号>`, 2);
  const who = actor(ctx);
  withLock(() => {
    const cards = readAll();
    const dupes = dedupeItems(cards);
    const card = cards.find((c) => c.id === id);
    if (!card) throw new CliError(`找不到卡片 ${id}`, 4);
    const at = now();
    if (unarchive) {
      if (!card.archived_at) throw new CliError(`${id} 没有归档`, 4);
      card.archived_at = null;
      card.archived_by = null;
      card.log.push({ at, actor: who, action: "撤销归档" });
    } else {
      if (card.state !== "published") throw new CliError(`${id} 还是草稿，不能归档`, 4);
      const stage = cardStage(card);
      if (stage !== "fixed") throw new CliError(`${id} 现在在"${STAGE_LABEL[stage]}"，只有已修复的卡能归档`, 4);
      card.archived_at = at;
      card.archived_by = who;
      card.log.push({ at, actor: who, action: "归档" });
    }
    writeCard(card);
    for (const c of dupes) writeCard(c);
  });
  print(unarchive ? `已撤销归档 ${id}` : `已归档 ${id}`);
}

function itemSplit(args: Args) {
  const ctx = ctxOf(args, false);
  requireUser(ctx, "拆分重复项");
  const first = args._[2]?.toUpperCase();
  const from = str(args.flags.from)?.toUpperCase();
  if (!first) throw new CliError("用法：herdr-review item split <原条目编号> --from <再次提出的编号>", 2);
  const who = actor(ctx);
  const moved = withLock(() => {
    const cards = readAll();
    let owner: { card: Card; item: Item } | null = null;
    let repeatId = from ?? first;
    if (from) {
      owner = findItem(cards, first);
      if (!owner) throw new CliError(`找不到条目 ${first}`, 4);
    } else {
      for (const card of cards) for (const item of card.items) if (item.repeats.some((r) => r.item.id === first)) owner = { card, item };
      if (!owner) throw new CliError(`${first} 没有作为重复项记录在任何条目上`, 4);
    }
    const idx = owner.item.repeats.findIndex((r) => r.item.id === repeatId);
    if (idx < 0) throw new CliError(`${owner.item.id} 上没有 ${repeatId} 这条再次提出的记录`, 4);
    const [rep] = owner.item.repeats.splice(idx, 1);
    const target = cards.find((c) => c.id === rep.card_id);
    if (!target) throw new CliError(`${repeatId} 原本所在的卡片 ${rep.card_id} 已不存在`, 4);
    target.items.push(freshItem(rep.item, rep.item.id));
    target.items.sort((a, b) => itemNo(a.id) - itemNo(b.id));
    target.merged = target.merged.filter((m) => m.id !== rep.item.id);
    const at = now();
    // 拆出的新问题是待决策的，目标卡已归档时先撤销归档，卡片才能回到待决策
    if (target.archived_at) {
      target.archived_at = null;
      target.archived_by = null;
      target.log.push({ at, actor: who, action: "撤销归档", note: `拆出 ${repeatId} 时自动撤销` });
    }
    owner.card.log.push({ at, actor: who, action: "拆出重复项", item: owner.item.id, note: `${repeatId} 不是同一问题` });
    target.log.push({ at, actor: who, action: "拆成新问题", item: repeatId, to: "待决策" });
    writeCard(owner.card);
    if (target !== owner.card) writeCard(target);
    return { repeatId, into: target.id, from: owner.item.id };
  });
  print(`${moved.repeatId} 已从 ${moved.from} 拆出，作为 ${moved.into} 的新问题进入待决策`);
}

// ---------- 入口 ----------

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const [cmd, sub] = args._;
  if (!cmd || cmd === "help" || args.flags.help || args.flags.h) return print(HELP);
  switch (cmd) {
    case "schema":
      return print(SCHEMA);
    case "card":
      if (sub === "create") return cardCreate(args);
      if (sub === "publish") return cardPublish(args);
      if (sub === "list") return cardList(args);
      if (sub === "show") return cardShow(args);
      if (sub === "delete") return cardDelete(args, false);
      if (sub === "restore") return cardDelete(args, true);
      if (sub === "archive") return cardArchive(args, false);
      if (sub === "unarchive") return cardArchive(args, true);
      break;
    case "item":
      if (sub === "decide") return itemDecide(args);
      if (sub === "assign") return itemAssign(args);
      if (sub === "fixed") return itemFixed(args);
      if (sub === "verify") return itemVerify(args);
      if (sub === "split") return itemSplit(args);
      break;
    case "verify":
      return verify(args);
    case "todo":
      return todo(args);
    case "deferred":
      return deferred(args);
    case "list":
      return listAll(args);
    case "wait":
      return wait(args);
    case "setup": {
      const { setup } = await import("./setup.ts");
      return setup(args.flags);
    }
    case "version":
    case "--version":
      return print("herdr-review 0.1.0");
  }
  throw new CliError(`不认识的命令：${args._.join(" ")}\n\n${HELP}`, 1);
}

const isMain = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  main(process.argv.slice(2)).catch((e) => {
    if (e instanceof CliError) {
      process.stderr.write(`${e.message}\n`);
      process.exit(e.code);
    }
    process.stderr.write(`${(e as Error).stack ?? e}\n`);
    process.exit(1);
  });
}
