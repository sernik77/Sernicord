/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { ChannelType } from "@vencord/discord-types/enums";
import { ChannelStore, EmojiStore, GuildChannelStore, GuildRoleStore, GuildStore, StickersStore, UserStore } from "@webpack/common";

import { apiGet, fetchMessages, fetchOneMessage, messageTime, pause } from "./api";
import { readUrl } from "./media";
import { sanitizeSegment } from "./names";
import { abortError, beginRun, endRun, getProgress, getSignal, isAbort, patch } from "./progress";
import { collectMedia, type MediaRef,renderTranscript, snapshotMessage, toJsonl } from "./snapshot";
import { compareIds, hashExtension, pretty, stickerFile } from "./urls";
import { ZipSink } from "./zipSink";

const logger = new Logger("LocalArchive");

const MESSAGE_TYPES = new Set<number>([
    ChannelType.GUILD_TEXT,
    ChannelType.DM,
    ChannelType.GUILD_VOICE,
    ChannelType.GROUP_DM,
    ChannelType.GUILD_ANNOUNCEMENT,
    ChannelType.ANNOUNCEMENT_THREAD,
    ChannelType.PUBLIC_THREAD,
    ChannelType.PRIVATE_THREAD,
    ChannelType.GUILD_STAGE_VOICE
]);

const THREAD_PARENTS = new Set<number>([
    ChannelType.GUILD_TEXT,
    ChannelType.GUILD_ANNOUNCEMENT,
    ChannelType.GUILD_FORUM,
    ChannelType.GUILD_MEDIA,
    ChannelType.GUILD_VOICE,
    ChannelType.GUILD_STAGE_VOICE
]);

export interface ExportSettings {
    writeJson: boolean;
    writeMarkdown: boolean;
    writePlain: boolean;
    includeAttachments: boolean;
    includeEmbedMedia: boolean;
    includeExternalEmbeds: boolean;
    includeStickers: boolean;
    includeAvatars: boolean;
    includeGuildAssets: boolean;
    includeThreads: boolean;
    includeReactions: boolean;
    includeEmptyChannels: boolean;
    dedupeMedia: boolean;
    pageDelayMs: number;
    mediaConcurrency: number;
    maxMessagesPerChannel: number;
    dateFrom: string;
    dateTo: string;
    dateFromMs: number | null;
    dateToMs: number | null;
    maxFileBytes: number;
}

export type ExportTarget =
    | { kind: "message"; channelId: string; messageId: string; message?: unknown; channel?: unknown; }
    | { kind: "channel"; channelId: string; channel?: unknown; }
    | { kind: "guild"; guildId: string; }
    | { kind: "category"; guildId: string; categoryId: string; }
    | { kind: "user-search"; userId: string; guildId: string; channelId?: string; label: string; };

interface ArchiveChannel {
    id: string;
    name: string;
    type: number;
    topic: string;
    parentId: string;
    nsfw: boolean;
    position: number;
    rateLimitPerUser: number;
    recipients: { id: string; username: string; globalName: string; }[];
}

interface ChannelReport {
    id: string;
    name: string;
    messages: number;
    error?: string;
    note?: string;
}

interface SaveHit {
    path?: string;
    skip?: string;
}

class StopExport extends Error { }

function errorText(error: unknown): string {
    if (error instanceof Error && error.message) return error.message;
    return "Unexpected export error";
}

function safeUrl(url: string): string {
    try {
        const parsed = new URL(url);
        return `${parsed.hostname}${parsed.pathname}`;
    } catch {
        return "file";
    }
}

function isThreadType(type: number): boolean {
    return type === ChannelType.ANNOUNCEMENT_THREAD
        || type === ChannelType.PUBLIC_THREAD
        || type === ChannelType.PRIVATE_THREAD;
}

function isVocal(type: number): boolean {
    return type === ChannelType.GUILD_VOICE || type === ChannelType.GUILD_STAGE_VOICE;
}

function byPosition(a: ArchiveChannel, b: ArchiveChannel): number {
    return a.position - b.position || compareIds(a.id, b.id);
}

function indexed(index: number, label: string, id: string): string {
    return `${String(index).padStart(3, "0")}__${sanitizeSegment(label)}__${id}`;
}

