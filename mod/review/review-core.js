// Review 面板（mods/review）和标签栏 Review 按钮（mods/review-tabs）共用的数据层。
// herdr-app 不允许 mod 引用其他 mod 的文件，setup 会把这个文件复制到两个 mod 里。
// 修改请改仓库里的 mod/review/review-core.js，再运行 setup。
//
// 卡片文件只由 herdr-review 命令写入（写临时文件后改名），这里只读。

import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, exec, appHome, readTextFile, watchFolder, layout, notify, run } from "herdr";
import * as fs from "fs/promises";

export const norm = (p) => (p ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
export const reviewDir = () => `${appHome().replace(/\\/g, "/")}/review`;
export const ICON = (name) => `mods/review/icons/${name}.svg`;
// 卡片阶段和验证状态的共用规则：命令（cli/src/model.ts）和面板用同一份 lifecycle.js，保证归栏一致。
import { cardStage, verifyPending, verifyState, VERIFY_LABEL, waitingFix } from "./lifecycle.js";
export { cardStage, verifyPending, verifyState, VERIFY_LABEL, waitingFix };
const CARD_FILE = /^R\d+\.json$/;
// 与命令里的 DRAFT_TIMEOUT_MS 一致：草稿超过这个时间没发布，按新问题自动发布。
const DRAFT_TIMEOUT_MS = 30 * 60 * 1000;
const MAINTAIN_GAP_MS = 10 * 1000;
const num = (id) => Number(String(id).replace(/\D+/g, "")) || 0;

export function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

// space 现在所在的目录：第一个终端的实时目录，否则是创建时的目录（与侧栏的判断一致）。
export function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

// "今天 14:20"、"昨天 18:05"、"11月3日 09:12"。
export function timeText(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(new Date()) - day(d)) / 86400000);
  if (diff === 0) return `今天 ${hm}`;
  if (diff === 1) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

