// Review 面板：herdr-app 的公共面板，在任何 space 和 worktree 中都显示。
// 层级与侧栏一致：space → 挂在它下面的 worktree → review 卡 → review 项。
// 卡片所属的 space 或 worktree 没有在侧栏打开时不显示。
// 读：直接读 ~/.config/herdr-app/review/cards；写：调用 herdr-review 命令（唯一写数据的程序）。

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Popover, TextView } from "gpui-base";
import { agents, run, theme, settings, shared, exec, hc, knownAgents, nextCommand } from "herdr";
import { ReviewData, ICON, readConfig, timeText, waitingFix, copyText, fixMessage, verifyMessage, cardStage, verifyState, VERIFY_LABEL, verifyPending } from "./review-core.js";

const TABS = [
  { id: "pending", label: "待决策" },
  { id: "decided", label: "已决策" },
  { id: "fixed", label: "已修复" },
  { id: "deferred", label: "以后再说" },
];
// 整卡换栏目时提示用的栏目名和先后顺序（以后再说、已归档另有提示，不在这里）。
const STAGE_TEXT = { pending: "待决策", decided: "已决策", fixed: "已修复" };
const STAGE_ORDER = ["pending", "decided", "fixed"];
const EMPTY = {
  pending: "已打开的 space 里没有待决策的卡",
  decided: "已打开的 space 里没有已决策的卡",
  fixed: "已打开的 space 里没有已修复的卡",
  deferred: "已打开的 space 里没有以后再说的卡",
};
const STATUS_TEXT = { working: "工作中", blocked: "等待确认", done: "刚完成", idle: "空闲" };
const APP_ICON = { "claude-code": "icons/claude.svg", claude: "icons/claude.svg", codex: "icons/codex.svg" };
// 旧的修复记录没有存程序 id，按记录里的名字（"Claude Code · t32"）推断，用来挑图标。
const appOf = (by) => (/^Claude Code\b/.test(by ?? "") ? "claude-code" : /^Codex\b/.test(by ?? "") ? "codex" : null);
// 与侧栏 space 头像一致的颜色。
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
const SEV = { P0: 0, P1: 1, P2: 2, P3: 3 };
const bySev = (a, b) => (SEV[a.severity] ?? 9) - (SEV[b.severity] ?? 9);
const strip = (s) => String(s ?? "").replace(/。$/, "");
// 可拖选复制的文字用 TextView 显示（Markdown），先把标点转义，按原文显示。
const mdEscape = (s) => String(s ?? "").replace(/([\\`*_{}[\]()#+\-.!|<>~])/g, "\\$1");
const selectable = (id, text) => TextView.markdown(id, mdEscape(text)).selectable(true);
// agent 的显示名：类型 + 侧栏 Agents 里的名字（终端标题）。终端还开着时用现在的标题，
// 关了用记录时的标题，都没有时用终端编号。用户（app 为空）只显示"用户"。
const agentText = (rec) => {
  if (!rec) return "";
  if (!rec.app) return rec.name ?? "";
  const live = rec.terminal ? agents().find((a) => a.address === rec.terminal) : null;
  return [rec.name, live?.title || rec.title || rec.terminal].filter(Boolean).join(" · ");
};
// 修复记录的 by 是"Claude Code · t32"这样的文字，换成显示名。
const fixerText = (fix) => {
  const suffix = fix.terminal ? ` · ${fix.terminal}` : "";
  if (!suffix || !fix.by?.endsWith(suffix) || /^(用户|身份未确认)/.test(fix.by)) return fix.by;
  return agentText({ app: true, name: fix.by.slice(0, -suffix.length), terminal: fix.terminal, title: fix.title });
};
// 验证记录的显示：结果、原因、操作人、时间。
const verifyText = (v) => {
  const head = v.result === "pass" ? "验证通过" : "验证未通过";
  return `${head}${v.note ? `：${strip(v.note)}` : ""}${v.by ? ` · ${v.by}` : ""} · ${timeText(v.at)}`;
};
const FLAG = { approve: "--approve", reject: "--reject", defer: "--defer", pending: "--pending", reopen: "--reopen" };
const DONE_TEXT = {
  approve: "已标记为通过",
  reject: "已标记为不通过",
  defer: "已移到以后再说",
  pending: "已移回待决策",
  reopen: "已重新打开",
};

export default class Review extends View {
  init(_props, cx) {
    this.data = new ReviewData();
    this.tab = "pending";
    this.archived = false; // 已归档页：只读，按 space → worktree 分组
    this.open = null;
    this.noteFor = null;
    this.notes = {};
    this.selected = new Set();
    this.busy = new Set();
    this.flash = null;
    this.picker = null; // { kind: "fix" | "send" | "verify", key }
    this.pickerError = null; // { key, text } 发送失败时显示在气泡底部
    this.more = new Set(); // 已展开"更早的卡"的 space
    this.launchers = [];
    this.note = InputState.new({ placeholder: "例如：改用方案 B" });
    this.note.on("change", () => {
      if (this.noteFor) this.notes[this.noteFor] = this.note.value();
    });
    this.note.on("submit", (_e, cx) => {
      this.noteFor = null;
      cx.notify();
    });
    // 超时草稿由 ReviewData 自己调用命令发布（标签栏按钮那一份也会处理）。
    this.data.start(cx, (cx) => cx.notify());
    cx.spawn(async (cx) => {
      try {
        this.launchers = (await knownAgents()).filter((a) => a.installed).slice(0, 2);
        cx.notify();
      } catch {}
    });
    // 提示条 6 秒后消失。
    cx.timer.every(1000, (cx) => {
      if (this.flash && Date.now() > this.flash.until) {
        this.flash = null;
        cx.notify();
      }
    });
    // herdr-app do review.<command>：切换栏目、打开条目，供快捷键和核对使用。
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        this.command(command, cx);
        cx.notify();
      }
    });
  }

  async close() {
    this.data.stop();
  }

  // ---------- 数据 ----------

  rows() {
    return this.data.rows();
  }

  // 栏目数字按卡片数（与角标同一口径）。
  count(tab) {
    const ids = new Set();
    for (const { card } of this.data.visible()) {
      if (cardStage(card) === tab) ids.add(card.id);
    }
    return ids.size;
  }

  selectedRows() {
    return this.rows().filter(({ it }) => this.selected.has(it.id));
  }

  async cli(args) {
    this.config = this.config ?? (await readConfig());
    if (!this.config) throw new Error("没有找到 herdr-review 命令，请在插件目录运行 node cli/src/cli.ts setup");
    const r = await exec(this.config.node, [this.config.cli, ...args]);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout || `退出码 ${r.code}`).trim().split(/\r?\n/)[0]);
    return r.stdout;
  }

  // ---------- 操作 ----------

  say(text, undo = null) {
    this.flash = { text, undo, until: Date.now() + 6000 };
  }

  // 整卡换栏目的提示：最后一项决策完时“已全部决策，移到已决策”；退回前一栏时“移回”。
  moveText(title, before, after) {
    if (before === "pending" && (after === "decided" || after === "fixed")) return `${title} 已全部决策，移到${STAGE_TEXT[after]}`;
    const back = STAGE_ORDER.indexOf(after) < STAGE_ORDER.indexOf(before);
    return `${title} ${back ? "移回" : "移到"}${STAGE_TEXT[after]}`;
  }

  // 调用命令写入，成功后立即重读文件。track 是条目所在的卡：写入后这张卡换了栏目时，提示改为移到了哪一栏。
  act(ids, args, done, cx, undo = null, track = null) {
    const before = track ? cardStage(track) : null;
    for (const id of ids) this.busy.add(id);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.cli(args);
        await this.data.load();
        const now = track ? this.data.cards.find((c) => c.id === track.id) : null;
        const after = now ? cardStage(now) : null;
        this.say(after && after !== before && STAGE_TEXT[after] ? this.moveText(track.title, before, after) : done, undo);
      } catch (e) {
        this.say(`没有完成：${e.message}`);
      } finally {
        for (const id of ids) this.busy.delete(id);
        cx.notify();
      }
    });
  }

  decide(it, how, cx) {
    const note = this.noteOf(it).trim();
    const args = ["item", "decide", it.id, FLAG[how]];
    if (note && how !== "pending") args.push("--note", note);
    // 撤销：按决策前的状态和备注反向写一次。重新打开不能撤销（已修复只能由 agent 标记）。
    const prev = { status: it.status, decision: it.decision, note: it.decision_note ?? "" };
    let back = null;
    if (how !== "reopen") {
      // 备注用 --note=值 一个参数传，备注为空时也不会丢参数
      const keep = `--note=${prev.note}`;
      back = prev.status === "pending" ? ["--pending", keep]
        : prev.status === "deferred" ? ["--defer", keep]
        : prev.status === "decided" ? [FLAG[prev.decision], keep] : null;
      // 撤销“以后再说”：条目从副本卡回到原来的卡
      if (back && how === "defer") back.push("--restore");
    }
    const card = this.data.cards.find((c) => c.items.some((x) => x.id === it.id)) ?? null;
    const undo = back ? (cx) => this.act([it.id], ["item", "decide", it.id, ...back], "已撤销", cx) : null;
    delete this.notes[it.id];
    this.noteFor = null;
    this.selected.delete(it.id);
    if (this.open === it.id) this.open = null;
    this.act([it.id], args, `${DONE_TEXT[how]}：${it.title}`, cx, undo, card);
  }

  // 备注框的内容：用户写过的优先；验证未通过的项重新打开时，预填验证意见，修复的 agent 能看到。
  noteOf(it) {
    if (this.notes[it.id] !== undefined) return this.notes[it.id];
    if (it.status === "fixed" && it.verify?.result === "fail") return `验证意见：${strip(it.verify.note)}`;
    return "";
  }

  // agent 判断错了：把后续轮次提出的那条拆出来，作为该轮卡里的一条新问题，进入待决策。
  split(it, rep, cx) {
    this.act([it.id], ["item", "split", it.id, "--from", rep.item.id], `已拆成新问题，放入第 ${rep.round} 轮的卡`, cx);
  }

  moveBack(cx) {
    const ids = this.selectedRows().map((r) => r.it.id);
    if (!ids.length) return;
    this.selected.clear();
    this.act(ids, ["item", "decide", ...ids, "--pending"], `已将 ${ids.length} 项移回待决策`, cx,
      (cx) => this.act(ids, ["item", "decide", ...ids, "--defer"], "已撤销", cx));
  }

  copySelected(cx) {
    const items = this.selectedRows().map((r) => r.it);
    cx.write_to_clipboard(copyText(items));
    this.say(items.every(waitingFix)
      ? `已复制 ${items.length} 项，可以粘贴给 agent 修复`
      : `已复制 ${items.length} 项，用于和 agent 讨论；要修复请先通过，或用“发给 Agent”`);
    cx.notify();
  }

  // 在气泡里选中 agent 后：通知修复 / 通知验证；或把"以后再说"的项发过去（先标为通过）。
  pick(p, target, cx) {
    const rows = p.kind === "fix"
      ? p.card.items.filter(waitingFix).map((it) => ({ card: p.card, it }))
      : p.kind === "verify"
        ? verifyPending(p.card).map((it) => ({ card: p.card, it }))
        : this.selectedRows();
    const ids = rows.map((r) => r.it.id);
    if (!ids.length) return;
    const card = rows[0].card;
    const folder = card.repo_root ?? card.cwd;
    const text = p.kind === "verify" ? verifyMessage(ids, card.id) : fixMessage(ids);
    this.picker = null;
    this.pickerError = null;
    if (p.kind === "send") this.selected.clear();
    for (const id of ids) this.busy.add(id);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (p.kind === "send") await this.cli(["item", "decide", ...ids, "--approve"]);
        if (target.address) {
          const r = await hc(["send", target.address, text]);
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split(/\r?\n/)[0] || "发送失败");
        } else {
          run("tab.new", { space: p.space.id, folder, argv: target.run, task: text, name: p.kind === "verify" ? "验证 review 项" : "修复 review 项" });
        }
        await this.cli(["item", "assign", ...ids, p.kind === "verify" ? "--verifier" : "--fixer", target.address ?? "new", "--app", target.app ?? "", "--name", target.name]);
        await this.data.load();
        this.say(p.kind === "fix" ? `已通知 ${target.label} 修复 ${ids.length} 项`
          : p.kind === "verify" ? `已通知 ${target.label} 验证 ${ids.length} 项`
          : `已将 ${ids.length} 项标为通过，并发给 ${target.label}`);
      } catch (e) {
        // 验证气泡发送失败时留在原地，错误原文显示在气泡底部。
        if (p.kind === "verify") {
          this.picker = { kind: p.kind, key: p.key };
          this.pickerError = { key: p.key, text: e.message };
        }
        this.say(`没有完成：${e.message}`);
      } finally {
        for (const id of ids) this.busy.delete(id);
        cx.notify();
      }
    });
  }

  setTab(tab) {
    this.tab = tab;
    this.archived = false;
    this.picker = null;
    this.pickerError = null;
    this.noteFor = null;
    this.open = null;
  }

  command(command, cx) {
    // 与按钮走同一条路径，用于脚本核对：decide-R1-2-approve、split-R1-1-R2-3、fix-R1-t9、select-R1-2、undo
    const m = /^(decide|split|fix|select|delete|archive|verify|hover|confirm)-(R\d+(?:-\d+)?)(?:-(.+))?$/.exec(command);
    if (m) {
      const [, verb, id, arg] = m;
      const row = this.rows().find((r) => r.it.id === id);
      const card = this.data.visible().find((v) => v.card.id === id);
      if (verb === "decide" && row && FLAG[arg]) this.decide(row.it, arg, cx);
      if (verb === "split" && row) {
        const rep = row.it.repeats?.find((r) => r.item.id === arg);
        if (rep) this.split(row.it, rep, cx);
      }
      if (verb === "fix" && card && arg) {
        this.pick({ kind: "fix", card: card.card, space: card.space }, { address: arg, app: null, name: arg, label: arg }, cx);
      }
      if (verb === "verify" && card) this.picker = { kind: "verify", key: `verify-${card.card.id}` };
      if (verb === "archive" && card) this.archive(card.card, cx);
      if (verb === "delete" && card) this.remove(card.card, cx);
      if (verb === "hover") this.hoverCard = id;
      if (verb === "confirm") this.confirmDelete = id;
      if (verb === "select" && row) {
        if (this.selected.has(id)) this.selected.delete(id);
        else this.selected.add(id);
      }
      return;
    }
    if (command === "undo" && this.flash?.undo) {
      const undo = this.flash.undo;
      this.flash = null;
      undo(cx);
      return;
    }
    const tab = TABS.find((x) => command === `show-${x.id}`);
    if (tab) this.setTab(tab.id);
    if (command === "show-archived") {
      this.setTab(this.tab);
      this.archived = true;
    }
    // 栏目按整卡的阶段（cardStage）划分，打开条目时切到它所在卡的栏目
    if (command === "open-first") this.open = this.rows().find(({ card }) => cardStage(card) === this.tab)?.it.id ?? null;
    if (command.startsWith("open-") && command !== "open-first") {
      const row = this.rows().find(({ it }) => it.id === command.slice(5));
      const stage = row ? cardStage(row.card) : null;
      if (row && (this.archived ? stage === "archived" : TABS.some((x) => x.id === stage))) {
        if (!this.archived) this.tab = stage;
        this.open = row.it.id;
      }
    }
    if (command === "picker-fix") {
      this.setTab("decided");
      const row = this.rows().find(({ card, it }) => cardStage(card) === "decided" && waitingFix(it) && !it.fixer);
      if (row) this.picker = { kind: "fix", key: `fix-${row.card.id}` };
    }
  }

  // ---------- 界面 ----------

  render() {
    const t = theme();
    return v_flex().id("review-root").relative().size_full().min_h(0).rounded(10).overflow_hidden()
      .bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(this.header(t))
      .when(!this.archived, (el) => el.child(this.tabBar(t))
        .when(this.tab === "deferred", (e2) => e2.child(this.batchBar(t))))
      .child(this.archived ? this.archivedBody(t) : this.body(t))
      .when(Boolean(this.flash), (el) => el.child(this.footer(t)));
  }

  header(t) {
    return h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().flex_1().min_w(0).font_semibold()
        .child(this.archived
          ? h_flex().gap(8).items_center()
            .child(div().id("back").size(24).flex_none().flex().items_center().justify_center().rounded(6)
              .text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => {
                this.archived = false;
                cx.notify();
              })
              .child(svg(ICON("arrow-left")).size(15)))
            .child(div().child("已归档"))
          : h_flex().gap(10).items_center()
            .child(div().child("Review"))
            .child(div().id("archived-entry").h(24).px(6).flex_none().flex().items_center().rounded(6)
              .text_size(12).font_normal().text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => {
                this.archived = true;
                this.picker = null;
                this.pickerError = null;
                cx.notify();
              })
              .child("已归档 ›"))))
      .child(div().id("close").size(26).flex_none().flex().items_center().justify_center().rounded(6)
        .text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("layout.hide", { id: "review" }))
        .child(svg(ICON("x")).size(14)));
  }

  tabBar(t) {
    return h_flex().flex_none().p(8).gap(4).border_b(1).border_color(t.border).children(TABS.map((tab) => {
      const on = this.tab === tab.id;
      return h_flex().id(`tab-${tab.id}`).flex_1().min_w(0).h(28).gap(4).items_center().justify_center().rounded(7)
        .text_size(12).cursor_pointer().bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted)
        .hover((s) => s.bg(on ? t.selected : t.hover))
        .on_click((_e, cx) => {
          this.setTab(tab.id);
          cx.notify();
        })
        .child(div().when(on, (e) => e.font_semibold()).child(tab.label))
        .child(div().text_color(on ? t.foreground : t.dim).child(String(this.count(tab.id))));
    }));
  }

  batchBar(t) {
    const rows = this.selectedRows(), n = rows.length, on = n > 0;
    const oneSpace = on && rows.every((r) => r.space.id === rows[0].space.id);
    return v_flex().flex_none().px(10).py(8).gap(4).border_b(1).border_color(t.border)
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(on ? t.foreground : t.dim).child(on ? `已选 ${n} 项` : "请先勾选条目"))
        .child(this.button(t, "copy", "复制所选", "secondary", (_e, cx) => this.copySelected(cx), on))
        .child(this.agentPopover(t, { kind: "send", key: "send", label: "发给 Agent", space: rows[0]?.space, card: null, enabled: oneSpace }))
        .child(this.button(t, "back", "移回待决策", "secondary", (_e, cx) => this.moveBack(cx), on)))
      .when(on && !oneSpace, (el) => el.child(div().text_size(11.5).text_color(t.dim)
        .child("发给 Agent 需要只勾选同一个 space 或 worktree 的条目")));
  }

  body(t) {
    const visible = this.data.visible();
    // 整卡归栏：卡片阶段由 lifecycle.js 的 cardStage 决定，卡内显示全部条目。
    const cardsIn = (s) => visible
      .filter((v) => v.space.id === s.id)
      .map(({ card }) => ({ card, items: card.items.slice().sort(bySev) }))
      .filter(({ card }) => cardStage(card) === this.tab)
      .sort((a, b) => ((a.card.published_at ?? a.card.created_at) < (b.card.published_at ?? b.card.created_at) ? 1 : -1));
    const nodes = this.data.tree()
      .map(({ space, kids }) => ({
        space,
        cards: cardsIn(space),
        kids: kids.map((k) => ({ space: k, cards: cardsIn(k) })).filter((k) => k.cards.length),
      }))
      .filter((n) => n.cards.length || n.kids.length);
    const list = v_flex().id("review-body").flex_1().min_h(0).overflow_y_scrollbar().px(12).py(12).gap(22);
    if (!this.data.ready) return list.child(v_flex().pt(48).items_center().text_size(12.5).text_color(t.dim).child("正在读取 review 卡"));
    if (!nodes.length) return list.child(v_flex().pt(48).items_center().text_size(12.5).text_color(t.dim).child(EMPTY[this.tab]));
    return list.children(nodes.map((n) => this.spaceGroup(t, n)));
  }

  // 已归档页：只读，按 space → worktree 分组，组内按归档时间倒序。
  archivedBody(t) {
    const visible = this.data.visible().filter((v) => cardStage(v.card) === "archived");
    const cardsIn = (s) => visible
      .filter((v) => v.space.id === s.id)
      .map(({ card }) => ({ card, items: card.items.slice().sort(bySev) }))
      .sort((a, b) => String(b.card.archived_at ?? "").localeCompare(String(a.card.archived_at ?? "")));
    const nodes = this.data.tree()
      .map(({ space, kids }) => ({
        space,
        cards: cardsIn(space),
        kids: kids.map((k) => ({ space: k, cards: cardsIn(k) })).filter((k) => k.cards.length),
      }))
      .filter((n) => n.cards.length || n.kids.length);
    const list = v_flex().id("review-archived").flex_1().min_h(0).overflow_y_scrollbar().px(12).py(12).gap(22);
    if (!this.data.ready) return list.child(v_flex().pt(48).items_center().text_size(12.5).text_color(t.dim).child("正在读取 review 卡"));
    if (!nodes.length) return list.child(v_flex().pt(48).items_center().text_size(12.5).text_color(t.dim).child("已打开的 space 里没有已归档的卡"));
    return list.children(nodes.map((n) => this.spaceGroup(t, n)));
  }

  // color：需要提醒时用（如红色），文字和边框同色。
  tag(t, text, filled = false, color = null) {
    return div().flex_none().px(5).h(16).flex().items_center().rounded(4).text_size(10.5)
      .when(filled, (e) => e.bg(t.selected).text_color(t.muted))
      .when(!filled, (e) => e.border_1().border_color(color ?? t.border).text_color(color ?? t.dim))
      .child(text);
  }

  avatar(space) {
    const color = MARK[(shared("space.colors") ?? {})[space.id]] ?? "#8a8f98";
    return h_flex().size(18).flex_none().rounded(5).bg(color).items_center().justify_center()
      .text_size(10.5).font_bold().text_color("#ffffff").child([...space.name][0]?.toUpperCase() ?? "?");
  }

  // 第一层：space。下面先放直接属于它的卡，再放挂在它下面的 worktree。
  spaceGroup(t, { space, cards, kids }) {
    const info = this.data.git[space.id];
    return v_flex().gap(10)
      // 已归档页只读：标题不跳转
      .child(h_flex().id(`space-${space.id}`).h(24).gap(8).items_center()
        .when(!this.archived, (el) => el.cursor_pointer().on_click(() => run("space.select", { id: space.id })))
        .child(this.avatar(space))
        .child(div().min_w(0).truncate().text_size(14).font_semibold().child(space.name))
        .when(Boolean(info?.branch), (el) => el.child(div().flex_none().text_size(12).text_color(t.dim).child(info.branch)))
        .when(Boolean(info?.linked), (el) => el.child(this.tag(t, "worktree")))
        .when(space.active, (el) => el.child(this.tag(t, "当前", true))))
      .child(v_flex().ml(8).pl(14).border_l(1).border_color(t.border).gap(12)
        .children(this.cardList(t, space, cards))
        .children(kids.map((k) => this.worktreeGroup(t, k))));
  }

  // 第二层：worktree，与侧栏一样用分支图标，缩进在所属 space 下面。
  worktreeGroup(t, { space, cards }) {
    const info = this.data.git[space.id];
    return v_flex().gap(10)
      .child(h_flex().id(`wt-${space.id}`).h(22).gap(6).items_center()
        .when(!this.archived, (el) => el.cursor_pointer().on_click(() => run("space.select", { id: space.id })))
        .child(svg(ICON("git-branch")).size(14).flex_none().text_color(t.muted))
        .child(div().min_w(0).truncate().text_size(13).font_semibold().child(space.name))
        .when(Boolean(info?.branch) && info.branch !== space.name, (el) => el.child(div().flex_none().text_size(12).text_color(t.dim).child(info.branch)))
        .child(this.tag(t, "worktree"))
        .when(space.active, (el) => el.child(this.tag(t, "当前", true))))
      .child(v_flex().ml(6).pl(14).border_l(1).border_color(t.border).gap(12)
        .children(this.cardList(t, space, cards)));
  }

  // 同一个 space 或 worktree 下的卡按时间倒序，默认只显示最近 3 张。
  cardList(t, space, cards) {
    const LIMIT = 3;
    const all = this.more.has(space.id);
    const shown = all ? cards : cards.slice(0, LIMIT);
    const hidden = cards.length - LIMIT;
    const out = shown.map((c) => this.cardBlock(t, space, c));
    if (hidden > 0) {
      out.push(h_flex().child(div().id(`more-${space.id}`).text_size(12).text_color(t.accent).cursor_pointer()
        .on_click((_e, cx) => {
          if (all) this.more.delete(space.id);
          else this.more.add(space.id);
          cx.notify();
        })
        .child(all ? "收起更早的卡" : `显示更早的 ${hidden} 张卡`)));
    }
    return out;
  }

  // 同一个 agent 在同一个 space 或 worktree 里有多张卡时，标出第几轮。
  // 副本卡和拉出的卡复制了原卡的卡头，不算新的一轮，不计入。
  roundLabel(card, space) {
    const same = this.data.visible().filter((v) => v.space.id === space.id && !v.card.origin && v.card.reviewer?.terminal === card.reviewer?.terminal);
    return same.length > 1 || card.round > 1 ? `第 ${card.round} 轮` : null;
  }

  // 第三层：review 卡。一张卡是一个带边框的容器：上面是卡头，下面是这张卡的条目，条目之间用分隔线隔开。
  // 已归档页（this.archived）里卡片只读：没有操作按钮，条目展开后只有内容没有决策区。
  cardBlock(t, space, { card, items }) {
    const ro = this.archived;
    const stage = cardStage(card);
    const waiting = card.items.filter(waitingFix);
    const pendingVerify = stage === "fixed" ? verifyPending(card) : [];
    const action = !ro && this.tab === "decided" && waiting.length > 0
      ? this.agentPopover(t, { kind: "fix", key: `fix-${card.id}`, label: "通知 Agent", space, card, enabled: !waiting.some((it) => this.busy.has(it.id)) })
      : !ro && stage === "fixed" && pendingVerify.length > 0
        ? this.agentPopover(t, { kind: "verify", key: `verify-${card.id}`, label: "通知 Agent", space, card, enabled: !pendingVerify.some((it) => this.busy.has(it.id)) })
        : null;
    const round = this.roundLabel(card, space);
    const who = card.reviewer ?? {};
    // 已修复、已归档的卡：标题后是最终标签，下面分行列出 Review、修复、验证（已归档页再加归档时间）。
    const done = stage === "fixed" || stage === "archived";
    const final = done ? this.finalTag(t, card) : null;
    const movedCount = ro ? 0 : this.movedCount(card);
    const meta = done ? this.roleLines(t, card, ro)
      : [this.metaLine(t, null, APP_ICON[who.app], agentText(who), timeText(card.published_at ?? card.created_at))];
    return v_flex().id(`card-${card.id}`).flex_none().rounded(10).border_1().border_color(t.border)
      .bg(t.background).overflow_hidden()
      .on_hover((hovered, cx) => {
        if (hovered) this.hoverCard = card.id;
        else if (this.hoverCard === card.id) this.hoverCard = null;
        cx.notify();
      })
      // 卡头：第一行是标题和右侧操作区，下面的说明行占满卡片宽度，名字不会被操作区挤掉。
      .child(v_flex().pl(12).pr(8).pt(10).pb(9).gap(3)
        .child(h_flex().gap(6).items_center()
          .child(h_flex().flex_1().min_w(0).min_h(20).gap(6).items_center()
            .child(svg(ICON("review")).size(14).flex_none().text_color(t.muted))
            .child(div().min_w(0).truncate().font_semibold().child(card.title))
            .when(Boolean(round), (el) => el.child(this.tag(t, round, false, card.round >= 3 ? t.ansi1 : null)))
            // 拉出以后再说、进入其他栏目的卡才标；以后再说栏里的副本卡不标
            .when(Boolean(card.origin) && stage !== "deferred", (el) => el.child(this.tag(t, "来自以后再说")))
            .when(Boolean(final), (el) => el.child(final)))
          // 操作区不被压缩，标题再长也不会和按钮重叠
          .child(h_flex().flex_none().gap(4).items_center()
            .when(Boolean(action), (el) => el.child(action))
            .when(!ro && stage === "fixed", (el) => el.child(this.archiveButton(t, card)))
            .when(!ro && stage !== "fixed", (el) => el.child(this.deleteButton(t, card)))))
        .children(meta))
      .children(items.map((it) => this.itemRow(t, it, !ro && this.tab === "deferred", ro)))
      .when(!ro && movedCount > 0, (el) => el.child(div().px(12).pb(8).text_size(11.5).text_color(t.dim)
        .child(`${movedCount} 项已移到以后再说`)));
  }

  // 原卡移到以后再说、现在仍在以后再说的项数。拉出、撤销或副本卡被删除后不再计入。
  movedCount(card) {
    const moved = new Set((card.moved ?? []).map((m) => m.item));
    if (!moved.size) return 0;
    let n = 0;
    for (const c of this.data.cards) for (const it of c.items) if (moved.has(it.id) && it.status === "deferred") n++;
    return n;
  }

  // 卡头的一行说明：[标签] [agent 图标] 名字 · 时间。名字较长时只截断名字，时间始终显示。
  metaLine(t, label, icon, name, when) {
    return h_flex().pl(20).gap(5).items_center().text_size(11.5).text_color(t.dim)
      .when(Boolean(label), (el) => el.child(div().w(42).flex_none().text_color(t.muted).child(label)))
      .when(Boolean(icon), (el) => el.child(image(icon).size(12).flex_none()))
      // 分行列出时没有图标的行留出图标位置，名字和上下行对齐
      .when(Boolean(label && name && !icon), (el) => el.child(div().size(12).flex_none()))
      .when(Boolean(name), (el) => el.child(div().min_w(0).truncate().child(name)))
      .when(Boolean(when), (el) => el.child(div().flex_none().child(name ? `· ${when}` : when)));
  }

  // 已修复、已归档卡的卡头分行：Review、修复（每个修复的 agent 一行）、验证（每个验证的 agent 一行）、归档。
  roleLines(t, card, ro) {
    const who = card.reviewer ?? {};
    const lines = [this.metaLine(t, "Review", APP_ICON[who.app], agentText(who), timeText(card.published_at ?? card.created_at))];
    const group = (label, recs) => {
      const latest = new Map();
      for (const r of recs) {
        const key = r.terminal || r.by || "";
        const old = latest.get(key);
        if (!old || String(r.at) > String(old.at)) latest.set(key, r);
      }
      [...latest.values()].sort((a, b) => String(a.at).localeCompare(String(b.at)))
        .forEach((r) => lines.push(this.metaLine(t, label, APP_ICON[r.app ?? appOf(r.by)], fixerText(r), timeText(r.at))));
    };
    group("修复", card.items.filter((it) => it.status === "fixed" && it.fix).map((it) => it.fix));
    // 验证记录没有存程序 id：先看交给的验证 agent，再看终端里现在运行的 agent
    group("验证", card.items.filter((it) => it.verify).map((it) => {
      const v = it.verify;
      const live = v.terminal ? agents().find((a) => a.address === v.terminal) : null;
      const app = v.app ?? (it.verifier?.terminal === v.terminal ? it.verifier?.app : null) ?? live?.app ?? live?.program?.key ?? null;
      return { ...v, app };
    }));
    if (ro && card.archived_at) lines.push(this.metaLine(t, "归档", null, null, timeText(card.archived_at)));
    return lines;
  }

  // 已修复、已归档卡标题后的最终标签。待验证不加标签（卡头有“通知 Agent”）。
  finalTag(t, card) {
    if (card.items.length === 0) return this.resultTag(t, card);
    const vs = verifyState(card);
    if (vs === "passed") {
      return h_flex().flex_none().h(18).pl(5).pr(6).gap(3).items_center().rounded(4).bg(t.ansi2)
        .text_color("#ffffff").text_size(11).font_semibold()
        .child(svg(ICON("check")).size(11).flex_none())
        .child(VERIFY_LABEL.passed);
    }
    if (vs === "failed") return this.tag(t, VERIFY_LABEL.failed, false, t.ansi1);
    if (vs === "verifying" || vs === "none") return this.tag(t, VERIFY_LABEL[vs], true);
    return null;
  }

  // 归档按钮：已修复卡常驻显示（不等悬停），点击后底部可撤销（unarchive）。
  archiveButton(t, card) {
    const label = "归档这张卡";
    return div().id(`archive-${card.id}`).size(22).flex_none().flex().items_center().justify_center().rounded(5)
      .text_color(t.dim).tooltip(label).accessibility_label(label).cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.archive(card, cx);
      })
      .child(svg(ICON("archive")).size(14));
  }

  archive(card, cx) {
    this.hoverCard = null;
    this.act([card.id], ["card", "archive", card.id], `已归档：${card.title}`, cx,
      (cx) => this.act([card.id], ["card", "unarchive", card.id], "已撤销", cx));
  }

  // 没有新条目的卡只显示卡头，结果标在标题后面：没发现问题是"审核通过"；提出的问题都是旧问题时标"均为旧问题"。
  resultTag(t, card) {
    if (card.merged?.length) return div().flex_none().h(20).flex().items_center().child(this.tag(t, "均为旧问题", true));
    return h_flex().flex_none().h(20).px(6).gap(3).items_center().rounded(4)
      .bg(`${t.ansi2}1f`).text_color(t.ansi2).text_size(11).font_semibold()
      .child("审核通过")
      .child(svg(ICON("check-check")).size(13).flex_none());
  }

  // 卡头右上角的删除按钮（待决策、已决策、以后再说的卡）：鼠标移到卡片上才显示，不显示时仍占位，
  // 避免卡头内容跳动。点击后弹小气泡确认，删除后可撤销。没有条目的卡都在已修复栏，用归档按钮。
  deleteButton(t, card) {
    const confirming = this.confirmDelete === card.id;
    const shown = (this.hoverCard === card.id || confirming) && !this.busy.has(card.id);
    const label = "删除这张卡";
    const button = div().id(`delete-${card.id}`).size(22).flex_none().flex().items_center().justify_center().rounded(5)
      .text_color(confirming ? t.ansi1 : `${t.ansi1}a6`).tooltip(label).accessibility_label(label)
      .when(confirming, (e) => e.bg(`${t.ansi1}1f`))
      .when(!shown, (e) => e.invisible())
      .when(shown, (e) => e.cursor_pointer().hover((s) => s.bg(`${t.ansi1}1f`).text_color(t.ansi1)))
      .child(svg(ICON("trash")).size(14));
    if (!shown) return button;
    return Popover.new(`confirm-delete-${card.id}`).anchor("top_right").open(confirming)
      .on_open_change((value, cx) => {
        this.confirmDelete = value ? card.id : null;
        cx.notify();
      })
      .trigger(button)
      .content(this.deleteBubble(t, card));
  }

  deleteBubble(t, card) {
    return v_flex().id(`confirm-bubble-${card.id}`).w(248).mt(4).p(12).gap(10).rounded(10)
      .bg(t.popover).border_1().border_color(t.border).shadow_lg().text_color(t.foreground)
      .child(v_flex().gap(4)
        .child(div().text_size(12.5).font_semibold().child("删除这张卡？"))
        .child(v_flex().text_size(12).line_height("18px").text_color(t.muted)
          .child(div().child(`卡里的 ${card.items.length} 项会一起删除。`))
          .child(div().child("删除后可以在底部撤销。"))))
      .child(h_flex().gap(8).justify_end()
        .child(this.button(t, `cancel-delete-${card.id}`, "取消", "secondary", (_e, cx) => {
          this.confirmDelete = null;
          cx.notify();
        }))
        .child(h_flex().id(`confirm-delete-btn-${card.id}`).h(28).px(10).flex_none().items_center().justify_center()
          .rounded(7).text_size(12).bg(t.ansi1).text_color("#ffffff").cursor_pointer().hover((s) => s.opacity(0.85))
          .on_click((_e, cx) => {
            this.confirmDelete = null;
            this.remove(card, cx);
          })
          .child("删除")));
  }

  remove(card, cx) {
    this.hoverCard = null;
    this.act([card.id], ["card", "delete", card.id], `已删除：${card.title}`, cx,
      (cx) => this.act([card.id], ["card", "restore", card.id], "已撤销", cx));
  }

  // 第四层：review 项，卡片里的一行：严重程度、标题、状态。展开时整条（标题行和展开内容）都带底色。
  // ro（已归档页）时不可勾选，展开只有内容没有决策区。
  itemRow(t, it, checkable, ro = false) {
    const open = this.open === it.id;
    const head = h_flex().id(`head-${it.id}`).min_h(40).px(12).py(9).gap(8).items_center().cursor_pointer()
      .bg(open ? t.raised : t.background)
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        this.open = open ? null : it.id;
        this.noteFor = null;
        cx.notify();
      })
      .when(checkable, (el) => el.child(this.checkbox(t, it)))
      .child(this.sevTag(t, it.severity))
      .child(open
        // 展开后标题文字可以拖选（在文字上按下鼠标不收起）；文字右侧的空白仍是这一行，点击收起。
        ? h_flex().flex_1().min_w(0)
          .child(div().id(`title-${it.id}`).flex_initial().min_w(0).font_semibold()
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .child(selectable(`sel-${it.id}-title`, it.title)))
        : div().flex_1().min_w(0).truncate().child(it.title))
      .when(Boolean(it.repeats?.length), (el) => el.child(this.tag(t, "再次提出", false, t.ansi1)))
      .child(this.statusTag(t, it))
      .child(div().flex_none().text_color(open ? t.foreground : t.dim).child(svg(ICON(open ? "chevron-down" : "chevron-right")).size(14)));
    return v_flex().id(`item-${it.id}`).border_t(1).border_color(t.border).bg(open ? t.raised : t.background)
      .child(head)
      .when(open, (el) => el.child(this.detail(t, it, ro)));
  }

  sevTag(t, sev) {
    const c = sev === "P0" || sev === "P1" ? t.ansi1 : sev === "P2" ? t.ansi3 : t.muted;
    return div().flex_none().px(5).h(18).flex().items_center().rounded(4).border_1().border_color(c)
      .text_color(c).text_size(10.5).font_semibold().child(sev);
  }

  statusTag(t, it) {
    let text = null, color = t.muted;
    if (this.busy.has(it.id)) {
      text = "处理中";
    } else if (it.status === "decided" && it.decision === "approve") {
      text = it.fixer ? "通过 · 修复中" : "通过 · 等待修复";
      color = t.ansi2;
    } else if (it.status === "decided" && it.decision === "reject") {
      text = "不通过";
    } else if (it.status === "fixed") {
      const result = it.verify?.result;
      text = result === "pass" ? "已验证" : result === "fail" ? "验证未通过" : "已修复";
      color = result === "fail" ? t.ansi1 : t.ansi2;
    }
    if (!text) return div();
    return div().flex_none().px(6).h(18).flex().items_center().rounded(4).border_1().border_color(color)
      .text_color(color).text_size(11).child(text);
  }

  // 展开后的内容：左列是小标题，右列是内容；下方分隔出决策区。ro 时只显示内容。
  detail(t, it, ro = false) {
    const mono = settings().font_family ?? "JetBrains Mono";
    const busy = this.busy.has(it.id);
    // 文字内容可以拖选复制，方便决策前拿去和 agent 讨论。
    const field = (label, content) => h_flex().gap(12).items_start()
      .child(div().w(52).flex_none().text_size(12).line_height("20px").text_color(t.muted).child(label))
      .child(div().flex_1().min_w(0).text_size(13).line_height("20px").text_color(t.foreground)
        .child(typeof content === "string" ? selectable(`sel-${it.id}-${label}`, content) : content));
    let fields = v_flex().px(12).pt(4).pb(12).gap(10)
      .when(Boolean(it.location), (el) => el.child(field("位置", h_flex().gap(5).items_center()
        .child(svg(ICON("file-code")).size(12).flex_none().text_color(t.dim))
        .child(div().flex_1().min_w(0).font_family(mono).text_size(12).child(selectable(`sel-${it.id}-loc`, it.location))))))
      .child(field("问题", strip(it.problem)))
      .child(field("建议修法", strip(it.suggestion)))
      .child(field("影响场景", strip(it.ue_scenario)))
      .child(field("影响点", strip(it.ue_impact)))
      // 已归档页只读：只显示再次提出的记录，不提供拆分
      .children((it.repeats ?? []).map((rep) => field("再次提出", v_flex().gap(4)
        .child(div().child(`第 ${rep.round} 轮 · ${timeText(rep.at)} · agent 判断与本条是同一问题`))
        .when(!ro, (el) => el.child(h_flex().child(div().id(`split-${rep.item.id}`).text_size(12).text_color(busy ? t.dim : t.accent)
          .when(!busy, (e) => e.cursor_pointer().on_click((_e, cx) => this.split(it, rep, cx)))
          .child("不是同一问题，拆成新问题")))))));
    // 按状态补充的记录：备注、修复、验证。已归档页同样显示，只是没有下面的操作区。
    const note = it.decision_note;
    if (it.status === "deferred") fields = fields.when(Boolean(note), (el) => el.child(field("备注", note)));
    if (it.status === "decided") {
      fields = fields.when(Boolean(note), (el) => el.child(field("决策备注", note)))
        .when(Boolean(it.fixer), (el) => el.child(field("修复", `${agentText({ app: true, ...it.fixer })} 修复中`)));
    }
    if (it.status === "fixed") {
      const fix = it.fix ?? {};
      const record = [fixerText(fix), timeText(fix.at), fix.commit ? `提交 ${fix.commit}` : null].filter(Boolean).join(" · ");
      fields = fields.when(Boolean(note), (el) => el.child(field("决策备注", note)))
        .child(field("修复说明", strip(fix.note)))
        .child(field("修复记录", record))
        .when(Boolean(it.verifier) && !it.verify, (el) => el.child(field("验证", `${agentText({ app: true, ...it.verifier })} 验证中`)))
        .when(Boolean(it.verify), (el) => el.child(field("验证结果", verifyText(it.verify))));
    }
    if (ro) return fields;
    const actions = v_flex().px(12).py(10).gap(10).border_t(1).border_color(t.border);
    const row = (...buttons) => h_flex().gap(8).children(buttons);
    const btn = (id, label, kind, how) => this.button(t, `${id}-${it.id}`, label, kind, (_e, cx) => this.decide(it, how, cx), !busy);
    if (it.status === "pending" || it.status === "deferred") {
      const third = it.status === "pending" ? btn("defer", "以后再说", "secondary", "defer") : btn("pending", "移回待决策", "secondary", "pending");
      return v_flex().child(fields).child(actions.child(this.noteArea(t, it, "决策备注（选填，修复的 agent 能看到）")).child(row(
        btn("approve", "通过", "primary", "approve"),
        btn("reject", "不通过", "secondary", "reject"),
        third,
      )));
    }
    if (it.status === "decided") return v_flex().child(fields).child(actions.child(row(btn("undo", "撤销决策", "secondary", "pending"))));
    // 重新打开前可以写备注；验证未通过时已预填验证意见
    return v_flex().child(fields).child(actions.child(this.noteArea(t, it, "重新打开的备注（选填，修复的 agent 能看到）"))
      .child(row(btn("reopen", "重新打开", "secondary", "reopen"))));
  }

  noteArea(t, it, label) {
    if (this.noteFor === it.id) {
      return v_flex().gap(4)
        .child(div().text_size(12).text_color(t.muted).child(label))
        .child(div().id(`note-${it.id}`).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(t.accent)
          .cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Input.new(this.note).h_full().w_full().text_size(12).text_color(t.foreground)));
    }
    const saved = this.noteOf(it).trim();
    return h_flex().child(div().id(`note-link-${it.id}`).min_w(0).text_size(12).text_color(saved ? t.muted : t.accent).cursor_pointer()
      .on_click((_e, cx) => {
        const value = this.noteOf(it);
        this.noteFor = it.id;
        this.notes[it.id] = value;
        this.note.set_value(value);
        cx.notify();
      })
      .child(saved ? `备注：${saved}` : "添加备注"));
  }

  checkbox(t, it) {
    const on = this.selected.has(it.id);
    return div().id(`check-${it.id}`).flex_none().size(16).flex().items_center().justify_center().rounded(4)
      .border_1().border_color(on ? t.solid : t.input).bg(on ? t.solid : t.background).text_color(t.solid_foreground)
      .cursor_pointer()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        if (on) this.selected.delete(it.id);
        else this.selected.add(it.id);
        cx.notify();
      })
      .when(on, (e) => e.child(svg(ICON("check")).size(11)));
  }

  button(t, id, label, kind, onClick, enabled = true, active = false) {
    const primary = kind === "primary";
    return h_flex().id(id).h(28).px(10).flex_none().items_center().justify_center().rounded(7).text_size(12)
      .border_1().border_color(!enabled ? t.border : primary ? t.solid : t.input)
      .bg(!enabled ? t.raised : primary ? t.solid : active ? t.selected : t.background)
      .text_color(!enabled ? t.dim : primary ? t.solid_foreground : t.foreground)
      .when(enabled, (e) => e.cursor_pointer().hover((s) => s.opacity(0.85)))
      .when(enabled && Boolean(onClick), (e) => e.on_click(onClick))
      .child(label);
  }

  // 按钮 + 小气泡：点按钮在按钮下方弹出 agent 列表，点外面或按 Esc 关闭。
  agentPopover(t, p) {
    const open = this.picker?.key === p.key;
    const trigger = this.button(t, `btn-${p.key}`, p.label, "secondary", null, p.enabled, open);
    if (!p.enabled) return trigger;
    return Popover.new(`pop-${p.key}`).anchor("top_right").open(open)
      .on_open_change((value, cx) => {
        this.picker = value ? { kind: p.kind, key: p.key } : null;
        cx.notify();
      })
      .trigger(trigger)
      .content(this.agentBubble(t, p));
  }

  agentBubble(t, p) {
    const count = p.kind === "fix" ? p.card.items.filter(waitingFix).length
      : p.kind === "verify" ? verifyPending(p.card).length
      : this.selectedRows().length;
    const reviewer = p.card?.reviewer?.terminal;
    // 修复过这张卡的 agent（验证气泡里标"修复"，方便看出谁修的、谁验证）。
    const fixers = new Set((p.card?.items ?? []).map((it) => it.fixer?.terminal).filter(Boolean));
    const list = agents().filter((a) => a.space === p.space.id);
    const icon = (prog) => !prog?.icon ? div().size(16).flex_none()
      : prog.tint ? svg(prog.icon).size(16).flex_none().text_color(t.muted) : image(prog.icon).size(16).flex_none();
    const row = (id, prog, label, sub, tag, target) => h_flex().id(id).h(40).px(8).gap(10).items_center().rounded(7)
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.pick(p, target, cx))
      .child(icon(prog))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(h_flex().gap(6).items_center()
          .child(div().min_w(0).truncate().text_size(12.5).child(label))
          .when(Boolean(tag), (el) => el.child(this.tag(t, tag, true))))
        .when(Boolean(sub), (el) => el.child(div().truncate().text_size(11).text_color(t.dim).child(sub))));
    return v_flex().id(`bubble-${p.key}`).w(272).mt(4).p(6).gap(1).rounded(10)
      .bg(t.popover).border_1().border_color(t.border).shadow_lg().text_color(t.foreground)
      .child(v_flex().px(8).pt(4).pb(6).gap(1)
        .child(div().text_size(12.5).font_semibold().child(
          p.kind === "fix" ? "交给哪个 agent 修复" : p.kind === "verify" ? "交给哪个 agent 验证" : "发给哪个 agent"))
        .child(div().text_size(11.5).text_color(t.dim).child(`${p.space.name} · ${count} 项`)))
      .when(this.pickerError?.key === p.key, (el) => el.child(div().mx(8).mb(2).text_size(11).text_color(t.ansi1).child(this.pickerError.text)))
      .when(list.length === 0, (el) => el.child(div().px(8).py(6).text_size(12).text_color(t.dim).child("这里没有正在运行的 agent")))
      .children(list.map((a) => {
        const name = a.program?.name ?? a.app ?? a.address;
        const shown = a.title || a.address;
        return row(`agent-${p.key}-${a.address}`, a.program, shown,
          `${name} · ${STATUS_TEXT[a.status] ?? a.status}`,
          a.address === reviewer ? "负责 review" : p.kind === "verify" && fixers.has(a.address) ? "修复" : null,
          { address: a.address, app: a.app ?? a.program?.key ?? null, name, label: `${name} · ${shown}` });
      }))
      .when(this.launchers.length > 0, (el) => el.child(div().mx(8).my(4).h(1).bg(t.border)))
      .children(this.launchers.map((k) => row(`new-${k.key}-${p.key}`, k, `新开 ${k.name}`, null, null,
        { address: null, app: k.key, run: k.run, name: `${k.name}（新开）`, label: `新开的 ${k.name}` })));
  }

  footer(t) {
    const f = this.flash;
    return h_flex().flex_none().h(38).px(12).gap(8).items_center().border_t(1).border_color(t.border).bg(t.raised)
      .child(div().flex_1().min_w(0).truncate().text_size(12).child(f.text))
      .when(Boolean(f.undo), (e) => e.child(div().id("undo").flex_none().text_size(12).text_color(t.accent).cursor_pointer()
        .on_click((_e, cx) => {
          const undo = f.undo;
          this.flash = null;
          undo(cx);
        })
        .child("撤销")));
  }
}