function rootFolder(kind: string, label: string, id: string): string {
    return `${kind}__${sanitizeSegment(label, 40)}__${id}`;
}

function snowflake(ms: number): string {
    if (ms <= 1420070400000) return "0";
    return ((BigInt(Math.floor(ms)) - 1420070400000n) << 22n).toString();
}

function readRecipients(input: any): ArchiveChannel["recipients"] {
    const raw = input?.rawRecipients;
    if (Array.isArray(raw)) {
        return raw.map((person: any) => ({
            id: String(person?.id ?? ""),
            username: String(person?.username ?? ""),
            globalName: String(person?.global_name ?? person?.globalName ?? "")
        })).filter((person: { id: string; }) => person.id);
    }
    if (Array.isArray(input?.recipients) && input.recipients.every((id: unknown) => typeof id === "string")) {
        return input.recipients.map((id: string) => {
            const user = UserStore.getUser(id);
            return {
                id,
                username: user?.username ?? "",
                globalName: user?.globalName ?? ""
            };
        });
    }
    return [];
}

function describe(input: any): ArchiveChannel | null {
    if (!input || typeof input !== "object" || !input.id) return null;
    let topic = "";
    let position = 0;
    let rate = 0;
    let nsfw = false;
    try {
        const value = input.topic ?? input.topic_;
        if (typeof value === "string") topic = value;
    } catch { /* getter can throw on a partial record */ }
    try {
        position = Number(input.position ?? input.position_ ?? 0) || 0;
    } catch { /* same as topic */ }
    try {
        rate = Number(input.rateLimitPerUser ?? input.rate_limit_per_user ?? input.rateLimitPerUser_ ?? 0) || 0;
    } catch { /* same as topic */ }
    try {
        nsfw = Boolean(input.nsfw ?? input.nsfw_);
    } catch { /* same as topic */ }
    return {
        id: String(input.id),
        name: String(input.name || "unknown"),
        type: Number(input.type ?? 0) || 0,
        topic,
        parentId: String(input.parent_id ?? input.parentId ?? ""),
        nsfw,
        position,
        rateLimitPerUser: rate,
        recipients: readRecipients(input)
    };
}

function resolveChannel(channelId: string, hint?: unknown): ArchiveChannel {
    try {
        const stored = describe(ChannelStore.getChannel(channelId));
        if (stored) return stored;
    } catch { /* the id may only exist on the hint */ }
    return describe(hint) ?? {
        id: channelId,
        name: channelId,
        type: ChannelType.GUILD_TEXT,
        topic: "",
        parentId: "",
        nsfw: false,
        position: 0,
        rateLimitPerUser: 0,
        recipients: []
    };
}

function channelTitle(channel: ArchiveChannel): string {
    if (channel.type === ChannelType.DM) {
        const person = channel.recipients[0];
        return person?.globalName || person?.username || "dm";
    }
    if (channel.type === ChannelType.GROUP_DM) return channel.name || "group";
    return channel.name || "channel";
}

function archiveKind(channel: ArchiveChannel): string {
    if (isThreadType(channel.type)) return "thread";
    if (channel.type === ChannelType.DM) return "dm";
    if (channel.type === ChannelType.GROUP_DM) return "group";
    if (channel.type === ChannelType.GUILD_CATEGORY) return "category";
    return "channel";
}

function listGuildChannels(guildId: string): ArchiveChannel[] {
    const seen = new Set<string>();
    const channels: ArchiveChannel[] = [];
    const push = (raw: unknown) => {
        const channel = describe(raw);
        if (!channel || seen.has(channel.id)) return;
        seen.add(channel.id);
        channels.push(channel);
    };
    try {
        const record = ChannelStore.getMutableGuildChannelsForGuild(guildId) ?? {};
        for (const channel of Object.values(record)) push(channel);
    } catch { /* store not ready */ }
    if (!channels.length) {
        try {
            const grouped = GuildChannelStore.getChannels(guildId);
            const rows = [
                ...(grouped?.[ChannelType.GUILD_CATEGORY] ?? []),
                ...(grouped?.SELECTABLE ?? []),
                ...(grouped?.VOCAL ?? [])
            ];
            for (const row of rows) push((row as { channel?: unknown; })?.channel ?? row);
        } catch { /* guild channel list unavailable */ }
    }
    try {
        for (const thread of ChannelStore.getAllThreadsForGuild(guildId) ?? []) push(thread);
    } catch { /* threads are also loaded from the API */ }
    return channels;
}

