// 数据和安装位置。数据放在 herdr-app 主目录下的 review/（设置了 HERDR_APP_HOME 时跟随它）。
// HERDR_REVIEW_HOME 只用于测试，把数据放到临时目录。

import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function appHome(): string {
  return process.env.HERDR_APP_HOME || join(homedir(), ".config", "herdr-app");
}

export function reviewHome(): string {
  return process.env.HERDR_REVIEW_HOME || join(appHome(), "review");
}

export function cardsDir(): string {
  return join(reviewHome(), "cards");
}

/** 用户删除的卡片放在这里，可以恢复。 */
export function trashDir(): string {
  return join(reviewHome(), "trash");
}

export const cliFile = fileURLToPath(new URL("./cli.ts", import.meta.url));
export const repoRoot = resolve(dirname(cliFile), "..", "..");