export async function readConfig() {
  try {
    const text = await readTextFile(`${reviewDir()}/config.json`);
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** 卡片数据和已打开 space 的 Git 信息。 */
export class ReviewData {
  constructor() {
    this.files = new Map(); // 文件名 -> { text, card }
    this.cards = []; // 已发布的卡片，按编号排序
    this.git = {}; // space id -> { key, at, cwd, top, common, branch, linked }；top 为 null 表示不是 Git 仓库
    this.expiredDrafts = false;
    this.maintaining = false;
    this.maintainedAt = 0;
    this.ready = false;
    this.checking = false;
    this.closed = false;
  }

  // mod 重新加载或关闭时调用，结束文件监听循环。
  stop() {
    this.closed = true;
  }

  get dir() {
    return `${reviewDir()}/cards`;
  }

  // 读卡片文件。paths 是 watchFolder 给出的变化文件；无法判断时全部重读。
  async load(paths) {
    const dir = this.dir;
    const base = (p) => p.replace(/\\/g, "/").split("/").pop();
    const partial = Array.isArray(paths) && paths.length > 0 && paths.every((p) => /^\.?R\d+/.test(base(p)));
    let names;
    let changed = false;
    if (partial) {
      names = [...new Set(paths.map(base).filter((n) => CARD_FILE.test(n)))];
    } else {
      try {
        names = (await fs.readdir(dir)).filter((n) => CARD_FILE.test(n));
      } catch {
        names = [];
      }
      for (const name of [...this.files.keys()]) {
        if (!names.includes(name)) {
          this.files.delete(name);
          changed = true;
        }
      }
    }
    for (const name of names) {
      const text = await readTextFile(`${dir}/${name}`);
      if (text === null) {
        if (this.files.delete(name)) changed = true;
        continue;
      }
      if (this.files.get(name)?.text === text) continue;
      try {
        this.files.set(name, { text, card: JSON.parse(text) });
        changed = true;
      } catch {
        // 文件正在被替换时可能读到半截，下次变化时再读。
      }
    }
    const all = [...this.files.values()].map((v) => v.card);
    if (changed) this.cards = all.filter((c) => c.state === "published").sort((a, b) => num(a.id) - num(b.id));
    // 草稿是否超时按当前时间每次都算：文件不变，时间也会走到超时
    const now = Date.now();
    this.expiredDrafts = all.some((c) => c.state === "draft" && now - Date.parse(c.created_at) > DRAFT_TIMEOUT_MS);
    return changed;
  }

  // 有超时的草稿时调用一次命令，由命令按规则自动发布（卡片仍只由命令写入）。返回发布后是否读到变化。
  // 面板和标签栏按钮各有一份数据，都会调用；命令内部加锁，重复调用不会重复发布。
  async maintain() {
    if (!this.expiredDrafts || this.maintaining || this.closed) return false;
    if (Date.now() - this.maintainedAt < MAINTAIN_GAP_MS) return false;
    this.maintaining = true;
    this.maintainedAt = Date.now();
    try {
      const config = await readConfig();
      if (!config) return false;
      await exec(config.node, [config.cli, "list", "--json"]);
      return await this.load();
    } catch {
      return false;
    } finally {
      this.maintaining = false;
    }
  }

  // 每个已打开 space 的 Git 信息：仓库根目录、共同的 .git 目录、分支、是否为附加 worktree。
  async refreshGit() {
    if (this.checking) return false;
    this.checking = true;
    let changed = false;
    try {
      const ps = panes();
      const now = Date.now();
      for (const s of spaces()) {
        const cwd = place(s, ps);
        if (!cwd) continue;
        const key = `${s.machine ?? ""}|${cwd}`;
        const old = this.git[s.id];
        if (old?.key === key && now - old.at < 30000) continue;
        let info = { key, at: now, cwd: norm(cwd), top: null, common: null, branch: null, linked: false };
        try {
          const r = await exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "--abbrev-ref", "HEAD"], { cwd, on: s.machine });
          if (r.code === 0) {
            const [top, common, branch] = r.stdout.trim().split(/\r?\n/);
            info = { ...info, top: norm(top), common: norm(common), branch: branch === "HEAD" ? null : branch, linked: norm(common) !== `${norm(top)}/.git` };
          }
        } catch {}
        const same = old && JSON.stringify({ ...old, at: 0 }) === JSON.stringify({ ...info, at: 0 });
        if (!same) changed = true;
        this.git[s.id] = info;
      }
    } finally {
      this.checking = false;
    }
    return changed;
  }

  // 首次读取后持续跟踪：卡片目录有变化就重读，space 的目录变了就重新查 Git。onChange(cx) 里刷新界面。
  // 每次读取后检查超时草稿（maintain），面板隐藏时标签栏按钮这一份也会处理。
  start(cx, onChange) {
    const dir = this.dir;
    const maintain = async (cx) => {
      if (await this.maintain()) onChange(cx);
    };
    cx.spawn(async (cx) => {
      try {
        await fs.mkdir(dir, { recursive: true });
      } catch {}
      await this.load();
      await this.refreshGit();
      this.ready = true;
      onChange(cx);
      await maintain(cx);
      while (!this.closed) {
        let paths;
        try {
          paths = await watchFolder(dir);
        } catch {
          // 目录被删除等情况：5 秒后重建目录再监听，期间靠下面的定时检查。
          await new Promise((r) => setTimeout(r, 5000));
          try {
            await fs.mkdir(dir, { recursive: true });
          } catch {}
          paths = null;
        }
        if (this.closed) return;
        if (await this.load(paths)) onChange(cx);
        await maintain(cx);
      }
    });
    cx.timer.every(2000, (cx) => {
      cx.spawn(async (cx) => {
        if (await this.refreshGit()) onChange(cx);
      });
    });
    cx.timer.every(15000, (cx) => {
      cx.spawn(async (cx) => {
        if (await this.load()) onChange(cx);
        await maintain(cx);
      });
    });
  }

  // 卡片属于哪个已打开的 space：先按 space id，再按 worktree 目录（space 重开后 id 会变）。
  spaceOf(card, open = spaces()) {
    const byId = card.space_id && open.find((s) => s.id === card.space_id);
    if (byId) return byId;
    const path = norm(card.repo_root ?? card.cwd);
    if (!path) return null;
    return open.find((s) => {
      const g = this.git[s.id];
      return g && (g.top === path || g.cwd === path);
    }) ?? null;
  }

  // 侧栏的层级：worktree 挂在同一仓库的主 space 下面；主 space 没打开时，worktree 单独成组。
  tree(order = spaces()) {
    const g = (s) => this.git[s.id];
    const mains = new Set(order.filter((s) => g(s)?.top && !g(s).linked).map((s) => g(s).common));
    const nested = (s) => g(s)?.linked && mains.has(g(s).common);
    const placed = new Set();
    const out = [];
    for (const s of order) {
      if (nested(s)) continue;
      const info = g(s);
      let kids = [];
      if (info?.top && !info.linked && !placed.has(info.common)) {
        placed.add(info.common);
        kids = order.filter((k) => nested(k) && g(k).common === info.common);
      }
      out.push({ space: s, kids });
    }
    return out;
  }

  // 显示得出来的卡片，按侧栏顺序：[{ space, card }]
  visible() {
    const open = spaces();
    const bySpace = new Map();
    for (const card of this.cards) {
      const s = this.spaceOf(card, open);
      if (!s) continue;
      if (!bySpace.has(s.id)) bySpace.set(s.id, []);
      bySpace.get(s.id).push(card);
    }
    const out = [];
    for (const { space, kids } of this.tree(open)) {
      for (const s of [space, ...kids]) for (const card of bySpace.get(s.id) ?? []) out.push({ space: s, card });
    }
    return out;
  }

  rows() {
    return this.visible().flatMap(({ space, card }) => card.items.map((it) => ({ space, card, it })));
  }
}

/** 标签栏的 Review 按钮：显示或隐藏面板，角标是已打开 space 里的待决策数量；面板隐藏时有新项就弹通知。 */
export class ReviewButton {
  constructor(cx) {
    this.data = new ReviewData();
    this.seen = null; // 见过的条目编号；只有新出现的条目才通知
    this.data.start(cx, (cx) => {
      this.check();
      cx.notify();
    });
  }