export async function runExport(target: ExportTarget, options: ExportSettings): Promise<void> {
    const nativeReady = !!VencordNative.pluginHelpers.LocalArchive?.begin;
    if (!beginRun(nativeReady)) return;

    const signal = getSignal();
    const zip = new ZipSink((bytes, files) => patch({ bytes, files }));
    const errors: string[] = [];
    const reports: ChannelReport[] = [];
    const notes: string[] = [];
    const dedupe = new Map<string, Promise<SaveHit>>();
    const exported = new Set<string>();
    const threadsByParent = new Map<string, ArchiveChannel[]>();
    let errorCount = 0;
    let skipped = 0;
    let messageCount = 0;
    let done = 0;
    let total = 0;
    let root = "archive";
    let opened = false;
    let cancelled = false;

    const pushError = (text: string) => {
        errorCount++;
        if (errors.length < 200) errors.push(text);
        patch({ errors: errors.slice(-20), errorCount });
        logger.error(text);
    };
    const onWait = (seconds: number) => {
        patch({ phase: `Rate limited. Waiting ${Math.ceil(seconds)}s.` }, true);
    };
    const rememberThread = (thread: ArchiveChannel) => {
        if (!thread.parentId) return;
        const list = threadsByParent.get(thread.parentId) ?? [];
        if (list.some(item => item.id === thread.id)) return;
        list.push(thread);
        threadsByParent.set(thread.parentId, list);
    };

    async function pool<T>(items: T[], worker: (item: T) => Promise<void>): Promise<void> {
        if (!items.length) return;
        let cursor = 0;
        const width = Math.min(Math.max(1, options.mediaConcurrency), items.length);
        await Promise.all(Array.from({ length: width }, async () => {
            while (cursor < items.length) {
                if (signal.aborted) throw abortError();
                const item = items[cursor++]!;
                await worker(item);
            }
        }));
    }

    async function saveRemote(url: string, zipPath: string, key: string): Promise<SaveHit> {
        if (options.dedupeMedia) {
            const existing = dedupe.get(key);
            if (existing) return existing;
        }
        const task = (async (): Promise<SaveHit> => {
            try {
                const bytes = await readUrl(url, options.maxFileBytes, signal);
                if (signal.aborted) throw abortError();
                if (!bytes) {
                    skipped++;
                    patch({ skippedFiles: skipped });
                    return { skip: "larger than the size limit" };
                }
                const path = await zip.addStored(zipPath, bytes);
                return { path };
            } catch (error) {
                if (isAbort(error) || signal.aborted) throw abortError();
                pushError(`${safeUrl(url)}: ${errorText(error)}`);
                return { skip: "download failed" };
            }
        })();
        if (options.dedupeMedia) {
            dedupe.set(key, task);
            task.catch(() => {
                if (dedupe.get(key) === task) dedupe.delete(key);
            });
        }
        return task;
    }

    async function saveRefs(refs: MediaRef[], label: string): Promise<void> {
        await pool(refs, async ref => {
            const key = options.dedupeMedia ? ref.dedupeKey : `${ref.dedupeKey}:${ref.filename}:${label}`;
            const saved = await saveRemote(ref.url, `${ref.directory}/${ref.filename}`, key);
            if (saved.path) ref.assign(saved.path);
            else ref.skip(saved.skip || "download failed");
        });
    }

    async function writeHistory(channel: ArchiveChannel, dir: string, parentName: string, messages: any[], report: Omit<ChannelReport, "messages">): Promise<void> {
        const snapshots = messages.map(message => snapshotMessage(message));
        const refs: MediaRef[] = [];
        for (const snapshot of snapshots) {
            collectMedia(snapshot, dir, root, {
                includeAttachments: options.includeAttachments,
                includeEmbedMedia: options.includeEmbedMedia,
                includeExternalEmbeds: options.includeExternalEmbeds,
                includeStickers: options.includeStickers,
                includeAvatars: options.includeAvatars,
                includeReactions: options.includeReactions
            }, refs);
        }
        if (signal.aborted) throw abortError();
        await saveRefs(refs, channel.id);
        if (options.writeJson && snapshots.length) {
            await zip.addText(`${dir}/messages.jsonl`, toJsonl(snapshots, options.includeReactions));
        }
        if (options.writeMarkdown && snapshots.length) {
            await zip.addText(`${dir}/transcript.md`, renderTranscript(channel.name, channel.id, snapshots, dir, true, options.includeReactions));
        }
        if (options.writePlain && snapshots.length) {
            await zip.addText(`${dir}/transcript.txt`, renderTranscript(channel.name, channel.id, snapshots, dir, false, options.includeReactions));
        }
        const record: Record<string, unknown> = {
            id: channel.id,
            name: channel.name,
            type: channel.type,
            topic: channel.topic,
            parentId: channel.parentId,
            parentName,
            nsfw: channel.nsfw,
            position: channel.position,
            rateLimitPerUser: channel.rateLimitPerUser
        };
        if (channel.recipients.length) record.recipients = channel.recipients;
        await zip.addText(`${dir}/channel.json`, pretty(record));
        messageCount += snapshots.length;
        reports.push({ ...report, messages: snapshots.length });
        patch({ messages: messageCount });
    }

    async function loadArchived(parent: ArchiveChannel): Promise<void> {
        for (const kind of ["public", "private"] as const) {
            let before = "";
            for (let page = 0; page < 100; page++) {
                if (signal.aborted) throw abortError();
                if (options.pageDelayMs > 0) await pause(options.pageDelayMs, signal);
                const query: Record<string, string | number> = { limit: 100 };
                if (before) query.before = before;
                const response = await apiGet(`/channels/${parent.id}/threads/archived/${kind}`, query, signal, onWait);
                if (!response.ok) {
                    if (response.status === 401) {
                        pushError("Discord rejected the session (401). Export stopped.");
                        throw new StopExport("401");
                    }
                    if (response.status === 403 || response.status === 404) break;
                    pushError(`${parent.name} archived ${kind} threads: ${response.message}`);
                    break;
                }
                const threads = Array.isArray(response.body?.threads) ? response.body.threads : [];
                for (const raw of threads) {
                    const thread = describe(raw);
                    if (thread) rememberThread(thread);
                }
                if (!response.body?.has_more || !threads.length) break;
                const stamp = String(threads[threads.length - 1]?.thread_metadata?.archive_timestamp ?? "");
                if (!stamp || stamp === before) break;
                before = stamp;
            }
        }
    }

    async function visit(channel: ArchiveChannel, dir: string, parentName: string, preset: any[] | null, fetchThreads: boolean): Promise<void> {
        if (signal.aborted) throw abortError();
        exported.add(channel.id);
        patch({ phase: `Saving ${channel.name}`, detail: `${done + 1}/${Math.max(total, done + 1)}` }, true);

        let messages: any[] = [];
        let note = "";
        let hard = false;
        if (preset) {
            messages = preset;
        } else if (MESSAGE_TYPES.has(channel.type)) {
            const loaded = await fetchMessages(channel.id, {
                signal,
                pageDelayMs: options.pageDelayMs,
                maxMessages: options.maxMessagesPerChannel,
                dateFromMs: options.dateFromMs,
                dateToMs: options.dateToMs,
                onPage: count => patch({ messages: messageCount + count }),
                onWait
            });
            if (loaded.status === 401) {
                pushError("Discord rejected the session (401). Export stopped.");
                throw new StopExport("401");
            }
            messages = loaded.messages;
            if (loaded.status != null) {
                note = isVocal(channel.type) && (loaded.status === 403 || loaded.status === 404)
                    ? "No message history in this voice channel."
                    : (loaded.note || "History is not available.");
                hard = !(isVocal(channel.type) && (loaded.status === 403 || loaded.status === 404));
                if (hard) pushError(`${channel.name} (${channel.id}): ${note}`);
            }
        }

        let threads: ArchiveChannel[] = [];
        if (fetchThreads && options.includeThreads && THREAD_PARENTS.has(channel.type)) {
            await loadArchived(channel);
            threads = (threadsByParent.get(channel.id) ?? []).filter(thread => !exported.has(thread.id));
            total += threads.length;
        }

        const write = messages.length > 0 || threads.length > 0 || options.includeEmptyChannels || hard;
        if (write) {
            await writeHistory(channel, dir, parentName, messages, {
                id: channel.id,
                name: channel.name,
                ...(hard ? { error: note } : note ? { note } : {})
            });
        } else if (note) {
            reports.push({ id: channel.id, name: channel.name, messages: 0, note });
        }
        done++;
        patch({ channelsDone: done, channelsTotal: total });

        let threadIndex = 1;
        for (const thread of threads) {
            const threadDir = `${dir}/threads/${indexed(threadIndex, thread.name, thread.id)}`;
            threadIndex++;
            await visit(thread, threadDir, channel.name, null, false);
        }
    }

    async function exportGuild(guildId: string, categoryId?: string): Promise<void> {
        const guild = GuildStore.getGuild(guildId);
        const described = listGuildChannels(guildId);
        const categories = described.filter(channel => channel.type === ChannelType.GUILD_CATEGORY).sort(byPosition);
        const category = categoryId ? categories.find(item => item.id === categoryId) : undefined;
        if (categoryId && !category) pushError("That category is not in the channel list.");
        root = category
            ? rootFolder("category", category.name, category.id)
            : rootFolder("server", guild?.name || "server", guildId);

        for (const channel of described) if (isThreadType(channel.type)) rememberThread(channel);
        if (options.includeThreads) {
            const active = await apiGet(`/guilds/${guildId}/threads/active`, undefined, signal, onWait);
            if (!active.ok && active.status === 401) {
                pushError("Discord rejected the session (401). Export stopped.");
                throw new StopExport("401");
            }
            if (active.ok) {
                const threads = Array.isArray(active.body?.threads) ? active.body.threads : [];
                for (const raw of threads) {
                    const thread = describe(raw);
                    if (thread) rememberThread(thread);
                }
            } else if (active.status !== 403 && active.status !== 404) {
                pushError(`Active threads: ${active.message}`);
            }
        }

        if (!category) {
            patch({ phase: "Saving server info" }, true);
            await writeGuild(guildId, guild, described);
        }

        const loose: ArchiveChannel[] = [];
        const children = new Map<string, ArchiveChannel[]>();
        for (const channel of described) {
            if (channel.type === ChannelType.GUILD_CATEGORY || isThreadType(channel.type)) continue;
            const parent = categories.find(item => item.id === channel.parentId);
            if (parent) {
                const list = children.get(parent.id) ?? [];
                list.push(channel);
                children.set(parent.id, list);
            } else if (!categoryId) {
                loose.push(channel);
            }
        }
        loose.sort(byPosition);
        for (const list of children.values()) list.sort(byPosition);

        const parents: { channel: ArchiveChannel; dir: string; }[] = [];
        loose.forEach((channel, index) => {
            parents.push({
                channel,
                dir: `${root}/channels/000__no-category/${indexed(index + 1, channel.name, channel.id)}`
            });
        });
        let categoryIndex = 1;
        for (const item of categories) {
            if (categoryId && item.id !== categoryId) continue;
            const catDir = `${root}/channels/${indexed(categoryIndex, item.name, item.id)}`;
            categoryIndex++;
            await zip.addText(`${catDir}/category.json`, pretty({
                id: item.id,
                name: item.name,
                position: item.position
            }));
            (children.get(item.id) ?? []).forEach((channel, index) => {
                parents.push({ channel, dir: `${catDir}/${indexed(index + 1, channel.name, channel.id)}` });
            });
        }

        total = parents.length;
        patch({ channelsTotal: total, channelsDone: 0 });
        for (const parent of parents) await visit(parent.channel, parent.dir, "", null, true);

        if (!categoryId) {
            const orphans = [...threadsByParent.values()].flat().filter(thread => !exported.has(thread.id));
            total += orphans.length;
            patch({ channelsTotal: total });
            let index = 1;
            for (const thread of orphans) {
                await visit(thread, `${root}/_threads/${indexed(index, thread.name, thread.id)}`, "", null, false);
                index++;
            }
        }
    }

    async function writeGuild(guildId: string, guild: ReturnType<typeof GuildStore.getGuild> | undefined, described: ArchiveChannel[]): Promise<void> {
        let roles: { id: string; name: string; color: number; position: number; permissions: bigint; hoist: boolean; mentionable: boolean; managed: boolean; icon?: string; unicodeEmoji?: string; }[] = [];
        try {
            roles = GuildRoleStore.getSortedRoles(guildId) ?? [];
        } catch { /* roles stay empty */ }

        let emojis: { id?: string; name?: string; animated?: boolean; }[] = [];
        const emojiResponse = await apiGet(`/guilds/${guildId}/emojis`, undefined, signal, onWait);
        if (!emojiResponse.ok && emojiResponse.status === 401) {
            pushError("Discord rejected the session (401). Export stopped.");
            throw new StopExport("401");
        }
        if (emojiResponse.ok && Array.isArray(emojiResponse.body)) emojis = emojiResponse.body;
        else {
            try {
                emojis = EmojiStore.getGuildEmoji(guildId) ?? [];
            } catch { /* emoji list stays empty */ }
        }

        let stickers: { id?: string; name?: string; format_type?: number; }[] = [];
        const stickerResponse = await apiGet(`/guilds/${guildId}/stickers`, undefined, signal, onWait);
        if (!stickerResponse.ok && stickerResponse.status === 401) {
            pushError("Discord rejected the session (401). Export stopped.");
            throw new StopExport("401");
        }
        if (stickerResponse.ok && Array.isArray(stickerResponse.body)) stickers = stickerResponse.body;
        else {
            try {
                stickers = (StickersStore.getStickersByGuildId(guildId) ?? []) as typeof stickers;
            } catch { /* sticker list stays empty */ }
        }

        const features = guild?.features instanceof Set ? [...guild.features] : [];
        await zip.addText(`${root}/guild.json`, pretty({
            id: guildId,
            name: guild?.name || guildId,
            description: guild?.description || "",
            ownerId: guild?.ownerId || "",
            preferredLocale: guild?.preferredLocale || "",
            vanityUrl: guild?.vanityURLCode || "",
            verificationLevel: guild?.verificationLevel,
            explicitContentFilter: guild?.explicitContentFilter,
            nsfwLevel: guild?.nsfwLevel,
            premiumTier: guild?.premiumTier,
            features,
            roles: roles.map(role => ({
                id: role.id,
                name: role.name,
                color: role.color,
                position: role.position,
                permissions: String(role.permissions),
                hoist: role.hoist,
                mentionable: role.mentionable,
                managed: role.managed,
                icon: role.icon || "",
                unicodeEmoji: role.unicodeEmoji || ""
            })),
            emoji: emojis.filter(emoji => emoji.id).map(emoji => ({
                id: emoji.id,
                name: emoji.name || "",
                animated: !!emoji.animated
            })),
            stickers: stickers.filter(sticker => sticker.id).map(sticker => ({
                id: sticker.id,
                name: sticker.name || "",
                format: Number(sticker.format_type ?? 1) || 1
            })),
            channels: described.filter(channel => !isThreadType(channel.type)).map(channel => ({
                id: channel.id,
                name: channel.name,
                type: channel.type,
                parentId: channel.parentId,
                position: channel.position
            }))
        }));

        if (!options.includeGuildAssets || !guild) return;
        patch({ phase: "Saving server files" }, true);
        const assets: { url: string; path: string; key: string; }[] = [];
        const addHash = (folder: string, file: string, hash?: string, animated = true) => {
            if (!hash) return;
            const ext = animated ? hashExtension(hash) : "png";
            const url = `https://cdn.discordapp.com/${folder}/${guild.id}/${hash}.${ext}`;
            assets.push({ url, path: `${root}/guild/${file}.${ext}`, key: `guild:${url}` });
        };
        addHash("icons", "icon", guild.icon);
        addHash("banners", "banner", guild.banner);
        addHash("splashes", "splash", guild.splash, false);
        addHash("discovery-splashes", "discovery-splash", guild.discoverySplash, false);
        for (const role of roles) {
            if (!role.icon) continue;
            const url = `https://cdn.discordapp.com/role-icons/${role.id}/${role.icon}.png`;
            assets.push({
                url,
                path: `${root}/guild/roles/${role.id}__${sanitizeSegment(role.name)}.png`,
                key: `role:${role.id}/${role.icon}`
            });
        }
        for (const emoji of emojis) {
            if (!emoji.id) continue;
            const ext = emoji.animated ? "gif" : "png";
            const url = `https://cdn.discordapp.com/emojis/${emoji.id}.${ext}`;
            assets.push({
                url,
                path: `${root}/guild/emoji/${emoji.id}__${sanitizeSegment(emoji.name || "emoji")}.${ext}`,
                key: `emoji:${emoji.id}`
            });
        }
        for (const sticker of stickers) {
            if (!sticker.id) continue;
            const file = stickerFile(sticker.id, Number(sticker.format_type ?? 1) || 1);
            assets.push({
                url: file.url,
                path: `${root}/guild/stickers/${sticker.id}__${sanitizeSegment(sticker.name || "sticker")}.${file.ext}`,
                key: `sticker:${sticker.id}`
            });
        }
        await pool(assets, async asset => {
            await saveRemote(asset.url, asset.path, asset.key);
        });
    }

    async function exportSearch(userId: string, guildId: string, channelId: string | undefined, label: string): Promise<void> {
        root = rootFolder("user", label || "user", userId);
        const hits: any[] = [];
        const seen = new Set<string>();
        let offset = 0;
        let capped = false;
        let totalResults = 0;
        while (offset < 5000) {
            if (signal.aborted) throw abortError();
            if (options.pageDelayMs > 0 && offset > 0) await pause(options.pageDelayMs, signal);
            const query: Record<string, string | number | boolean> = {
                author_id: userId,
                include_nsfw: true,
                limit: 25,
                offset
            };
            if (channelId) query.channel_id = channelId;
            if (options.dateFromMs != null) query.min_id = snowflake(options.dateFromMs);
            if (options.dateToMs != null) query.max_id = snowflake(options.dateToMs);
            const response = await apiGet(`/guilds/${guildId}/messages/search`, query, signal, onWait);
            if (!response.ok) {
                if (response.status === 401) {
                    pushError("Discord rejected the session (401). Export stopped.");
                    throw new StopExport("401");
                }
                pushError(`Message search: ${response.message}`);
                break;
            }
            const groups = Array.isArray(response.body?.messages) ? response.body.messages : [];
            totalResults = Number(response.body?.total_results ?? totalResults) || totalResults;
            if (!groups.length) break;
            for (const group of groups) {
                const list = Array.isArray(group) ? group : [group];
                const hit = list.find(item => item?.hit === true) ?? list[0];
                const id = String(hit?.id ?? "");
                const authorId = String(hit?.author?.id ?? "");
                if (!id || seen.has(id) || authorId !== userId) continue;
                const time = messageTime(hit);
                if (options.dateFromMs != null && time < options.dateFromMs) continue;
                if (options.dateToMs != null && time > options.dateToMs) continue;
                seen.add(id);
                hits.push(hit);
            }
            offset += groups.length;
            patch({ phase: "Searching messages", detail: `${hits.length} found` });
            if (groups.length < 25 || offset >= totalResults) break;
        }
        if (totalResults > 5000 || offset >= 5000 && totalResults > hits.length) {
            capped = true;
            notes.push("Discord search only returns the first 5000 matching messages.");
        }
        await zip.addText(`${root}/user.json`, pretty({
            id: userId,
            label,
            guildId,
            channelId: channelId || "",
            searchCapped: capped
        }));

        const grouped = new Map<string, any[]>();
        for (const hit of hits) {
            const channelIdOfHit = String(hit.channel_id ?? hit.channelId ?? "");
            if (!channelIdOfHit) continue;
            const list = grouped.get(channelIdOfHit) ?? [];
            list.push(hit);
            grouped.set(channelIdOfHit, list);
        }
        total = grouped.size;
        patch({ channelsTotal: total });
        let index = 1;
        for (const [id, list] of grouped) {
            list.sort((a, b) => compareIds(String(b.id), String(a.id)));
            const cappedList = options.maxMessagesPerChannel > 0 ? list.slice(0, options.maxMessagesPerChannel) : list;
            cappedList.reverse();
            const channel = resolveChannel(id);
            await visit(channel, `${root}/channels/${indexed(index, channel.name, channel.id)}`, "", cappedList, false);
            index++;
        }
    }

    try {
        logger.info("Export started", target.kind);
        if (options.dateFrom) notes.push(`Messages on or after ${options.dateFrom} UTC.`);
        if (options.dateTo) notes.push(`Messages on or before ${options.dateTo} UTC.`);
        if (options.maxMessagesPerChannel > 0 && target.kind !== "message") {
            notes.push(`At most ${options.maxMessagesPerChannel} messages in each channel.`);
        }
        await zip.open();
        opened = true;
        patch({ native: zip.usingNative }, true);

        if (target.kind === "guild") {
            await exportGuild(target.guildId);
        } else if (target.kind === "category") {
            await exportGuild(target.guildId, target.categoryId);
        } else if (target.kind === "user-search") {
            await exportSearch(target.userId, target.guildId, target.channelId, target.label);
        } else {
            const channel = resolveChannel(target.channelId, target.channel);
            root = target.kind === "message"
                ? rootFolder("message", "message", target.messageId)
                : rootFolder(archiveKind(channel), channelTitle(channel), channel.id);
            total = 1;
            patch({ channelsTotal: 1 });
            let preset: any[] | null = null;
            if (target.kind === "message") {
                const provided = target.message as { id?: string; } | undefined;
                const raw = provided?.id === target.messageId
                    ? target.message
                    : await fetchOneMessage(target.channelId, target.messageId, signal, onWait);
                if (!raw) pushError("That message could not be read.");
                else preset = [raw];
            }
            if (target.kind !== "message" || preset) {
                await visit(channel, root, "", preset, target.kind !== "message");
            }
        }
    } catch (error) {
        if (isAbort(error) || signal.aborted) cancelled = true;
        else if (!(error instanceof StopExport)) pushError(errorText(error));
    } finally {
        if (signal.aborted) cancelled = true;
        if (!opened) {
            patch({ finished: true, saved: false, cancelled, phase: "Could not start the archive" }, true);
            endRun();
            return;
        }
        try {
            if (!zip.usingNative) {
                notes.push("This archive was downloaded through the browser because the desktop save helper is not loaded yet. Fully quit and reopen this Discord once. The next export can stream straight to a file you choose.");
            }
            const progressNow = getProgress();
            const extraFiles = 1 + (errors.length ? 1 : 0);
            if (errors.length) await zip.addText(`${root}/errors.txt`, errors.join("\n") + "\n");
            await zip.addText(`${root}/manifest.json`, pretty({
                exportedAt: new Date().toISOString(),
                kind: target.kind,
                target: describeTarget(target),
                settings: options,
                counts: {
                    messages: messageCount,
                    channels: reports.length,
                    files: progressNow.files + extraFiles,
                    bytes: progressNow.bytes,
                    skippedFiles: skipped,
                    errors: errorCount
                },
                channels: reports,
                cancelled,
                notes
            }));
            patch({
                phase: cancelled
                    ? (zip.usingNative ? "Choose where to save the partial archive" : "Downloading the partial archive")
                    : (zip.usingNative ? "Choose where to save the archive" : "Downloading the archive"),
                cancelled
            }, true);
            const saved = await zip.finish(`${root}.zip`);
            patch({
                finished: true,
                cancelled,
                saved: saved.saved,
                savedPath: saved.path ?? "",
                phase: saved.saved
                    ? (saved.path ? `Saved to ${saved.path}` : "Archive downloaded")
                    : "Save cancelled"
            }, true);
            logger.info("Export finished", cancelled ? "cancelled" : "complete", `errors=${errorCount}`);
        } catch (error) {
            await zip.discard().catch(() => { });
            if (!isAbort(error)) pushError(errorText(error));
            patch({ finished: true, saved: false, cancelled, phase: "Could not save the archive" }, true);
            logger.error(errorText(error));
        }
        endRun();
    }
}

function describeTarget(target: ExportTarget): Record<string, unknown> {
    if (target.kind === "message") {
        return { kind: target.kind, channelId: target.channelId, messageId: target.messageId };
    }
    if (target.kind === "channel") return { kind: target.kind, channelId: target.channelId };
    return { ...target };
}
