/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const DISCORD_HOSTS = new Set([
    "cdn.discordapp.com",
    "media.discordapp.net",
    "images-ext-1.discordapp.net",
    "images-ext-2.discordapp.net"
]);

export function isHttpsUrl(value: string): boolean {
    try {
        return new URL(value).protocol === "https:";
    } catch {
        return false;
    }
}

export function isDiscordHost(value: string): boolean {
    try {
        return DISCORD_HOSTS.has(new URL(value).hostname.toLowerCase());
    } catch {
        return false;
    }
}

/** Same file ignoring size and format query flags. */
export function mediaKey(value: string): string {
    const url = new URL(value);
    return `${url.hostname.toLowerCase()}${decodeURIComponent(url.pathname)}`;
}

export function extensionFromUrl(value: string): string {
    try {
        const last = decodeURIComponent(new URL(value).pathname.split("/").pop() ?? "");
        const dot = last.lastIndexOf(".");
        if (dot <= 0) return "";
        return last.slice(dot + 1).replace(/[^A-Za-z0-9]/g, "").slice(0, 10).toLowerCase();
    } catch {
        return "";
    }
}

export function hashExtension(hash: string): "gif" | "png" {
    return hash.startsWith("a_") ? "gif" : "png";
}

export function stickerFile(id: string, format: number): { url: string; ext: string; } {
    const ext = format === 3 ? "json" : format === 2 || format === 4 ? "gif" : "png";
    return { url: `https://cdn.discordapp.com/stickers/${id}.${ext}`, ext };
}

export function parseDay(value: string, end: boolean): number | null {
    const text = value.trim();
    if (!text) return null;
    const iso = text.includes("T") ? text : `${text}${end ? "T23:59:59.999Z" : "T00:00:00.000Z"}`;
    const time = Date.parse(iso);
    return Number.isNaN(time) ? null : time;
}

export function compareIds(a: string, b: string): number {
    if (a.length !== b.length) return a.length - b.length;
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
}

export function bigintReplacer(_key: string, value: unknown): unknown {
    return typeof value === "bigint" ? value.toString() : value;
}

export function pretty(value: unknown): string {
    return JSON.stringify(value, bigintReplacer, 2) + "\n";
}
