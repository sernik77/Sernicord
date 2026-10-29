/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** One path segment that is safe on Windows and in a zip. */
export function sanitizeSegment(raw: string, max = 80): string {
    let text = String(raw ?? "").normalize("NFKC");
    text = text.replace(/[\u0000-\u001f\u007f]/g, "");
    text = text.replace(/[\\/:*?"<>|]/g, "_");
    text = text.replace(/\s+/g, " ").trim();
    text = text.replace(/^\.+/, "");
    text = text.replace(/[. ]+$/g, "");
    if (!text || text === "." || text === "..") return "untitled";
    if (text.length > max) text = text.slice(0, max).replace(/[. ]+$/g, "");
    if (!text) return "untitled";
    if (RESERVED.test(text)) text = `_${text}`;
    return text;
}

/** File name with its extension kept, capped, and never a Windows device name. */
export function sanitizeFileName(raw: string, fallback = "file"): string {
    let text = String(raw ?? "").normalize("NFKC");
    text = text.replace(/[\u0000-\u001f\u007f]/g, "");
    text = text.replace(/[\\/:*?"<>|]/g, "_");
    text = text.replace(/\s+/g, " ").trim();
    text = text.replace(/^\.+/, "");
    text = text.replace(/[. ]+$/g, "");

    const dot = text.lastIndexOf(".");
    const hasExt = dot > 0;
    const stem = hasExt ? text.slice(0, dot) : text;
    const ext = hasExt ? text.slice(dot + 1).replace(/[^A-Za-z0-9]/g, "").slice(0, 10).toLowerCase() : "";
    const base = sanitizeSegment(stem || fallback, 80);
    return ext ? `${base}.${ext}` : base;
}

/**
 * Hands out zip paths. Comparison is case-insensitive so Photo.png and photo.png
 * both survive on Windows. A repeat becomes name-2.ext, then name-3.ext.
 */
export class PathAllocator {
    private readonly used = new Set<string>();

    claim(path: string): string {
        const parts = String(path)
            .split(/[\\/]+/)
            .filter(part => part && part !== "." && part !== "..");
        if (!parts.length) parts.push("untitled");

        const file = parts[parts.length - 1]!;
        const dir = parts.slice(0, -1);
        const dot = file.lastIndexOf(".");
        const stem = dot > 0 ? file.slice(0, dot) : file;
        const ext = dot > 0 ? file.slice(dot) : "";

        let candidate = [...dir, file].join("/");
        let n = 2;
        while (this.used.has(candidate.toLowerCase())) {
            candidate = [...dir, `${stem}-${n}${ext}`].join("/");
            n++;
        }
        this.used.add(candidate.toLowerCase());
        return candidate;
    }
}
