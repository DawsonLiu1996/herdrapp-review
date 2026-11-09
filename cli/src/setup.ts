// herdr-review setup：在本机安装命令入口、Review 面板、agent 技能，可选写入全局规则。
// 在插件仓库里运行：node cli/src/cli.ts setup。不需要发布到 npm。
//
//   setup              安装命令入口、面板、布局、快捷键、技能；打印全局规则的内容，不写入
//   setup --rules      同时把规则写入 ~/.claude/CLAUDE.md 和 ~/.codex/AGENTS.md（用户确认后再加）
//   setup --dry-run    只列出会做什么
//   setup --uninstall  撤销安装（review 数据保留）
//   setup --bin <目录> 指定命令入口放在哪个目录（默认选 PATH 里的 ~/.local/bin 等）

import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { appHome, cliFile, repoRoot, reviewHome } from "./paths.ts";
import { CliError } from "./model.ts";
import { migrateDeferred } from "./store.ts";

type Flags = Record<string, string | true>;

const BEGIN = "<!-- herdr-review:begin -->";
const END = "<!-- herdr-review:end -->";
const KEY = "ctrl-shift-r";
const KEY_ACTION = "layout.toggle:review";
const win = process.platform === "win32";
const slash = (p: string) => p.replace(/\\/g, "/");
const samePath = (a: string, b: string) => slash(a).replace(/\/+$/, "").toLowerCase() === slash(b).replace(/\/+$/, "").toLowerCase();

interface Step {
  what: string;
  run: () => string | void;
}

function pickBin(flags: Flags): string {
  if (flags.bin !== undefined) {
    // --bin <目录> 和 --bin=<目录> 都由 parseArgs 解析成字符串；空值或紧跟另一个参数说明漏写了目录
    const dir = typeof flags.bin === "string" ? flags.bin.trim() : "";
    if (!dir || dir.startsWith("--")) throw new CliError("--bin 后面需要一个目录，例如 --bin ~/.local/bin", 2);
    return dir;
  }
  const path = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const candidates = [join(homedir(), ".local", "bin"), process.env.APPDATA ? join(process.env.APPDATA, "npm") : "", join(homedir(), "bin")].filter(Boolean);
  const hit = candidates.find((c) => path.some((p) => samePath(p, c)));
  if (!hit) {
    throw new CliError(`没有找到合适的命令目录。请用 --bin <目录> 指定一个在 PATH 里的目录，例如 --bin ${candidates[0]}`, 2);
  }
  return hit;
}

function launchers(bin: string): { file: string; text: string }[] {
  const node = process.execPath;
  const out = [{ file: join(bin, "herdr-review"), text: `#!/bin/sh\nexec "${slash(node)}" "${slash(cliFile)}" "$@"\n` }];
  if (win) out.push({ file: join(bin, "herdr-review.cmd"), text: `@echo off\r\n"${node}" "${cliFile}" %*\r\n` });
  return out;
}

function copyDir(from: string, to: string, extra: string[] = []): void {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) cpSync(join(from, name), join(to, name), { recursive: true });
  for (const file of extra) cpSync(file, join(to, file.split(/[\\/]/).pop()!));
}

