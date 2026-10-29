/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface ProgressSnapshot {
    phase: string;
    detail: string;
    messages: number;
    files: number;
    bytes: number;
    skippedFiles: number;
    channelsDone: number;
    channelsTotal: number;
    errors: string[];
    errorCount: number;
    finished: boolean;
    cancelled: boolean;
    saved: boolean | null;
    savedPath: string;
    native: boolean;
}

const listeners = new Set<(snapshot: ProgressSnapshot) => void>();

let abortController: AbortController | null = null;
let running = false;
let timer: number | null = null;
let state: ProgressSnapshot = emptyProgress();

function emptyProgress(): ProgressSnapshot {
    return {
        phase: "Starting",
        detail: "",
        messages: 0,
        files: 0,
        bytes: 0,
        skippedFiles: 0,
        channelsDone: 0,
        channelsTotal: 0,
        errors: [],
        errorCount: 0,
        finished: false,
        cancelled: false,
        saved: null,
        savedPath: "",
        native: false
    };
}

export function getProgress(): ProgressSnapshot {
    return state;
}

export function subscribe(listener: (snapshot: ProgressSnapshot) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function isRunning(): boolean {
    return running;
}

export function getSignal(): AbortSignal {
    return abortController?.signal ?? new AbortController().signal;
}

export function beginRun(native: boolean): boolean {
    if (running) return false;
    running = true;
    abortController = new AbortController();
    state = { ...emptyProgress(), native, phase: "Starting" };
    publish(true);
    return true;
}

export function requestCancel(): void {
    abortController?.abort();
    patch({ cancelled: true, phase: "Cancelling. The partial archive will still be saved." }, true);
}

export function endRun(): void {
    running = false;
    abortController = null;
}

export function patch(partial: Partial<ProgressSnapshot>, immediate = false): void {
    const phaseChanged = partial.phase != null && partial.phase !== state.phase;
    state = { ...state, ...partial };
    if (immediate || phaseChanged) {
        publish(true);
        return;
    }
    if (timer != null) return;
    timer = window.setTimeout(() => publish(false), 80);
}

function publish(clearTimer: boolean): void {
    if (clearTimer && timer != null) {
        window.clearTimeout(timer);
        timer = null;
    }
    if (!clearTimer) timer = null;
    const snapshot = state;
    for (const listener of listeners) listener(snapshot);
}

export function isAbort(error: unknown): boolean {
    return typeof error === "object" && error !== null && (error as { name?: string; }).name === "AbortError";
}

export function abortError(): DOMException {
    return new DOMException("Aborted", "AbortError");
}
