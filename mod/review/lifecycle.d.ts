// lifecycle.js 的类型声明，供 cli/src/model.ts 类型检查。运行时用的是同名 .js 文件。

import type { Card, Item } from "../../cli/src/model.ts";

export type CardStage = "hidden" | "pending" | "decided" | "fixed" | "deferred" | "archived";
export type VerifyState = "none" | "pending" | "verifying" | "passed" | "failed";

export declare function cardStage(card: Card): CardStage;
export declare function verifyState(card: Card): VerifyState;
export declare const VERIFY_LABEL: Record<VerifyState, string>;
export declare function waitingFix(it: Item): boolean;
export declare function verifyPending(card: Card): Item[];
