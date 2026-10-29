/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Constants, RestAPI } from "@webpack/common";

import { abortError, isAbort } from "./progress";

export type ApiResult = { ok: true; body: any; } | { ok: false; status: number; message: string; };

export interface MessageQuery {
    signal: AbortSignal;
    pageDelayMs: number;
    maxMessages: number;
    dateFromMs: number | null;
    dateToMs: number | null;
    onPage: (count: number) => void;
    onWait: (seconds: number) => void;
}

function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw abortError();
}

export async function pause(ms: number, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (ms <= 0) return;
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(abortError());
        };
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

function statusOf(error: any): number {
    const status = Number(error?.status ?? error?.statusCode ?? 0);
    return Number.isFinite(status) ? status : 0;
}

function messageOf(error: any): string {
    if (typeof error?.body?.message === "string") return error.body.message;
    if (typeof error?.message === "string" && error.message) return error.message;
    return "Request failed";
}

function retryAfter(error: any): number {
    const seconds = Number(error?.body?.retry_after ?? error?.retry_after ?? 1);
    if (!Number.isFinite(seconds) || seconds < 0) return 1;
    return Math.min(seconds, 120);
}

export function messageTime(message: any): number {
    const stamp = message?.timestamp ?? message?.timestamp_;
    if (stamp instanceof Date) return stamp.getTime();
    if (typeof stamp === "string" || typeof stamp === "number") {
        const parsed = new Date(stamp).getTime();
        if (!Number.isNaN(parsed)) return parsed;
    }
    try {
        return Number((BigInt(message.id) >> 22n) + 1420070400000n);
    } catch {
        return 0;
    }
}

export async function apiGet(
    url: string,
    query: Record<string, string | number | boolean> | undefined,
    signal: AbortSignal,
    onWait?: (seconds: number) => void
): Promise<ApiResult> {
    let serverTries = 0;
    while (true) {
        throwIfAborted(signal);
        try {
            const response = await RestAPI.get({ url, query, retries: 0 });
            return { ok: true, body: response?.body ?? response };
        } catch (error: any) {
            if (isAbort(error) || signal.aborted) throw abortError();
            const status = statusOf(error);
            if (status === 429) {
                const seconds = retryAfter(error);
                onWait?.(seconds);
                await pause(seconds * 1000 + 150, signal);
                continue;
            }
            if ((status === 0 || status === 502 || status === 503 || status === 504) && serverTries < 3) {
                serverTries++;
                await pause(400 * serverTries, signal);
                continue;
            }
            return { ok: false, status, message: messageOf(error) };
        }
    }
}

export async function fetchMessages(channelId: string, options: MessageQuery): Promise<{ messages: any[]; note?: string; status?: number; }> {
    const collected: any[] = [];
    let before: string | undefined;
    let passedStart = false;

    while (!options.signal.aborted) {
        if (options.maxMessages > 0 && collected.length >= options.maxMessages) break;
        if (options.pageDelayMs > 0) await pause(options.pageDelayMs, options.signal);

        const query: Record<string, string | number> = { limit: 100 };
        if (before) query.before = before;
        const response = await apiGet(Constants.Endpoints.MESSAGES(channelId), query, options.signal, options.onWait);
        if (!response.ok) {
            return { messages: collected.reverse(), note: response.message, status: response.status };
        }

        const page = Array.isArray(response.body) ? response.body : null;
        if (!page) return { messages: collected.reverse(), note: "Message history had an unexpected shape", status: 0 };
        if (!page.length) break;

        for (const message of page) {
            const time = messageTime(message);
            if (options.dateToMs != null && time > options.dateToMs) continue;
            if (options.dateFromMs != null && time < options.dateFromMs) {
                passedStart = true;
                break;
            }
            collected.push(message);
            if (options.maxMessages > 0 && collected.length >= options.maxMessages) break;
        }
        options.onPage(collected.length);
        if (passedStart) break;
        if (options.maxMessages > 0 && collected.length >= options.maxMessages) break;

        const oldestId = String(page[page.length - 1]?.id ?? "");
        if (!oldestId || oldestId === before) break;
        before = oldestId;
        if (page.length < 100) break;
    }

    collected.reverse();
    return { messages: collected };
}

export async function fetchOneMessage(channelId: string, messageId: string, signal: AbortSignal, onWait: (seconds: number) => void): Promise<any | null> {
    const response = await apiGet(
        Constants.Endpoints.MESSAGES(channelId),
        { limit: 1, around: messageId },
        signal,
        onWait
    );
    if (!response.ok) return null;
    const page = Array.isArray(response.body) ? response.body : [];
    return page.find(message => String(message?.id) === messageId) ?? null;
}
