// 调用方是谁、在哪里：herdr-app 终端编号、所在 space、运行的 agent，以及当前目录的 Git 信息。

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Card } from "./model.ts";

export interface Ctx {
  terminal: string | null;
  /** 终端里运行的 agent，例如 "claude-code"、"codex"；普通 shell 为 null。 */
  app: string | null;
  agentName: string | null;
  /** 终端标题，也就是 herdr-app 侧栏 Agents 里显示的名字。 */
  title: string | null;
  space_id: string | null;
  space_name: string | null;
  cwd: string;
  repo_root: string | null;
  branch: string | null;
  head: string | null;
  isAgent: boolean;
  /**
   * 在 herdr-app 终端里（有 HC_TERMINAL_ID），但 hc 查询失败（不在 PATH、超时、返回异常），
   * 无法确认调用者是用户还是 agent。此时拒绝用户专属的写操作。
   */
  identityUnknown: boolean;
  /** 在 herdr-app 终端里，但没能确认是哪个终端（见 locateTerminal），此时 terminal 为 null。 */
  terminalUnconfirmed: boolean;
}

const APP_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini CLI",
  opencode: "OpenCode",
  cursor: "Cursor",
  copilot: "Copilot",
  amp: "Amp",
  pi: "Pi",
};

export function appName(app: string | null): string {
  if (!app) return "用户";
  return APP_NAMES[app] ?? app;
}

