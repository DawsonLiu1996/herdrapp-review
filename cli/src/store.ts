// 卡片文件的读写。只有 herdr-review 命令写这些文件：写入前获取目录锁，写临时文件后改名替换，
// 面板任何时候读到的都是完整文件。

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cardsDir, reviewHome, trashDir } from "./paths.ts";
import { CliError, cardStage } from "./model.ts";
import type { Card, Item } from "./model.ts";

const now = () => new Date().toISOString();

/** 草稿超过这个时间还没发布，就按"全部是新问题"自动发布。 */
export const DRAFT_TIMEOUT_MS = 30 * 60 * 1000;

export function ensureDirs(): void {
  mkdirSync(cardsDir(), { recursive: true });
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function withLock<T>(fn: () => T): T {
  ensureDirs();
  const lock = join(reviewHome(), ".lock");
  const start = Date.now();
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30_000) {
          rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - start > 10_000) throw new CliError("review 数据正被其他命令占用超过 10 秒，请稍后重试", 5);
      sleepSync(50);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

const idNumber = (id: string) => Number(id.slice(1));

export function readAll(): Card[] {
  ensureDirs();
  const cards: Card[] = [];
  for (const name of readdirSync(cardsDir())) {
    if (!/^R\d+\.json$/.test(name)) continue;
    try {
      cards.push(JSON.parse(readFileSync(join(cardsDir(), name), "utf8")) as Card);
    } catch {
      process.stderr.write(`警告：卡片文件 ${name} 无法读取，已跳过\n`);
    }
  }
  return cards.sort((a, b) => idNumber(a.id) - idNumber(b.id));
}

export function writeCard(card: Card): void {
  ensureDirs();
  const final = join(cardsDir(), `${card.id}.json`);
  const tmp = join(cardsDir(), `.${card.id}.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(card, null, 2)}\n`, "utf8");
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, final);
      return;
    } catch (e) {
      // Windows 上目标文件正被读取时改名会短暂失败，稍等重试。
      if (attempt >= 20) throw e;
      sleepSync(25);
    }
  }
}

/** 条目已全部移走的副本卡、拉出的卡：写入最后状态后移到回收站（与删除卡片相同，可以 card restore 恢复）。 */
export function retireCard(card: Card): void {
  writeCard(card);
  mkdirSync(trashDir(), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(join(cardsDir(), `${card.id}.json`), join(trashDir(), `${card.id}.json`));
      return;
    } catch (e) {
      // 与 writeCard 相同：Windows 上文件正被读取时改名会短暂失败
      if (attempt >= 20) throw e;
      sleepSync(25);
    }
  }
}

/** 下一个卡片编号。编号只增不减，删掉的卡片编号不会复用。 */
export function nextId(cards: Card[]): string {
  const seqFile = join(reviewHome(), "seq");
  let seq = 1;
  try {
    seq = Number(readFileSync(seqFile, "utf8").trim()) || 1;
  } catch {}
  const max = cards.reduce((m, c) => Math.max(m, idNumber(c.id)), 0);
  const n = Math.max(seq, max + 1);
  writeFileSync(seqFile, String(n + 1), "utf8");
  return `R${n}`;
}

/**
 * 条目跨卡移动是先写目标卡再写源卡；中断会让同一编号同时出现在两张卡里，读取时以卡号大的为准。
 * 移到新建的副本卡、新卡（卡号更大）时，中断后按移动完成处理；撤销移动、放回已有副本卡
 * （目标卡号更小）时，中断后按没有移动处理。两种结果都不会丢条目。
 */
export function findItem(cards: Card[], itemId: string) {
  const key = itemId.toUpperCase();
  let best: { card: Card; item: Item } | null = null;
  for (const card of cards) {
    const item = card.items.find((it) => it.id === key);
    if (item && (!best || idNumber(card.id) > idNumber(best.card.id))) best = { card, item };
  }
  return best;
}

/**
 * 写入前修正移动中断留下的重复条目：同一编号只留卡号最大的那张卡，返回被修正的源卡。
 * 必须在 withLock 里、readAll 之后调用；返回的卡要随其他改动一起 writeCard。
 */
