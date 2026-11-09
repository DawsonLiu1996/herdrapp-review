// herdr-review 命令的端到端测试：每个用例用独立的临时数据目录，按真实方式启动命令。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { codexThreadName } from "../src/context.ts";
import { cardStage, verifyState } from "../src/model.ts";
import { migrateDeferred } from "../src/store.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

interface Env {
  home: string;
  repoA: string;
  repoB: string;
}

function setupEnv(): Env {
  const root = mkdtempSync(join(tmpdir(), "herdr-review-test-"));
  const repoA = join(root, "repoA");
  const repoB = join(root, "repoB");
  mkdirSync(repoA);
  mkdirSync(repoB);
  return { home: join(root, "data"), repoA, repoB };
}

function run(env: Env, args: string[], opts: { input?: string; terminal?: string; agent?: boolean; codex?: boolean } = {}) {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, HERDR_REVIEW_HOME: env.home };
  delete childEnv.HC_TERMINAL_ID;
  delete childEnv.CLAUDECODE;
  delete childEnv.CODEX_THREAD_ID;
  if (opts.terminal) childEnv.HC_TERMINAL_ID = opts.terminal;
  if (opts.agent) childEnv.CLAUDECODE = "1";
  if (opts.codex) childEnv.CODEX_THREAD_ID = "thread-test";
  const r = spawnSync(process.execPath, [CLI, ...args], { env: childEnv, input: opts.input, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function item(title: string, extra: Record<string, unknown> = {}) {
  return {
    title,
    severity: "P2",
    location: "src/a.ts:1",
    problem: `${title} 的问题`,
    suggestion: `${title} 的修法`,
    ue_scenario: "用户提交表单时",
    ue_impact: "表单重复提交",
    ...extra,
  };
}

function create(env: Env, items: unknown[], opts: { cwd?: string; terminal?: string } = {}) {
  const r = run(env, ["card", "create", "--stdin", "--agent", "codex", "--cwd", opts.cwd ?? env.repoA], {
    input: JSON.stringify({ title: "登录流程 review", scope: "src", summary: "结论", items }),
    terminal: opts.terminal,
  });
  assert.equal(r.code, 0, r.err);
  return JSON.parse(r.out);
}

function card(env: Env, id: string) {
  return JSON.parse(readFileSync(join(env.home, "cards", `${id}.json`), "utf8"));
}

test("校验失败时退出码 2，逐项说明，数据不写入", () => {
  const env = setupEnv();
  const bad = { title: "x", items: [{ title: "a", severity: "P9", problem: "无", suggestion: "", ue_scenario: "N/A" }] };
  const r = run(env, ["card", "create", "--stdin", "--agent", "codex"], { input: JSON.stringify(bad) });
  assert.equal(r.code, 2);
  assert.match(r.err, /problem 写成了“无”/);
  assert.match(r.err, /缺少 suggestion/);
  assert.match(r.err, /缺少 ue_impact/);
  assert.match(r.err, /severity 必须是/);
  assert.equal(run(env, ["list", "--json"]).out.includes("R1"), false);
});

test("items 为空时必须写 summary，写了就直接发布", () => {
  const env = setupEnv();
  const r = run(env, ["card", "create", "--stdin", "--agent", "codex"], { input: JSON.stringify({ title: "复查", items: [] }) });
  assert.equal(r.code, 2);
  assert.match(r.err, /items 为空时必须填写 summary/);
  const ok = run(env, ["card", "create", "--stdin", "--agent", "codex"], {
    input: JSON.stringify({ title: "复查", summary: "未发现问题", items: [] }),
  });
  assert.equal(ok.code, 0, ok.err);
  assert.equal(JSON.parse(ok.out).status, "published");
});

test("没有旧项时直接发布；有旧项时先存草稿并返回比对清单", () => {
  const env = setupEnv();
  const first = create(env, [item("按钮可双击"), item("记住我默认勾选")]);
  assert.equal(first.status, "published");
  assert.deepEqual(first.items, ["R1-1", "R1-2"]);

  const second = create(env, [item("按钮可双击（再次）"), item("新问题")]);
  assert.equal(second.status, "draft");
  assert.deepEqual(second.compare_with.map((c: { id: string }) => c.id), ["R1-1", "R1-2"]);
  assert.match(second.next, /card publish R2/);

  // 其他 worktree 的项不参与比对
  const other = create(env, [item("别处的问题")], { cwd: env.repoB });
  assert.equal(other.status, "published");
});

test("发布时标出的重复项记到原条目上，原条目状态不变", () => {
  const env = setupEnv();
  create(env, [item("按钮可双击"), item("记住我默认勾选")]);
  assert.equal(run(env, ["item", "decide", "R1-1", "--reject", "--note", "设计如此"]).code, 0);
  create(env, [item("按钮可双击（再次）"), item("新问题")]);

  const r = run(env, ["card", "publish", "R2", "--same", "R2-1=R1-1"], { agent: true });
  assert.equal(r.code, 0, r.err);
  const r1 = card(env, "R1");
  const r2 = card(env, "R2");
  assert.equal(r2.state, "published");
  assert.deepEqual(r2.items.map((i: { id: string }) => i.id), ["R2-2"]);
  assert.deepEqual(r2.merged, [{ id: "R2-1", into: "R1-1" }]);
  assert.equal(r1.items[0].status, "decided");
  assert.equal(r1.items[0].decision, "reject");
  assert.equal(r1.items[0].repeats.length, 1);
  assert.equal(r1.items[0].repeats[0].item.title, "按钮可双击（再次）");
  assert.equal(r1.items[0].repeats[0].round, 2);
});

test("发布校验：编号必须属于草稿和比对清单，已修复的旧项不能标重复", () => {
  const env = setupEnv();
  create(env, [item("a"), item("b")]);
  run(env, ["item", "decide", "R1-2", "--approve"]);
  create(env, [item("a2"), item("b2")]);
  run(env, ["item", "fixed", "R1-2", "--note", "已加防抖"], { agent: true });

  const bad = run(env, ["card", "publish", "R2", "--same", "R2-9=R1-1", "--same", "R2-2=R1-2", "--same", "oops"], { agent: true });
  assert.equal(bad.code, 2);
  assert.match(bad.err, /R2-9 不是 R2 的条目/);
  assert.match(bad.err, /R1-2 已经修复/);
  assert.match(bad.err, /"oops" 格式不对/);
  assert.equal(card(env, "R2").state, "draft");

  assert.equal(run(env, ["card", "publish", "R2"], { agent: true }).code, 0);
  assert.equal(run(env, ["card", "publish", "R2"], { agent: true }).code, 4);
});

test("轮次：同一终端在同一 worktree 里的第几张卡", () => {
  const env = setupEnv();
  assert.equal(create(env, [item("a")], { terminal: "tA" }).round, 1);
  const second = create(env, [item("b")], { terminal: "tA" });
  assert.equal(second.round, 2);
  run(env, ["card", "publish", second.card_id]);
  assert.equal(create(env, [item("c")], { terminal: "tB" }).round, 1);
  assert.equal(create(env, [item("d")], { terminal: "tA", cwd: env.repoB }).round, 1);
});

test("决策只允许用户执行；状态流转按规则校验", () => {
  const env = setupEnv();
  create(env, [item("a"), item("b")]);
  const denied = run(env, ["item", "decide", "R1-1", "--approve"], { agent: true });
  assert.equal(denied.code, 3);
  assert.equal(card(env, "R1").items[0].status, "pending");

  assert.equal(run(env, ["item", "decide", "R1-1", "--defer"]).code, 0);
  // v0.4：暂缓的项移到原卡的副本卡，原卡记 moved
  assert.deepEqual(card(env, "R1").items.map((i: { id: string }) => i.id), ["R1-2"]);
  const copy = card(env, "R2");
  assert.equal(copy.origin, "R1");
  assert.equal(copy.items[0].id, "R1-1");
  assert.equal(copy.items[0].status, "deferred");
  assert.deepEqual(card(env, "R1").moved.map((m: { item: string }) => m.item), ["R1-1"]);
  assert.equal(run(env, ["item", "decide", "R1-1", "--defer"]).code, 4);
  // 副本卡只剩 R1-1 一项，全部选中时原地改状态，副本卡整体进入已决策
  assert.equal(run(env, ["item", "decide", "R1-1", "R1-2", "--approve", "--note", "要修"]).code, 0);
  assert.equal(card(env, "R2").items[0].decision, "approve");
  const c = card(env, "R1");
  assert.equal(c.items[0].id, "R1-2");
  assert.equal(c.items[0].decision, "approve");
  assert.equal(c.items[0].decision_note, "要修");
  assert.equal(run(env, ["item", "decide", "R1-2", "--undo"]).code, 0);
  assert.equal(card(env, "R1").items[0].status, "pending");
  assert.equal(run(env, ["item", "decide", "R1-2"]).code, 2);
});

test("一次决策多项时，任一项不合规则全部不写入", () => {
  const env = setupEnv();
  create(env, [item("a"), item("b")]);
  run(env, ["item", "decide", "R1-2", "--defer"]);
  const r = run(env, ["item", "decide", "R1-1", "R1-2", "--defer"]);
  assert.equal(r.code, 4);
  assert.equal(card(env, "R1").items[0].status, "pending");
});

test("交给 agent 修复、todo、标记已修复、重新打开", () => {
  const env = setupEnv();
  create(env, [item("a"), item("b")]);
  run(env, ["item", "decide", "R1-1", "--approve", "--note", "顺便补测试"]);
  run(env, ["item", "decide", "R1-2", "--reject"]);

  assert.equal(run(env, ["item", "assign", "R1-2", "--fixer", "t9", "--app", "codex"]).code, 4);
  assert.equal(run(env, ["item", "assign", "R1-1", "--fixer", "t9", "--app", "codex"]).code, 0);
  assert.equal(card(env, "R1").items[0].fixer.name, "Codex");

  const todo = run(env, ["todo", "--json", "--cwd", env.repoA], { agent: true });
  const rows = JSON.parse(todo.out).items;
  assert.deepEqual(rows.map((r: { id: string }) => r.id), ["R1-1"]);
  assert.equal(rows[0].decision_note, "顺便补测试");

  assert.equal(run(env, ["item", "fixed", "R1-1", "--note", "fixed"], { agent: true }).code, 2);
  assert.equal(run(env, ["item", "fixed", "R1-2", "--note", "改了"], { agent: true }).code, 4);
  assert.equal(run(env, ["item", "fixed", "R1-1", "--note", "加了防抖和测试", "--commit", "abc123"], { agent: true }).code, 0);
  const fixed = card(env, "R1").items[0];
  assert.equal(fixed.status, "fixed");
  assert.equal(fixed.fix.commit, "abc123");
  assert.equal(fixed.fix.by, "Claude Code");

  assert.equal(run(env, ["item", "decide", "R1-1", "--reopen"]).code, 0);
  assert.equal(card(env, "R1").items[0].status, "decided");
  assert.equal(card(env, "R1").items[0].fix, null);
});

test("拆分：用户纠正重复判断，条目回到本轮卡里待决策", () => {
  const env = setupEnv();
  create(env, [item("a"), item("b")]);
  create(env, [item("a2"), item("c")]);
  run(env, ["card", "publish", "R2", "--same", "R2-1=R1-1"]);

  assert.equal(run(env, ["item", "split", "R1-1", "--from", "R2-1"], { agent: true }).code, 3);
  const r = run(env, ["item", "split", "R1-1", "--from", "R2-1"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(card(env, "R1").items[0].repeats.length, 0);
  const r2 = card(env, "R2");
  assert.deepEqual(r2.items.map((i: { id: string; status: string }) => `${i.id}:${i.status}`), ["R2-1:pending", "R2-2:pending"]);
  assert.deepEqual(r2.merged, []);
});

test("草稿超过 30 分钟未发布时，任何命令都会按新问题自动发布并标记未完成比对", () => {
  const env = setupEnv();
  create(env, [item("a")]);
  create(env, [item("b")]);
  const file = join(env.home, "cards", "R2.json");
  const draft = JSON.parse(readFileSync(file, "utf8"));
  draft.created_at = new Date(Date.now() - 31 * 60_000).toISOString();
  writeFileSync(file, JSON.stringify(draft));

  const list = JSON.parse(run(env, ["list", "--json"]).out);
  const r2 = list.cards.find((c: { id: string }) => c.id === "R2");
  assert.equal(r2.state, "published");
  assert.equal(r2.compared, false);
});

test("用户可以删除卡片并恢复；agent 不能删除；删除后编号不复用", () => {
  const env = setupEnv();
  create(env, [item("a")]);
  assert.equal(run(env, ["card", "delete", "R1"], { agent: true }).code, 3);
  assert.equal(run(env, ["card", "delete", "R1"]).code, 0);
  assert.equal(existsSync(join(env.home, "cards", "R1.json")), false);
  assert.equal(JSON.parse(run(env, ["list", "--json"]).out).cards.length, 0);
  assert.equal(run(env, ["card", "delete", "R1"]).code, 4);
  assert.equal(create(env, [item("b")]).card_id, "R2");
  assert.equal(run(env, ["card", "restore", "R1"]).code, 0);
  assert.equal(card(env, "R1").items[0].title, "a");
  assert.equal(run(env, ["card", "restore", "R1"]).code, 4);
});

test("编号只增不减", () => {
  const env = setupEnv();
  create(env, [item("a")]);
  create(env, [item("b")], { cwd: env.repoB });
  assert.equal(create(env, [item("c")], { cwd: env.repoB }).card_id, "R3");
});

test("在 herdr-app 终端里但查不到身份时，拒绝用户专属操作", () => {
  const env = setupEnv();
  create(env, [item("a")]);
  // 不存在的终端编号：hc 查询失败（hc 不在 PATH 时同样失败），无法确认调用者是用户
  const opts = { terminal: "t-missing-0" };
  const r = run(env, ["item", "decide", "R1-1", "--approve"], opts);
  assert.equal(r.code, 3);
  assert.match(r.err, /无法确认调用者身份/);
  assert.equal(card(env, "R1").items[0].status, "pending");
  assert.equal(run(env, ["card", "delete", "R1"], opts).code, 3);
  assert.equal(run(env, ["item", "decide", "R1-1", "--approve"]).code, 0);
});

test("Codex 运行的命令按 agent 处理：不带 --agent、终端查不到 agent 时也一样", () => {
  const env = setupEnv();
  create(env, [item("a")]);
  // Codex 共用后台进程，环境里的终端可能已退出 Codex；只靠 CODEX_THREAD_ID 认出调用者
  const r = run(env, ["item", "decide", "R1-1", "--approve"], { codex: true });
  assert.equal(r.code, 3);
  assert.match(r.err, /agent 不能代替用户决策/);
  assert.equal(card(env, "R1").items[0].status, "pending");
  const c = run(env, ["card", "create", "--stdin", "--cwd", env.repoB], {
    input: JSON.stringify({ title: "另一轮", scope: "src", summary: "结论", items: [] }),
    codex: true,
  });
  assert.equal(c.code, 0, c.err);
  assert.equal(card(env, JSON.parse(c.out).card_id).reviewer.name, "Codex");
});

test("Codex 对话名从对话索引里取，改过名时取最后一次", () => {
  const home = mkdtempSync(join(tmpdir(), "codex-home-"));
  const lines = [
    { id: "th-1", thread_name: "审查项目代码", updated_at: "2026-01-01T00:00:00Z" },
    { id: "th-2", thread_name: "另一个对话", updated_at: "2026-01-01T00:00:01Z" },
    { id: "th-1", thread_name: "复查登录流程", updated_at: "2026-01-01T00:00:02Z" },
  ];
  writeFileSync(join(home, "session_index.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const before = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    assert.equal(codexThreadName("th-1"), "复查登录流程");
    assert.equal(codexThreadName("th-3"), null);
  } finally {
    if (before === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = before;
  }
});

test("没写新备注时保留原备注：暂缓后单项通过、批量通过；显式传空才清空", () => {
  const env = setupEnv();
  create(env, [item("a"), item("b"), item("c")]);
  run(env, ["item", "decide", "R1-1", "--defer", "--note", "只改前端"]);
  run(env, ["item", "decide", "R1-2", "--defer", "--note", "改用方案 B"]);
  run(env, ["item", "decide", "R1-3", "--defer", "--note", "补测试"]);
  // 三项都在副本卡 R2；R1-1 单独拉出时副本卡还有剩余，组成新卡 R3
  assert.equal(run(env, ["item", "decide", "R1-1", "--approve"]).code, 0);
  // 面板“发给 Agent”的路径：一次通过多项，不带 --note；R2 剩余两项全部拉出，原地进入已决策
  assert.equal(run(env, ["item", "decide", "R1-2", "R1-3", "--approve"]).code, 0);
  const noteOf = (id: string) => {
    for (const cid of ["R1", "R2", "R3"]) {
      const it = card(env, cid).items.find((x: { id: string }) => x.id === id);
      if (it) return it.decision_note;
    }
    return undefined;
  };
  assert.deepEqual(["R1-1", "R1-2", "R1-3"].map(noteOf), ["只改前端", "改用方案 B", "补测试"]);
  assert.equal(card(env, "R3").origin, "R1");
  assert.equal(run(env, ["item", "decide", "R1-1", "--reject", "--note="]).code, 0);
  assert.equal(noteOf("R1-1"), "");
});

test("撤销以后再说回到原卡；撤销移回待决策回到原副本卡；空了的卡移到回收站", () => {
  const env = setupEnv();
  const ids = (id: string) => card(env, id).items.map((x: { id: string }) => x.id);
  const live = (id: string) => existsSync(join(env.home, "cards", `${id}.json`));
  create(env, [item("a"), item("b"), item("c")]);
  // 选以后再说，再撤销（面板带 --restore）：回到 R1，原状态和备注恢复，副本卡 R2 空了移到回收站
  assert.equal(run(env, ["item", "decide", "R1-1", "--defer"]).code, 0);
  assert.deepEqual(ids("R2"), ["R1-1"]);
  const undo = run(env, ["item", "decide", "R1-1", "--pending", "--restore", "--note="]);
  assert.equal(undo.code, 0, undo.err);
  assert.deepEqual(ids("R1"), ["R1-1", "R1-2", "R1-3"]);
  assert.equal(card(env, "R1").items[0].status, "pending");
  assert.deepEqual(card(env, "R1").moved, []);
  assert.equal(live("R2"), false);
  assert.equal(existsSync(join(env.home, "trash", "R2.json")), true);

  // 两项放到以后再说（副本卡 R3），部分移回待决策（新卡 R4），撤销时回到 R3，R4 移到回收站
  run(env, ["item", "decide", "R1-1", "R1-2", "--defer"]);
  assert.deepEqual(ids("R3"), ["R1-1", "R1-2"]);
  run(env, ["item", "decide", "R1-1", "--pending"]);
  assert.deepEqual(ids("R4"), ["R1-1"]);
  assert.equal(run(env, ["item", "decide", "R1-1", "--defer", "--note="]).code, 0);
  assert.deepEqual(ids("R3"), ["R1-1", "R1-2"]);
  assert.equal(live("R4"), false);
  // 原卡的 moved 只记最初移出的两项，不因来回拉出重复记
  assert.deepEqual(card(env, "R1").moved.map((m: { item: string }) => m.item), ["R1-1", "R1-2"]);

  // 全部移回待决策（R3 原地进入待决策），撤销时 R3 原地变回副本卡，不建新卡
  run(env, ["item", "decide", "R1-1", "R1-2", "--pending"]);
  assert.equal(cardStage(card(env, "R3")), "pending");
  run(env, ["item", "decide", "R1-1", "R1-2", "--defer"]);
  assert.equal(cardStage(card(env, "R3")), "deferred");
  assert.equal(live("R5"), false);

  // wait 的结果补上移到以后再说的项和它现在所在的卡
  run(env, ["item", "decide", "R1-3", "--approve"]);
  const w = run(env, ["wait", "--card", "R1", "--timeout", "5s"]);
  assert.equal(w.code, 0, w.err);
  assert.match(w.out, /移到以后再说的项/);
  assert.match(w.out, /R1-1 a：以后再说（现在在 R3）/);
  assert.match(w.out, /R1-2 b：以后再说（现在在 R3）/);
});

test("卡片阶段和验证状态按 lifecycle 规则计算", () => {
  const env = setupEnv();
  create(env, [item("a"), item("b")]);
  assert.equal(cardStage(card(env, "R1")), "pending");
  // 暂缓一项：移到副本卡，原卡仍有 pending 项
  run(env, ["item", "decide", "R1-1", "--defer"]);
  assert.equal(cardStage(card(env, "R1")), "pending");
  assert.equal(cardStage(card(env, "R2")), "deferred");
  run(env, ["item", "decide", "R1-2", "--approve"]);
  assert.equal(cardStage(card(env, "R1")), "decided");
  run(env, ["item", "fixed", "R1-2", "--note", "改了"], { agent: true });
  assert.equal(cardStage(card(env, "R1")), "fixed");
  assert.equal(verifyState(card(env, "R1")), "pending");
});

test("验证：verify 列出待验证项，item verify 写结果，重新打开和再次修复清空", () => {
  const env = setupEnv();
  create(env, [item("a")]);
  run(env, ["item", "decide", "R1-1", "--approve"]);
  run(env, ["item", "fixed", "R1-1", "--note", "改了"], { agent: true });
  const v = run(env, ["verify", "--json", "--all"], { agent: true });
  assert.equal(JSON.parse(v.out).items.length, 1);
  assert.equal(JSON.parse(v.out).items[0].id, "R1-1");
  // --fail 必须写原因
  assert.equal(run(env, ["item", "verify", "R1-1", "--fail"], { agent: true }).code, 2);
  assert.equal(run(env, ["item", "verify", "R1-1", "--fail", "--note", "还白屏"], { agent: true }).code, 0);
  assert.equal(card(env, "R1").items[0].verify.result, "fail");
  assert.equal(verifyState(card(env, "R1")), "failed");
  // 指定验证 agent：agent 不能指定，用户可以；指定后是"验证中"
  assert.equal(run(env, ["item", "assign", "R1-1", "--verifier", "t9"], { agent: true }).code, 3);
  assert.equal(run(env, ["item", "assign", "R1-1", "--verifier", "t9"]).code, 0);
  assert.equal(card(env, "R1").items[0].verifier.terminal, "t9");
  // 重新打开清空 verify 和 verifier，再次标记已修复也清空
  run(env, ["item", "decide", "R1-1", "--reopen"]);
  run(env, ["item", "fixed", "R1-1", "--note", "又改了"], { agent: true });
  const it = card(env, "R1").items[0];
  assert.equal(it.verify, null);
  assert.equal(it.verifier, null);
  assert.equal(verifyState(card(env, "R1")), "pending");
  assert.equal(run(env, ["item", "verify", "R1-1", "--pass"], { agent: true }).code, 0);
  assert.equal(verifyState(card(env, "R1")), "passed");
});

test("归档：只能用户操作、只能归档已修复的卡；归档后 item verify 拒绝且不写入", () => {
  const env = setupEnv();
  create(env, [item("a"), item("b")]);
  // 待决策卡不能归档
  assert.equal(run(env, ["card", "archive", "R1"]).code, 4);
  run(env, ["item", "decide", "R1-1", "--approve"]);
  run(env, ["item", "fixed", "R1-1", "--note", "改了"], { agent: true });
  run(env, ["item", "decide", "R1-2", "--reject"]);
  // agent 不能归档
  assert.equal(run(env, ["card", "archive", "R1"], { agent: true }).code, 3);
  assert.equal(run(env, ["card", "archive", "R1"]).code, 0);
  assert.ok(card(env, "R1").archived_at);
  const r = run(env, ["item", "verify", "R1-1", "--pass"], { agent: true });
  assert.equal(r.code, 4);
  assert.match(r.err, /已归档/);
  assert.equal(card(env, "R1").items[0].verify, null);
  assert.equal(run(env, ["card", "unarchive", "R1"]).code, 0);
  assert.equal(card(env, "R1").archived_at, null);
});

test("已归档卡的未修复项仍参与新卡比对", () => {
  const env = setupEnv();
  create(env, [item("a")]);
  run(env, ["item", "decide", "R1-1", "--reject"]);
  run(env, ["card", "archive", "R1"]);
  const second = create(env, [item("a2")]);
  assert.equal(second.status, "draft");
  assert.deepEqual(second.compare_with.map((c: { id: string }) => c.id), ["R1-1"]);
});

test("旧数据迁移：普通卡里的 deferred 项移到副本卡，可重复执行", () => {
  const env = setupEnv();
  create(env, [item("a"), item("b")]);
  // 手工还原成旧格式：deferred 项留在普通卡里，没有 origin/moved/归档字段
  const file = join(env.home, "cards", "R1.json");
  const c = JSON.parse(readFileSync(file, "utf8"));
  delete c.origin;
  delete c.moved;
  delete c.archived_at;
  delete c.archived_by;
  c.items[0].status = "deferred";
  c.items[0].decision = null;
  writeFileSync(file, JSON.stringify(c));
  const before = process.env.HERDR_REVIEW_HOME;
  process.env.HERDR_REVIEW_HOME = env.home;
  try {
    const r1 = migrateDeferred();
    assert.equal(r1.moved, 1);
    assert.equal(r1.created.length, 1);
    // 迁移后：deferred 项在副本卡，原卡记 moved
    const src = card(env, "R1");
    assert.deepEqual(src.items.map((i: { id: string }) => i.id), ["R1-2"]);
    assert.equal(src.moved[0].item, "R1-1");
    const copy = card(env, r1.created[0]);
    assert.equal(copy.origin, "R1");
    assert.equal(copy.items[0].id, "R1-1");
    // 再跑一次：没有变化
    const r2 = migrateDeferred();
    assert.equal(r2.moved, 0);
    assert.equal(r2.created.length, 0);
  } finally {
    if (before === undefined) delete process.env.HERDR_REVIEW_HOME;
    else process.env.HERDR_REVIEW_HOME = before;
  }
});

test("setup --bin <目录> 和 --bin=<目录> 都生效；漏写目录时报参数错误", () => {
  const env = setupEnv();
  const setup = (...extra: string[]) => spawnSync(process.execPath, [CLI, "setup", "--dry-run", ...extra], {
    env: { ...process.env, HERDR_APP_HOME: join(env.home, "app") },
    encoding: "utf8",
  });
  const dir = join(env.home, "mybin");
  for (const args of [["--bin", dir], [`--bin=${dir}`]]) {
    const r = setup(...args);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(join(dir, "herdr-review")), r.stdout);
  }
  assert.equal(setup("--bin").status, 2);
  assert.equal(setup("--bin", "--rules").status, 2);
});
