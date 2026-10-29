/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { randomBytes } from "crypto";
import { BrowserWindow, dialog, IpcMainInvokeEvent } from "electron";
import { createReadStream, createWriteStream, promises as fs, WriteStream } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pipeline } from "stream/promises";

const ROOT = join(tmpdir(), "vencord-local-archive");
const ID_PATTERN = /^[a-f0-9]{32}$/;

interface ArchiveJob {
    path: string;
    stream: WriteStream;
    ended: Promise<void>;
    failed: Error | null;
}

const jobs = new Map<string, ArchiveJob>();

export interface NativeBytes {
    ok: true;
    bytes: Uint8Array;
}

export interface NativeFailure {
    ok: false;
    status: number;
    message: string;
}

function jobPath(id: string): string {
    return join(ROOT, `${id}.zip`);
}

function takeJob(id: string): ArchiveJob {
    if (!ID_PATTERN.test(id)) throw new Error("Unknown archive");
    const job = jobs.get(id);
    if (!job || job.path !== jobPath(id)) throw new Error("Unknown archive");
    return job;
}

function toBuffer(chunk: Uint8Array): Buffer {
    if (Buffer.isBuffer(chunk)) return chunk;
    if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    throw new Error("Archive chunk must be bytes");
}

export async function begin(_event: IpcMainInvokeEvent): Promise<string> {
    await fs.mkdir(ROOT, { recursive: true });
    const id = randomBytes(16).toString("hex");
    const path = jobPath(id);
    const stream = createWriteStream(path, { flags: "wx" });
    let rejectEnded: (error: Error) => void = () => { };
    const ended = new Promise<void>((resolve, reject) => {
        rejectEnded = reject;
        stream.once("finish", () => resolve());
        stream.once("error", error => reject(error));
    });
    const job: ArchiveJob = { path, stream, ended, failed: null };
    stream.on("error", error => {
        job.failed = error;
        rejectEnded(error);
    });
    jobs.set(id, job);
    return id;
}

export async function append(_event: IpcMainInvokeEvent, id: string, chunk: Uint8Array): Promise<void> {
    const job = takeJob(id);
    if (job.failed) throw job.failed;
    const data = toBuffer(chunk);
    if (!job.stream.write(data)) {
        await new Promise<void>((resolve, reject) => {
            job.stream.once("drain", () => resolve());
            job.stream.once("error", reject);
        });
    }
}

export async function finish(event: IpcMainInvokeEvent, id: string, downloadName: string): Promise<{ saved: boolean; path?: string; }> {
    const job = takeJob(id);
    jobs.delete(id);
    job.stream.end();

    try {
        await job.ended;
        const safeName = String(downloadName || "archive.zip")
            .replace(/[\u0000-\u001f\\/:*?"<>|]/g, "_")
            .replace(/^\.+/, "")
            .slice(0, 120) || "archive.zip";
        const defaultPath = safeName.toLowerCase().endsWith(".zip") ? safeName : `${safeName}.zip`;
        const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined;
        const options = {
            defaultPath,
            filters: [{ name: "Zip archive", extensions: ["zip"] }]
        };
        const result = parent
            ? await dialog.showSaveDialog(parent, options)
            : await dialog.showSaveDialog(options);

        if (result.canceled || !result.filePath) return { saved: false };

        try {
            await fs.copyFile(job.path, result.filePath);
        } catch {
            await pipeline(createReadStream(job.path), createWriteStream(result.filePath));
        }
        return { saved: true, path: result.filePath };
    } finally {
        await fs.unlink(job.path).catch(() => { });
    }
}

export async function discard(_event: IpcMainInvokeEvent, id: string): Promise<void> {
    if (!ID_PATTERN.test(id)) return;
    const job = jobs.get(id);
    if (!job) {
        await fs.unlink(jobPath(id)).catch(() => { });
        return;
    }
    jobs.delete(id);
    job.stream.destroy();
    await fs.unlink(job.path).catch(() => { });
}

export async function fetchUrl(_event: IpcMainInvokeEvent, url: string, maxBytes: number): Promise<NativeBytes | NativeFailure> {
    let current: URL;
    try {
        current = new URL(url);
    } catch {
        return { ok: false, status: 0, message: "Invalid URL" };
    }
    if (current.protocol !== "https:") return { ok: false, status: 0, message: "Only https URLs can be saved" };

    for (let redirect = 0; redirect < 4; redirect++) {
        const response = await fetch(current, { redirect: "manual" });
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get("location");
            if (!location) return { ok: false, status: response.status, message: "Redirect had no location" };
            const next = new URL(location, current);
            if (next.protocol !== "https:") return { ok: false, status: 0, message: "Redirect left https" };
            current = next;
            continue;
        }
        if (!response.ok) {
            return { ok: false, status: response.status, message: response.statusText || "Download failed" };
        }
        const length = Number(response.headers.get("content-length") || 0);
        if (maxBytes > 0 && length > maxBytes) {
            return { ok: false, status: 413, message: "File is larger than the size limit" };
        }
        if (!response.body) {
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (maxBytes > 0 && bytes.byteLength > maxBytes) {
                return { ok: false, status: 413, message: "File is larger than the size limit" };
            }
            return { ok: true, bytes };
        }
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (true) {
            const step = await reader.read();
            if (step.done) break;
            total += step.value.byteLength;
            if (maxBytes > 0 && total > maxBytes) {
                await reader.cancel().catch(() => { });
                return { ok: false, status: 413, message: "File is larger than the size limit" };
            }
            chunks.push(step.value);
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return { ok: true, bytes };
    }
    return { ok: false, status: 0, message: "Too many redirects" };
}