function runText(cmd: string, args: string[], cwd?: string): string | null {
  try {
    const r = spawnSync(cmd, args, { cwd, encoding: "utf8", windowsHide: true, timeout: 10_000 });
    return r.status === 0 ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

export function gitInfo(cwd: string): { repo_root: string | null; branch: string | null; head: string | null } {
  const out = runText("git", ["rev-parse", "--path-format=absolute", "--show-toplevel", "--abbrev-ref", "HEAD"], cwd);
  if (!out) return { repo_root: null, branch: null, head: null };
  const [top, branch] = out.split(/\r?\n/);
  const head = runText("git", ["rev-parse", "--short", "HEAD"], cwd);
  return { repo_root: top || null, branch: branch && branch !== "HEAD" ? branch : null, head };
}

export interface TerminalInfo {
  ok: boolean;
  app: string | null;
  space_id: string | null;
  space_name: string | null;
  /** 终端现在所在的目录。 */
  cwd: string | null;
  /** 终端标题（程序设置的），侧栏 Agents 里显示的就是它。 */
  title: string | null;
}

const NO_TERMINAL: TerminalInfo = { ok: true, app: null, space_id: null, space_name: null, cwd: null, title: null };

/**
 * 用 hc get 查一个 herdr-app 终端：运行的 agent 和所在 space。
 * ok=false 表示没查到（hc 不在 PATH、超时、返回不是这个终端的信息），这时 app=null 不代表“普通 shell”。
 */
export function terminalInfo(terminal: string): TerminalInfo {
  return parseTerminal(terminal, hc.run(["get", terminal, "--json"]));
}

/** 运行 hc 命令，返回输出；失败时返回 null。测试时替换 run。 */
export const hc = { run: (args: string[]): string | null => runText("hc", args) };

const UNKNOWN: TerminalInfo = { ok: false, app: null, space_id: null, space_name: null, cwd: null, title: null };

/**
 * 解析 hc get --json 的输出。只认确实是这个终端的结果：address 对得上，并且带 status 字段
 * （运行 agent 时是对象，普通 shell 是 null）。结构不对时按查不到处理，不能当成普通 shell 放行。
 * status 是对象但没写 app 时仍是 agent（只有 agent 会上报状态），记为 "agent"。
 */
export function parseTerminal(terminal: string, out: string | null): TerminalInfo {
  if (!out) return UNKNOWN;
  let info;
  try {
    info = JSON.parse(out);
  } catch {
    return UNKNOWN;
  }
  if (!info || typeof info !== "object" || info.address !== terminal || !("status" in info)) return UNKNOWN;
  const status = info.status;
  if (status !== null && (typeof status !== "object" || Array.isArray(status))) return UNKNOWN;
  return {
    ok: true,
    app: status ? (typeof status.app === "string" && status.app) || "agent" : null,
    space_id: info.labels?.["herdr.space"] || null,
    space_name: String(info.labels?.where ?? "").split(" / ")[0] || null,
    cwd: typeof info.cwd === "string" ? info.cwd : null,
    title: typeof info.title === "string" && info.title.trim() ? info.title.trim() : null,
  };
}

/**
 * Codex 对话的名字，从 Codex 的对话索引里查；还没起名时返回 null。
 * Codex 给它运行的每条命令设置 CODEX_THREAD_ID（对话编号），并把对话名放在窗口标题开头，
 * 例如 "审查项目代码 | herdr-review-plugin"，所以能用对话名对上窗口。
 */
export function codexThreadName(thread: string): string | null {
  let text: string;
  try {
    text = readFileSync(join(process.env.CODEX_HOME || join(homedir(), ".codex"), "session_index.jsonl"), "utf8");
  } catch {
    return null;
  }
  // 改名时会追加一行，取最后一条
  let name: string | null = null;
  for (const line of text.split("\n")) {
    if (!line.includes(thread)) continue;
    try {
      const e = JSON.parse(line);
      if (e.id === thread && typeof e.thread_name === "string" && e.thread_name.trim()) name = e.thread_name.trim();
    } catch {}
  }
  return name;
}

/** 窗口标题是否以这个对话名开头（忽略开头可能出现的状态符号）。 */
function titleHasName(title: string | null, name: string): boolean {
  const bare = (s: string) => s.replace(/^[^\p{L}\p{N}]+/u, "");
  const t = bare(title ?? "");
  const n = bare(name);
  return Boolean(n) && (t === n || t.startsWith(`${n} | `));
}

/** 目录等于或包含 cwd 的终端里，目录最深的那些（可能不止一个）。 */
function deepest<T extends { cwd?: string | null }>(list: T[], cwd: string): T[] {
  const near = list.map((t) => ({ t, depth: closeness(t.cwd, cwd) })).filter((x) => x.depth >= 0);
  if (!near.length) return [];
  const max = Math.max(...near.map((x) => x.depth));
  return near.filter((x) => x.depth === max).map((x) => x.t);
}

/**
 * 多个窗口共用一个后台进程的 agent。它在任何窗口里运行的命令，继承的都是启动这个后台进程的
 * 那个窗口的 HC_TERMINAL_ID，所以环境变量里的终端编号不可信。
 */
const SHARED_PROCESS_APPS = new Set(["codex"]);

/** dir 等于 cwd 或包含 cwd 时返回目录长度（越大越近），否则返回 -1。 */
function closeness(dir: string | null | undefined, cwd: string): number {
  const d = norm(dir);
  const here = norm(cwd);
  return d && (here === d || here.startsWith(d + "/")) ? d.length : -1;
}

/**
 * 核对 HC_TERMINAL_ID 是否真是调用者所在的终端。app 是调用者运行的 agent，只处理共用后台进程的（Codex）：
 * 例如项目 A 的 Codex 先启动，项目 B 的 Codex 提交的卡也会带上项目 A 那个窗口的编号。
 * 那个窗口退出 Codex 后后台进程仍在，环境里的终端变成普通 shell，同样不是调用者。
 * 1. 按对话名找：thread 是 CODEX_THREAD_ID，查到对话名后，在运行这个 agent 的终端里找标题以对话名开头的；
 *    不止一个时再按目录挑。
 * 2. 按目录找（对话还没起名，或标题对不上时）：环境里的终端在运行这个 agent 且目录包含调用目录时沿用；
 *    否则在运行这个 agent 的终端里找目录等于或包含调用目录的，取目录最深且唯一的那一个。
 * 环境里的终端已确认不是调用者、又找不到唯一的终端时，不沿用它（它的 space 属于别的项目）：
 * 终端记为未确认（null）；候选终端都在同一个 space 时记这个 space，否则 space 也不记，面板按目录匹配。
 * 其他 agent（如 Claude Code）每个窗口是独立进程，环境变量可信，不做改动。
 */
export function locateTerminal(
  terminal: string,
  info: TerminalInfo,
  cwd: string,
  app: string | null = info.app,
  thread: string | null = process.env.CODEX_THREAD_ID || null,
): { terminal: string | null; info: TerminalInfo } {
  const keep = { terminal, info };
  if (!app || !SHARED_PROCESS_APPS.has(app)) return keep;
  const name = thread ? codexThreadName(thread) : null;
  const envFits = info.ok && info.app === app && closeness(info.cwd, cwd) >= 0;
  if (!name && envFits) return keep;
  const out = hc.run(["ls"]);
  let list: { address: string; agent?: string; cwd?: string; state?: string }[] | null = null;
  try {
    list = out ? JSON.parse(out).terminals ?? [] : null;
  } catch {}
  // 环境里的终端查不到（hc 出错或终端已不存在）时无法判断它对不对，没找到别的终端就沿用编号（此时本来就没有 space）
  if (!list) return envFits || !info.ok ? keep : unconfirmed([], app);
  const live = list.filter((t) => t.state === "live" && t.agent === app);
  const withInfo = (t: { address: string; cwd?: string }) => ({ address: t.address, cwd: t.cwd, info: t.address === terminal ? info : terminalInfo(t.address) });
  if (name) {
    const named = live.map(withInfo).filter((t) => t.info.ok && titleHasName(t.info.title, name));
    const pick = named.length === 1 ? named : deepest(named, cwd);
    if (pick.length === 1) return { terminal: pick[0].address, info: pick[0].info };
    if (envFits) return keep;
    if (named.length) return unconfirmed(named, app);
  }
  // 走到这里时环境里的终端对不上或查不到（对得上的情况在前面已经沿用）
  const near = deepest(live, cwd).map(withInfo).filter((t) => t.info.ok);
  if (near.length === 1) return { terminal: near[0].address, info: near[0].info };
  if (!info.ok && !near.length) return keep;
  return unconfirmed(near, app);
}

/** 找不到唯一终端时：终端记为未确认；候选终端都在同一个 space 时记这个 space，否则不记。 */
function unconfirmed(candidates: { info: TerminalInfo }[], app: string): { terminal: null; info: TerminalInfo } {
  const spaces = new Set(candidates.map((t) => t.info.space_id));
  const one = spaces.size === 1 && candidates[0].info.space_id ? candidates[0].info : null;
  return {
    terminal: null,
    info: { ok: true, app, space_id: one?.space_id ?? null, space_name: one?.space_name ?? null, cwd: null, title: null },
  };
}

/**
 * git=false 时不查 Git（决策类命令用不到，面板调用时更快）。
 * locate=true 时核对终端编号（见 locateTerminal），需要记录调用者所在终端和 space 的命令才开启；
 * 默认跟随 git。
 */
export function detect(opts: { cwd?: string; agent?: string; git?: boolean; locate?: boolean } = {}): Ctx {
  const cwd = resolve(opts.cwd ?? process.cwd());
  // 调用者自己表明的 agent：--agent 参数，或 Codex 给它运行的每条命令设置的 CODEX_THREAD_ID。
  // 不能只看终端：Codex 的后台进程可能是从一个已经退出 Codex 的窗口启动的，那个窗口现在是普通 shell。
  const self = opts.agent || (process.env.CODEX_THREAD_ID ? "codex" : null);
  const envTerminal = process.env.HC_TERMINAL_ID || null;
  let terminal = envTerminal;
  let info = terminal ? terminalInfo(terminal) : NO_TERMINAL;
  if (terminal && (opts.locate ?? opts.git !== false)) ({ terminal, info } = locateTerminal(terminal, info, cwd, self ?? info.app));
  const { space_id, space_name } = info;
  // 在 herdr-app 之外运行的 Claude Code 也要识别为 agent。
  const app = self ?? info.app ?? (process.env.CLAUDECODE === "1" ? "claude-code" : null);
  return {
    terminal,
    app,
    agentName: app ? appName(app) : null,
    title: info.title,
    space_id,
    space_name,
    cwd,
    ...(opts.git === false ? { repo_root: null, branch: null, head: null } : gitInfo(cwd)),
    isAgent: Boolean(app),
    identityUnknown: !app && !info.ok,
    terminalUnconfirmed: Boolean(envTerminal) && !terminal,
  };
}

export function norm(p: string | null | undefined): string {
  return (p ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** 卡片是否属于当前所在的 worktree：都有仓库目录时比较目录，否则比较 space。 */
export function sameWorktree(card: Pick<Card, "repo_root" | "space_id" | "cwd">, ctx: Pick<Ctx, "repo_root" | "space_id" | "cwd">): boolean {
  const a = card.repo_root ?? null;
  const b = ctx.repo_root ?? null;
  if (a && b) return norm(a) === norm(b);
  if (card.space_id && ctx.space_id) return card.space_id === ctx.space_id;
  return norm(card.cwd) === norm(ctx.cwd);
}

/** 写进流水的操作人。 */
export function actor(ctx: Ctx): string {
  if (ctx.isAgent) return ctx.terminal ? `${ctx.agentName} · ${ctx.terminal}` : `${ctx.agentName}`;
  if (ctx.identityUnknown) return `身份未确认 · ${ctx.terminal}`;
  return ctx.terminal ? `用户 · ${ctx.terminal}` : "用户";
}