export function dedupeItems(cards: Card[]): Card[] {
  const byItem = new Map<string, Card[]>();
  for (const card of cards) {
    for (const it of card.items ?? []) {
      const owners = byItem.get(it.id) ?? [];
      owners.push(card);
      byItem.set(it.id, owners);
    }
  }
  const dirty = new Set<Card>();
  for (const [id, owners] of byItem) {
    if (owners.length < 2) continue;
    const sorted = [...owners].sort((a, b) => idNumber(a.id) - idNumber(b.id));
    const target = sorted[sorted.length - 1];
    for (const loser of sorted.slice(0, -1)) {
      loser.items = (loser.items ?? []).filter((it) => it.id !== id);
      loser.log.push({ at: now(), actor: "herdr-review", action: "清理重复条目", item: id, note: `与 ${target.id} 重复，以 ${target.id} 为准` });
      dirty.add(loser);
    }
  }
  return [...dirty];
}

const itemNo = (id: string) => Number(id.split("-")[1]) || 0;

/**
 * 以后再说副本卡：卡头信息和原卡相同，origin 记原卡编号，条目是从原卡移出的 deferred 项。
 * 从副本卡部分拉出时也用它建新卡（origin 同副本卡，即同一个原卡）。
 */
export function makeCopyCard(source: Card, id: string, items: Item[], at: string, origin?: string | null): Card {
  return {
    schema: 1,
    id,
    state: "published",
    compared: true,
    title: source.title,
    scope: source.scope,
    summary: source.summary,
    space_id: source.space_id,
    space_name: source.space_name,
    repo_root: source.repo_root,
    branch: source.branch,
    head: source.head,
    cwd: source.cwd,
    reviewer: { ...source.reviewer },
    round: source.round,
    created_at: at,
    published_at: source.published_at ?? at,
    merged: [],
    origin: origin !== undefined ? origin : (source.origin ?? source.id),
    moved: [],
    archived_at: null,
    archived_by: null,
    items,
    log: [{ at, actor: "herdr-review", action: "建副本卡", note: `从 ${source.id} 拆出` }],
  };
}

/**
 * 旧数据迁移：普通卡（origin 为空）里还留着的 deferred 项移到它的副本卡，原卡记 moved。
 * 副本卡自己的 deferred 项不动；可以重复执行，迁完后普通卡里不再有 deferred 项。
 */
export function migrateDeferred(): { moved: number; created: string[] } {
  return withLock(() => {
    const cards = readAll();
    const dupes = dedupeItems(cards);
    const created: string[] = [];
    let moved = 0;
    for (const src of [...cards]) {
      if (src.state !== "published" || src.origin) continue;
      const deferred = src.items.filter((it) => it.status === "deferred");
      if (!deferred.length) continue;
      let copy = cards.find((c) => c !== src && c.origin === src.id && c.state === "published" && cardStage(c) === "deferred");
      if (!copy) {
        copy = makeCopyCard(src, nextId(cards), [], now());
        cards.push(copy);
        created.push(copy.id);
      }
      const at = now();
      for (const it of deferred) {
        src.items = src.items.filter((x) => x.id !== it.id);
        copy.items.push(it);
        (src.moved ??= []).push({ item: it.id, to: copy.id, at });
        src.log.push({ at, actor: "herdr-review", action: "迁移", item: it.id, to: "以后再说", note: `移到副本卡 ${copy.id}` });
        copy.log.push({ at, actor: "herdr-review", action: "迁移", item: it.id, note: `来自 ${src.id}` });
        moved++;
      }
      copy.items.sort((a, b) => itemNo(a.id) - itemNo(b.id));
      writeCard(src);
      writeCard(copy);
    }
    for (const c of dupes) writeCard(c);
    return { moved, created };
  });
}

/** 超时的草稿按"全部是新问题"发布，卡片标记为未完成比对。返回被发布的卡片。 */
export function publishExpiredDrafts(cards: Card[], now = Date.now()): Card[] {
  const expired = cards.filter((c) => c.state === "draft" && now - Date.parse(c.created_at) > DRAFT_TIMEOUT_MS);
  for (const card of expired) {
    card.state = "published";
    card.compared = false;
    card.published_at = new Date(now).toISOString();
    card.log.push({ at: card.published_at, actor: "herdr-review", action: "草稿超时，按全部是新问题自动发布" });
    writeCard(card);
  }
  return expired;
}

/** 读之前顺手处理超时草稿：只有确实存在超时草稿时才加锁。 */
export function readAllMaintained(): Card[] {
  const cards = readAll();
  const now = Date.now();
  if (!cards.some((c) => c.state === "draft" && now - Date.parse(c.created_at) > DRAFT_TIMEOUT_MS)) return cards;
  return withLock(() => {
    const fresh = readAll();
    publishExpiredDrafts(fresh, now);
    return fresh;
  });
}