function readJson(file: string): any {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function withBlock(text: string, block: string | null): string {
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  let base = text;
  if (start >= 0 && end > start) base = (text.slice(0, start) + text.slice(end + END.length)).replace(/\n{3,}$/, "\n\n");
  base = base.replace(/\s+$/, "");
  if (!block) return base ? `${base}\n` : "";
  return `${base ? `${base}\n\n` : ""}${BEGIN}\n${block.trim()}\n${END}\n`;
}

function ruleTargets(): string[] {
  const out = [join(homedir(), ".claude", "CLAUDE.md")];
  if (existsSync(join(homedir(), ".codex"))) out.push(join(homedir(), ".codex", "AGENTS.md"));
  return out;
}

function skillTargets(): string[] {
  const out = [join(homedir(), ".claude", "skills", "herdr-review")];
  if (existsSync(join(homedir(), ".codex"))) out.push(join(homedir(), ".codex", "skills", "herdr-review"));
  return out;
}

function herdrApp(args: string[]): boolean {
  try {
    return spawnSync("herdr-app", args, { encoding: "utf8", windowsHide: true, timeout: 15_000 }).status === 0;
  } catch {
    return false;
  }
}

function installSteps(flags: Flags): Step[] {
  const app = appHome();
  const mods = join(app, "mods");
  const core = join(repoRoot, "mod", "review", "review-core.js");
  const lifecycle = join(repoRoot, "mod", "review", "lifecycle.js");
  const bin = pickBin(flags);
  const rules = readFileSync(join(repoRoot, "agent-assets", "rules.md"), "utf8");
  const steps: Step[] = [
    {
      what: `记录命令位置：${join(reviewHome(), "config.json")}`,
      run: () => {
        mkdirSync(join(reviewHome(), "cards"), { recursive: true });
        writeFileSync(join(reviewHome(), "config.json"), `${JSON.stringify({ node: process.execPath, cli: cliFile, repo: repoRoot }, null, 2)}\n`);
      },
    },
    {
      what: `命令入口：${launchers(bin).map((l) => l.file).join("、")}`,
      run: () => {
        mkdirSync(bin, { recursive: true });
        for (const l of launchers(bin)) {
          writeFileSync(l.file, l.text);
          if (!win || !l.file.endsWith(".cmd")) chmodSync(l.file, 0o755);
        }
      },
    },
    {
      what: `Review 面板：${join(mods, "review")}`,
      run: () => copyDir(join(repoRoot, "mod", "review"), join(mods, "review")),
    },
    {
      what: `标签栏 Review 按钮（自带 tabs 的复制）：${join(mods, "review-tabs")}`,
      run: () => copyDir(join(repoRoot, "mod", "review-tabs"), join(mods, "review-tabs"), [core, lifecycle]),
    },
    {
      what: `Review 布局：${join(app, "layouts", "review.json")}（已存在时保留）`,
      run: () => {
        const file = join(app, "layouts", "review.json");
        if (existsSync(file)) return "已存在，保留";
        mkdirSync(dirname(file), { recursive: true });
        cpSync(join(repoRoot, "layout", "review.json"), file);
      },
    },
    {
      what: `快捷键：${KEY} 显示或隐藏 Review 面板（keys.json）`,
      run: () => {
        const file = join(app, "keys.json");
        const keys = readJson(file) ?? {};
        keys.global ??= {};
        const current = keys.global[KEY];
        if (current && current !== KEY_ACTION) return `${KEY} 已用于 ${current}，未改动`;
        if (current === KEY_ACTION) return "已存在";
        keys.global[KEY] = KEY_ACTION;
        writeFileSync(file, `${JSON.stringify(keys, null, 2)}\n`);
      },
    },
    {
      what: `agent 技能：${skillTargets().map((d) => join(d, "SKILL.md")).join("、")}`,
      run: () => {
        for (const dir of skillTargets()) {
          mkdirSync(dir, { recursive: true });
          cpSync(join(repoRoot, "agent-assets", "SKILL.md"), join(dir, "SKILL.md"));
        }
      },
    },
  ];
  if (flags.rules) {
    steps.push({
      what: `全局规则：追加到 ${ruleTargets().join("、")}（用 herdr-review 标记包起来，可重复执行、可卸载）`,
      run: () => {
        for (const file of ruleTargets()) {
          mkdirSync(dirname(file), { recursive: true });
          const text = existsSync(file) ? readFileSync(file, "utf8") : "";
          writeFileSync(file, withBlock(text, rules));
        }
      },
    });
  }
  steps.push({
    what: "迁移旧数据：普通卡里遗留的「以后再说」条目移到副本卡",
    run: () => {
      const r = migrateDeferred();
      return r.moved ? `移动 ${r.moved} 项${r.created.length ? `，新建副本卡 ${r.created.join("、")}` : ""}` : "无需迁移";
    },
  });
  steps.push({
    what: "切换到 Review 布局（herdr-app 正在运行时）",
    run: () => (herdrApp(["do", "layout.switch", JSON.stringify({ name: "review" })]) ? undefined : "herdr-app 没有运行，下次在布局菜单里选 review"),
  });
  return steps;
}

function uninstallSteps(flags: Flags): Step[] {
  const app = appHome();
  const bin = pickBin(flags);
  return [
    { what: "切回默认布局", run: () => void herdrApp(["do", "layout.switch", JSON.stringify({ name: "main" })]) },
    { what: "删除命令入口", run: () => launchers(bin).forEach((l) => rmSync(l.file, { force: true })) },
    {
      what: "删除面板、标签栏按钮和布局",
      run: () => {
        rmSync(join(app, "mods", "review"), { recursive: true, force: true });
        rmSync(join(app, "mods", "review-tabs"), { recursive: true, force: true });
        rmSync(join(app, "layouts", "review.json"), { force: true });
      },
    },
    {
      what: "移除快捷键",
      run: () => {
        const file = join(app, "keys.json");
        const keys = readJson(file);
        if (keys?.global?.[KEY] === KEY_ACTION) {
          delete keys.global[KEY];
          writeFileSync(file, `${JSON.stringify(keys, null, 2)}\n`);
        }
      },
    },
    { what: "删除 agent 技能", run: () => skillTargets().forEach((d) => rmSync(d, { recursive: true, force: true })) },
    {
      what: "移除全局规则",
      run: () => {
        for (const file of ruleTargets()) {
          if (!existsSync(file)) continue;
          const text = readFileSync(file, "utf8");
          if (text.includes(BEGIN)) writeFileSync(file, withBlock(text, null));
        }
      },
    },
    { what: `review 数据保留在 ${reviewHome()}`, run: () => undefined },
  ];
}

export function setup(flags: Flags): void {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 18)) {
    throw new CliError(`需要 Node 22.18 或更新版本（当前 ${process.versions.node}），用来直接运行 TypeScript`, 2);
  }
  const steps = flags.uninstall ? uninstallSteps(flags) : installSteps(flags);
  const out: string[] = [flags.dry_run || flags["dry-run"] ? "将会执行：" : flags.uninstall ? "卸载 herdr-review：" : "安装 herdr-review："];
  for (const step of steps) {
    if (flags["dry-run"] || flags.dry_run) {
      out.push(`- ${step.what}`);
      continue;
    }
    const note = step.run();
    out.push(`- ${step.what}${note ? `：${note}` : ""}`);
  }
  if (!flags.uninstall && !flags.rules) {
    const rules = readFileSync(join(repoRoot, "agent-assets", "rules.md"), "utf8").trim();
    out.push(
      "",
      `全局规则没有写入。确认后运行 herdr-review setup --rules，会把下面这段追加到 ${ruleTargets().join("、")}：`,
      "",
      rules,
    );
  }
  process.stdout.write(`${out.join("\n")}\n`);
}
