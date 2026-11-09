// 终端身份和终端定位的单元测试：用假的 hc 输出代替真实的 herdr-app。

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hc, parseTerminal, locateTerminal, terminalInfo } from "../src/context.ts";

const realRun = hc.run;
afterEach(() => {
  hc.run = realRun;
});

interface Fake {
  address: string;
  app: string | null;
  cwd: string;
  space: string;
  title?: string;
}

/** 按给定的终端列表回答 hc get / hc ls。 */
function fakeHc(terminals: Fake[]) {
  hc.run = (args) => {
    if (args[0] === "ls") {
      return JSON.stringify({ terminals: terminals.map((t) => ({ address: t.address, agent: t.app ?? "pwsh.exe", cwd: t.cwd, state: "live" })) });
    }
    const t = terminals.find((x) => x.address === args[1]);
    if (!t) return null;
    return JSON.stringify({
      address: t.address,
      cwd: t.cwd,
      title: t.title ?? "",
      status: t.app ? { app: t.app, state: "idle" } : null,
      labels: { "herdr.space": t.space, where: `${t.space} / tab` },
    });
  };
}

test("hc get 的结果结构不对时按查不到处理，不能当成普通 shell", () => {
  for (const out of ["{}", '{"address":"t1"}', '{"address":"t2","status":null}', '{"address":"t1","status":[]}', '{"address":"t1","status":"idle"}', "[]", "null", "不是 JSON", null]) {
    const r = parseTerminal("t1", out);
    assert.equal(r.ok, false, `输出 ${out} 应判为查不到`);
    assert.equal(r.app, null);
  }
  assert.deepEqual(
    [parseTerminal("t1", '{"address":"t1","status":null}'), parseTerminal("t1", '{"address":"t1","status":{"app":"codex"}}'), parseTerminal("t1", '{"address":"t1","status":{}}')].map((r) => [r.ok, r.app]),
    [[true, null], [true, "codex"], [true, "agent"]],
  );
});

test("Codex 定位：环境里的终端对不上、本项目有两个 Codex 时，不沿用其他项目的 space", () => {
  fakeHc([
    { address: "t-old", app: "codex", cwd: "D:/other-project", space: "s-other" },
    { address: "t-a", app: "codex", cwd: "D:/project", space: "s-proj" },
    { address: "t-b", app: "codex", cwd: "D:/project", space: "s-proj" },
  ]);
  const r = locateTerminal("t-old", terminalInfo("t-old"), "D:/project", "codex", null);
  assert.equal(r.terminal, null);
  assert.equal(r.info.space_id, "s-proj");
  assert.equal(r.info.app, "codex");
});

test("Codex 定位：候选终端在不同 space 时，终端和 space 都不记", () => {
  fakeHc([
    { address: "t-old", app: "codex", cwd: "D:/other-project", space: "s-other" },
    { address: "t-a", app: "codex", cwd: "D:/project", space: "s-1" },
    { address: "t-b", app: "codex", cwd: "D:/project", space: "s-2" },
  ]);
  const r = locateTerminal("t-old", terminalInfo("t-old"), "D:/project", "codex", null);
  assert.equal(r.terminal, null);
  assert.equal(r.info.space_id, null);
});

test("Codex 定位：环境里的终端已退出 Codex、本项目没有 Codex 窗口时，不沿用它的 space", () => {
  fakeHc([{ address: "t-old", app: null, cwd: "D:/other-project", space: "s-other" }]);
  const r = locateTerminal("t-old", terminalInfo("t-old"), "D:/project", "codex", null);
  assert.equal(r.terminal, null);
  assert.equal(r.info.space_id, null);
});

test("Codex 定位：找到唯一终端时用它；环境里的终端对得上时沿用", () => {
  fakeHc([
    { address: "t-old", app: null, cwd: "D:/other-project", space: "s-other" },
    { address: "t-a", app: "codex", cwd: "D:/project", space: "s-proj" },
  ]);
  assert.equal(locateTerminal("t-old", terminalInfo("t-old"), "D:/project/src", "codex", null).terminal, "t-a");
  assert.equal(locateTerminal("t-a", terminalInfo("t-a"), "D:/project", "codex", null).terminal, "t-a");
});

test("Codex 定位：同目录两个 Codex 时按对话名分清", () => {
  const home = mkdtempSync(join(tmpdir(), "codex-home-"));
  writeFileSync(join(home, "session_index.jsonl"), JSON.stringify({ id: "th-1", thread_name: "复查登录流程" }) + "\n");
  const before = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    fakeHc([
      { address: "t-old", app: "codex", cwd: "D:/other-project", space: "s-other", title: "别的对话 | other-project" },
      { address: "t-a", app: "codex", cwd: "D:/project", space: "s-proj", title: "审查全项目 | project" },
      { address: "t-b", app: "codex", cwd: "D:/project", space: "s-proj", title: "复查登录流程 | project" },
    ]);
    assert.equal(locateTerminal("t-old", terminalInfo("t-old"), "D:/project", "codex", "th-1").terminal, "t-b");
  } finally {
    if (before === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = before;
  }
});