  // 待决策栏目里的卡片（按卡片数，角标口径）。
  pending() {
    const cards = new Map();
    for (const { card } of this.data.visible()) {
      if (cardStage(card) === "pending") cards.set(card.id, card);
    }
    return [...cards.values()];
  }

  stop() {
    this.data.stop();
  }

  check() {
    if (!this.data.ready) return;
    const all = new Set(this.data.cards.flatMap((c) => c.items.map((it) => it.id)));
    if (this.seen === null) {
      this.seen = all;
      return;
    }
    const fresh = this.data.rows().filter((r) => r.it.status === "pending" && !this.seen.has(r.it.id));
    for (const id of all) this.seen.add(id);
    if (!fresh.length) return;
    const node = findNode(layout(), "review");
    if (!node || !node.hidden) return;
    const bySpace = new Map();
    for (const r of fresh) {
      if (!bySpace.has(r.space.id)) bySpace.set(r.space.id, { name: r.space.name, cards: new Set(), items: 0 });
      const g = bySpace.get(r.space.id);
      g.cards.add(r.card.id);
      g.items++;
    }
    for (const { name, cards, items } of bySpace.values()) {
      notify({
        title: `${name} 新增 ${cards.size} 张 review 卡，${items} 项待决策`,
        body: fresh.find((r) => bySpace.get(r.space.id)?.name === name)?.card.title ?? "",
        level: "info",
        icon: ICON("review"),
        action: { name: "layout.show", args: { id: "review" } },
      });
    }
  }

  render(t, stop) {
    const node = findNode(layout(), "review");
    if (!node) return div();
    const on = !node.hidden;
    const n = this.pending().length;
    return h_flex().id("panel-review").h(26).px(8).gap(5).flex_none().items_center().rounded(6)
      .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover)).on_mouse_down("left", stop)
      .on_click(() => run(on ? "layout.hide" : "layout.show", { id: "review" }))
      .child(svg(ICON("review")).size(14)).child("Review")
      .when(n > 0, (el) => el.child(div().h(16).min_w(16).px(4).flex().items_center().justify_center().rounded(8)
        .bg(t.blocked).text_color("#ffffff").text_size(10).font_semibold().child(String(n))));
  }
}

const STATUS_TEXT = { pending: "待决策", deferred: "以后再说", fixed: "已修复" };
const statusText = (it) => (it.status === "decided" ? (it.decision === "reject" ? "已决策·不通过" : "已决策·通过") : STATUS_TEXT[it.status] ?? it.status);

/**
 * 复制给 agent 的文字。用户已通过的项写成修复指令；其他项（多为“以后再说”）用户还没有通过，
 * 只能用于讨论——itemFixed 只接受已通过的项，写成修复指令 agent 既不该修，修了也标不了。
 */
export function copyText(items) {
  const lines = [];
  const list = (rows) => rows.forEach((it, i) => {
    lines.push(`${i + 1}. [${it.severity}] ${it.title}（${it.id}，${statusText(it)}）`);
    if (it.location) lines.push(`   位置：${it.location}`);
    lines.push(`   问题：${it.problem}`);
    lines.push(`   建议修法：${it.suggestion}`);
    lines.push(`   影响场景：${it.ue_scenario}`);
    lines.push(`   影响点：${it.ue_impact}`);
    if (it.decision_note) lines.push(`   用户备注：${it.decision_note}`);
    lines.push("");
  });
  const approved = items.filter(waitingFix);
  const others = items.filter((it) => !waitingFix(it));
  if (approved.length) {
    lines.push("请修复以下 review 项（来自 herdr-review，用户已通过）：", "");
    list(approved);
    lines.push('修完每项后运行 herdr-review item fixed <编号> --note "改了什么"，有提交时加 --commit <提交号>。');
  }
  if (others.length) {
    if (approved.length) lines.push("");
    lines.push(
      "以下 review 项（来自 herdr-review）用户还没有通过，先用于讨论：请分析问题和修法，不要修改代码，也不要运行 herdr-review item fixed。需要修复时，请用户先在 Review 面板中将其标为通过。",
      "",
    );
    list(others);
  }
  return lines.join("\n").trim();
}

/** 通知 agent 修复时发送的一条消息（单行，粘贴到任何 agent 都不会被拆开）。 */
export function fixMessage(ids) {
  return `请修复 herdr-review 中用户已通过的 review 项：${ids.join("、")}。先运行 herdr-review todo ${ids.join(" ")} 查看问题、建议修法和用户备注；每修完一项运行 herdr-review item fixed <编号> --note "改了什么"，有提交时加 --commit <提交号>。`;
}

/** 通知 agent 验证时发送的一条消息：让 agent 先 verify 查看待验证项，逐项标记结果。 */
export function verifyMessage(ids, cardId) {
  const scope = cardId ? ` --card ${cardId}` : "";
  return `请验证 herdr-review 中已修复的 review 项：${ids.join("、")}。先运行 herdr-review verify${scope} 查看问题、修复说明和用户备注；逐项实际验证后运行 herdr-review item verify <编号> --pass，未通过用 --fail --note "原因"。`;
}
