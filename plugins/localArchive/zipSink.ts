/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PluginNative } from "@utils/types";
import { saveFile } from "@utils/web";
import { strToU8, Zip, ZipDeflate, ZipPassThrough } from "fflate";

import { PathAllocator } from "./names";

type Native = PluginNative<typeof import("./native")>;

export interface SaveResult {
    saved: boolean;
    path?: string;
    native: boolean;
}

function nativeApi(): Native | null {
    const api = VencordNative.pluginHelpers.LocalArchive as Native | undefined;
    if (!api?.begin || !api.append || !api.finish || !api.discard) return null;
    return api;
}

const CHUNK = 1024 * 1024;

/**
 * fflate finishes a sync ZipDeflate/ZipPassThrough entry before push() returns,
 * but only when the previous entry is already complete. Every file is queued
 * and flushed before the next one starts.
 */
export class ZipSink {
    readonly paths = new PathAllocator();
    private readonly zip: Zip;
    private readonly pending: Uint8Array[] = [];
    private readonly memory: Uint8Array[] = [];
    private chain: Promise<void> = Promise.resolve();
    private native: Native | null = null;
    private archiveId = "";
    private broken = false;
    private zipError: Error | null = null;
    private outputBytes = 0;
    private fileCount = 0;

    constructor(private readonly onProgress: (bytes: number, files: number) => void) {
        this.zip = new Zip((error, data) => {
            if (error) {
                this.zipError = error instanceof Error ? error : new Error(String(error));
                return;
            }
            if (data?.length) this.pending.push(data);
        });
    }

    get usingNative(): boolean {
        return !!this.archiveId;
    }

    async open(): Promise<void> {
        this.native = nativeApi();
        if (!this.native) return;
        try {
            this.archiveId = await this.native.begin();
        } catch {
            this.native = null;
            this.archiveId = "";
        }
    }

    addText(path: string, text: string): Promise<string> {
        return this.addBytes(path, strToU8(text), true);
    }

    addStored(path: string, bytes: Uint8Array): Promise<string> {
        return this.addBytes(path, bytes, false);
    }

    async finish(downloadName: string): Promise<SaveResult> {
        await this.queue(async () => {
            if (this.broken) throw this.zipError ?? new Error("Archive is incomplete");
            this.zip.end();
            if (this.zipError) {
                this.broken = true;
                throw this.zipError;
            }
            await this.flush();
        });

        if (this.archiveId && this.native) {
            const id = this.archiveId;
            this.archiveId = "";
            const saved = await this.native.finish(id, downloadName);
            return { saved: saved.saved, path: saved.path, native: true };
        }

        const parts = this.memory.splice(0);
        saveFile(new File([new Blob(parts as BlobPart[])], downloadName, { type: "application/zip" }));
        return { saved: true, native: false };
    }

    async discard(): Promise<void> {
        this.broken = true;
        try {
            this.zip.terminate();
        } catch {
            // The archive is already being thrown away.
        }
        const id = this.archiveId;
        this.archiveId = "";
        this.memory.length = 0;
        if (id && this.native) await this.native.discard(id).catch(() => { });
    }

    private addBytes(path: string, bytes: Uint8Array, compress: boolean): Promise<string> {
        const claimed = this.paths.claim(path);
        return this.queue(async () => {
            if (this.broken) throw this.zipError ?? new Error("Archive is incomplete");
            const entry = compress ? new ZipDeflate(claimed, { level: 1 }) : new ZipPassThrough(claimed);
            this.zip.add(entry);
            entry.push(bytes, true);
            if (this.zipError) {
                this.broken = true;
                throw this.zipError;
            }
            this.fileCount++;
            await this.flush();
            this.onProgress(this.outputBytes, this.fileCount);
            return claimed;
        });
    }

    private queue<T>(work: () => Promise<T> | T): Promise<T> {
        const run = this.chain.then(work);
        this.chain = run.then(() => undefined, () => undefined);
        return run;
    }

    private async flush(): Promise<void> {
        const parts = this.pending.splice(0);
        for (const part of parts) {
            this.outputBytes += part.byteLength;
            if (this.archiveId && this.native) {
                for (let offset = 0; offset < part.byteLength; offset += CHUNK) {
                    await this.native.append(this.archiveId, part.subarray(offset, offset + CHUNK));
                }
            } else {
                this.memory.push(part);
            }
        }
    }
}
