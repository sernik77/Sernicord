/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PluginNative } from "@utils/types";

import { abortError, isAbort } from "./progress";
import { isHttpsUrl } from "./urls";

type Native = PluginNative<typeof import("./native")>;

function nativeApi(): Native | null {
    const api = VencordNative.pluginHelpers.LocalArchive as Native | undefined;
    if (!api?.fetchUrl) return null;
    return api;
}

/** null means the file is over the size limit and was not read. */
export async function readUrl(url: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array | null> {
    if (signal.aborted) throw abortError();
    if (!isHttpsUrl(url)) throw new Error("Only https files are saved");

    try {
        const response = await fetch(url, { signal, credentials: "omit" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const length = Number(response.headers.get("content-length") || 0);
        if (maxBytes > 0 && length > maxBytes) return null;
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (signal.aborted) throw abortError();
        if (maxBytes > 0 && bytes.byteLength > maxBytes) return null;
        return bytes;
    } catch (error) {
        if (isAbort(error) || signal.aborted) throw abortError();
        if (!(error instanceof TypeError)) throw error;
        const native = nativeApi();
        if (!native) throw error;
        const result = await native.fetchUrl(url, maxBytes);
        if (signal.aborted) throw abortError();
        if (!result.ok) {
            if (result.status === 413) return null;
            throw new Error(result.message);
        }
        if (maxBytes > 0 && result.bytes.byteLength > maxBytes) return null;
        return result.bytes;
    }
}
