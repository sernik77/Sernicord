/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { sanitizeFileName } from "./names";
import { bigintReplacer, extensionFromUrl, isDiscordHost, isHttpsUrl, mediaKey, stickerFile } from "./urls";

export interface ExportFlags {
    includeAttachments: boolean;
    includeEmbedMedia: boolean;
    includeExternalEmbeds: boolean;
    includeStickers: boolean;
    includeAvatars: boolean;
    includeReactions: boolean;
}

export interface ArchiveAuthor {
    id: string;
    username: string;
    globalName?: string;
    bot?: boolean;
    avatar?: string;
    avatarFile?: string;
}

export interface ArchiveFile {
    filename: string;
    url?: string;
    proxyUrl?: string;
    size?: number;
    contentType?: string;
    spoiler?: boolean;
    archivePath?: string;
    skipped?: string;
}

export interface ArchiveSnapshot {
    id: string;
    channelId: string;
    timestamp: string;
    editedTimestamp?: string;
    type: number;
    content: string;
    author: ArchiveAuthor;
    attachments: ArchiveFile[];
    embeds: {
        type?: string;
        title?: string;
        description?: string;
        url?: string;
        fields?: { name: string; value: string; }[];
        media: ArchiveFile[];
    }[];
    stickers: { id: string; name: string; format: number; archivePath?: string; skipped?: string; }[];
    reactions?: { emoji: string; count: number; me?: boolean; }[];
    poll?: { question: string; answers: string[]; multiple?: boolean; };
    components?: string[];
    reference?: ArchiveSnapshot;
    forwarded?: ArchiveSnapshot[];
}

export interface MediaRef {
    url: string;
    filename: string;
    dedupeKey: string;
    directory: string;
    assign: (archivePath: string) => void;
    skip: (reason: string) => void;
}

function text(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function authorOf(raw: any): ArchiveAuthor {
    const author = raw?.author ?? {};
    const avatar = text(author.avatar);
    const globalName = text(author.globalName || author.global_name);
    const result: ArchiveAuthor = {
        id: text(author.id),
        username: text(author.username) || "unknown"
    };
    if (globalName) result.globalName = globalName;
    if (author.bot) result.bot = true;
    if (avatar) result.avatar = avatar;
    return result;
}

function iso(value: unknown, fallbackId?: string): string {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "string" && value) {
        const parsed = new Date(value);
        if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
    }
    if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
    if (fallbackId) {
        try {
            return new Date(Number((BigInt(fallbackId) >> 22n) + 1420070400000n)).toISOString();
        } catch {
            return "";
        }
    }
    return "";
}

function fileOf(raw: any): ArchiveFile | null {
    const url = text(raw?.url) || text(raw?.proxy_url) || text(raw?.proxyURL);
    const filename = text(raw?.filename) || text(raw?.name);
    if (!url && !filename) return null;
    const file: ArchiveFile = { filename: filename || "file" };
    if (url) file.url = url;
    if (typeof raw?.size === "number") file.size = raw.size;
    const contentType = text(raw?.content_type || raw?.contentType);
    if (contentType) file.contentType = contentType;
    if (raw?.spoiler) file.spoiler = true;
    return file;
}

function embedMedia(raw: any): ArchiveFile | null {
    const url = text(raw?.url);
    const proxy = text(raw?.proxyURL || raw?.proxy_url);
    const chosen = url || proxy;
    if (!chosen) return null;
    const file: ArchiveFile = {
        filename: decodeURIComponent(chosen.split("/").pop()?.split("?")[0] || "embed"),
        url: chosen
    };
    if (proxy && proxy !== chosen) file.proxyUrl = proxy;
    return file;
}

function embedOf(raw: any): ArchiveSnapshot["embeds"][number] | null {
    if (!raw || typeof raw !== "object") return null;
    const title = text(raw.rawTitle || raw.title);
    const description = text(raw.rawDescription || raw.description);
    const url = text(raw.url);
    const type = text(raw.type);
    const fields = Array.isArray(raw.fields)
        ? raw.fields.map((field: any) => ({
            name: text(field.rawName || field.name),
            value: text(field.rawValue || field.value)
        })).filter((field: { name: string; value: string; }) => field.name || field.value)
        : [];
    const media = [raw.image, raw.thumbnail, raw.video, ...(Array.isArray(raw.images) ? raw.images : [])]
        .map(embedMedia)
        .filter((item): item is ArchiveFile => item != null);
    if (!title && !description && !url && !fields.length && !media.length) return null;
    return {
        ...(type ? { type } : {}),
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
        ...(url ? { url } : {}),
        ...(fields.length ? { fields } : {}),
        media
    };
}

function componentLabels(raw: any): string[] {
    const labels: string[] = [];
    const walk = (list: any) => {
        if (!Array.isArray(list)) return;
        for (const item of list) {
            const label = text(item?.label || item?.content || item?.placeholder);
            if (label) labels.push(label);
            walk(item?.components);
        }
    };
    walk(raw);
    return labels;
}

function pollOf(raw: any): ArchiveSnapshot["poll"] | undefined {
    if (!raw) return;
    const question = text(raw.question?.text || raw.question?.poll_media?.text || raw.question);
    const answers = Array.isArray(raw.answers)
        ? raw.answers.map((answer: any) => text(answer?.poll_media?.text || answer?.text)).filter(Boolean)
        : [];
    if (!question && !answers.length) return;
    return {
        question,
        answers,
        ...(raw.allow_multiselect || raw.allowMultiselect ? { multiple: true } : {})
    };
}

export function snapshotMessage(raw: any, depth = 0): ArchiveSnapshot {
    const id = text(raw?.id);
    const attachments = (Array.isArray(raw?.attachments) ? raw.attachments : [])
        .map(fileOf)
        .filter((item): item is ArchiveFile => item != null);
    const embeds = (Array.isArray(raw?.embeds) ? raw.embeds : [])
        .map(embedOf)
        .filter((item): item is NonNullable<ReturnType<typeof embedOf>> => item != null);
    const stickerSource = raw?.stickerItems || raw?.sticker_items || raw?.stickers || [];
    const stickers = (Array.isArray(stickerSource) ? stickerSource : []).map((sticker: any) => ({
        id: text(sticker?.id),
        name: text(sticker?.name) || "sticker",
        format: Number(sticker?.format_type ?? sticker?.formatType ?? 1) || 1
    })).filter((sticker: { id: string; }) => sticker.id);

    const snapshot: ArchiveSnapshot = {
        id,
        channelId: text(raw?.channel_id || raw?.channelId),
        timestamp: iso(raw?.timestamp, id),
        type: Number(raw?.type ?? 0) || 0,
        content: text(raw?.content),
        author: authorOf(raw),
        attachments,
        embeds,
        stickers
    };
    const edited = iso(raw?.editedTimestamp || raw?.edited_timestamp);
    if (edited) snapshot.editedTimestamp = edited;

    if (depth === 0) {
        const reactions = Array.isArray(raw?.reactions) ? raw.reactions : [];
        if (reactions.length) {
            snapshot.reactions = reactions.map((reaction: any) => {
                const emoji = reaction?.emoji ?? {};
                const name = text(emoji.name) || "emoji";
                const emojiId = text(emoji.id);
                return {
                    emoji: emojiId ? `${name}:${emojiId}` : name,
                    count: Number(reaction?.count ?? reaction?.count_details?.count ?? 1) || 1,
                    ...(reaction?.me ? { me: true } : {})
                };
            });
        }
        const labels = componentLabels(raw?.components);
        if (labels.length) snapshot.components = labels;
        const poll = pollOf(raw?.poll);
        if (poll) snapshot.poll = poll;

        const referenced = raw?.referenced_message || raw?.referencedMessage;
        if (referenced && typeof referenced === "object") snapshot.reference = snapshotMessage(referenced, 1);

        const forwarded = raw?.messageSnapshots || raw?.message_snapshots;
        if (Array.isArray(forwarded) && forwarded.length) {
            snapshot.forwarded = forwarded
                .map(item => snapshotMessage(item?.message ?? item, 1))
                .filter(item => item.id || item.content);
        }
    }
    return snapshot;
}

function pushFile(refs: MediaRef[], file: ArchiveFile, directory: string, filename: string, allowed: boolean): void {
    const { url } = file;
    if (!url || !allowed) return;
    if (!isHttpsUrl(url)) {
        file.skipped = "only https files are saved";
        return;
    }
    const ext = extensionFromUrl(url);
    const safe = sanitizeFileName(ext && !filename.toLowerCase().endsWith(`.${ext}`) ? `${filename}.${ext}` : filename);
    refs.push({
        url,
        filename: safe,
        dedupeKey: mediaKey(url),
        directory,
        assign: archivePath => { file.archivePath = archivePath; },
        skip: reason => { file.skipped = reason; }
    });
}

function chosenEmbedUrl(file: ArchiveFile, flags: ExportFlags): string {
    const url = file.url ?? "";
    const proxy = file.proxyUrl ?? "";
    if (flags.includeEmbedMedia && isHttpsUrl(proxy) && isDiscordHost(proxy)) return proxy;
    if (flags.includeEmbedMedia && isHttpsUrl(url) && isDiscordHost(url)) return url;
    if (flags.includeExternalEmbeds && isHttpsUrl(url) && !isDiscordHost(url)) return url;
    return "";
}

export function collectMedia(snapshot: ArchiveSnapshot, directory: string, assetRoot: string, flags: ExportFlags, refs: MediaRef[], depth = 0): void {
    const mediaDir = `${directory}/media`;
    snapshot.attachments.forEach((file, index) => {
        pushFile(refs, file, mediaDir, `${snapshot.id}__${index}__${file.filename || "file"}`, flags.includeAttachments);
    });
    snapshot.embeds.forEach((embed, embedIndex) => {
        embed.media.forEach((file, index) => {
            const chosen = chosenEmbedUrl(file, flags);
            if (!chosen) return;
            file.url = chosen;
            pushFile(refs, file, mediaDir, `${snapshot.id}__embed${embedIndex}__${index}__${file.filename || "embed"}`, true);
        });
    });
    if (flags.includeStickers) {
        for (const sticker of snapshot.stickers) {
            const file = stickerFile(sticker.id, sticker.format);
            refs.push({
                url: file.url,
                filename: sanitizeFileName(`${snapshot.id}__sticker__${sticker.name}.${file.ext}`),
                dedupeKey: mediaKey(file.url),
                directory: mediaDir,
                assign: archivePath => { sticker.archivePath = archivePath; },
                skip: reason => { sticker.skipped = reason; }
            });
        }
    }
    if (flags.includeAvatars && snapshot.author.avatar && snapshot.author.id) {
        const ext = hashExtensionSafe(snapshot.author.avatar);
        const url = `https://cdn.discordapp.com/avatars/${snapshot.author.id}/${snapshot.author.avatar}.${ext}`;
        refs.push({
            url,
            filename: sanitizeFileName(`${snapshot.author.id}.${ext}`),
            dedupeKey: `avatar:${snapshot.author.id}/${snapshot.author.avatar}`,
            directory: `${assetRoot}/avatars`,
            assign: archivePath => { snapshot.author.avatarFile = archivePath; },
            skip: () => { }
        });
    }
    if (depth === 0) {
        if (snapshot.reference) collectMedia(snapshot.reference, directory, assetRoot, flags, refs, 1);
        for (const forwarded of snapshot.forwarded ?? []) collectMedia(forwarded, directory, assetRoot, flags, refs, 1);
    }
}

function hashExtensionSafe(hash: string): "gif" | "png" {
    return hash.startsWith("a_") ? "gif" : "png";
}

function displayAuthor(author: ArchiveAuthor): string {
    const shown = author.globalName || author.username;
    if (author.globalName && author.username && author.globalName !== author.username) return `${shown} (@${author.username})`;
    return shown;
}

function relative(fromDir: string, fullPath: string): string {
    const from = fromDir.split("/").filter(Boolean);
    const to = fullPath.split("/").filter(Boolean);
    let shared = 0;
    while (shared < from.length && shared < to.length && from[shared] === to[shared]) shared++;
    const parts = [...Array(from.length - shared).fill(".."), ...to.slice(shared)];
    return parts.join("/") || fullPath;
}

function block(snapshot: ArchiveSnapshot, directory: string, markdown: boolean): string[] {
    const lines: string[] = [];
    const who = displayAuthor(snapshot.author);
    lines.push(markdown ? `## ${snapshot.timestamp} — ${who}` : `${snapshot.timestamp}  ${who}  ${snapshot.author.id}`);
    if (snapshot.content) lines.push("", snapshot.content);
    else if (snapshot.type !== 0) lines.push("", `System message (type ${snapshot.type})`);
    if (snapshot.components?.length) lines.push("", snapshot.components.join(" | "));
    if (snapshot.poll) {
        lines.push("", `Poll: ${snapshot.poll.question}`);
        for (const answer of snapshot.poll.answers) lines.push(`- ${answer}`);
    }
    if (snapshot.reference) {
        const quoted = snapshot.reference.content || (snapshot.reference.type !== 0 ? `System message (type ${snapshot.reference.type})` : "");
        lines.push("", `Reply to ${displayAuthor(snapshot.reference.author)}: ${quoted}`.trim());
    }
    const files = [
        ...snapshot.attachments,
        ...snapshot.embeds.flatMap(embed => embed.media)
    ];
    for (const file of files) {
        if (file.archivePath) lines.push(`- ${relative(directory, file.archivePath)}`);
        else if (file.skipped) lines.push(`- ${file.filename} was not saved (${file.skipped})`);
    }
    for (const sticker of snapshot.stickers) {
        if (sticker.archivePath) lines.push(`- ${relative(directory, sticker.archivePath)} (${sticker.name})`);
        else if (sticker.skipped) lines.push(`- sticker ${sticker.name} was not saved (${sticker.skipped})`);
    }
    if (snapshot.reactions?.length) {
        lines.push("", snapshot.reactions.map(reaction => `${reaction.emoji} ×${reaction.count}`).join("  "));
    }
    for (const embed of snapshot.embeds) {
        if (embed.title || embed.description) lines.push("", [embed.title, embed.description].filter(Boolean).join("\n"));
    }
    for (const forwarded of snapshot.forwarded ?? []) {
        lines.push("", "Forwarded:", ...block(forwarded, directory, markdown).slice(1));
    }
    return lines;
}

export function renderTranscript(channelLabel: string, channelId: string, snapshots: ArchiveSnapshot[], directory: string, markdown: boolean, withReactions: boolean): string {
    const prepared = withReactions
        ? snapshots
        : snapshots.map(item => ({ ...item, reactions: undefined }));
    const body = prepared.flatMap(item => [...block(item, directory, markdown), ""]);
    const title = markdown ? `# ${channelLabel}` : channelLabel;
    return [`${title}`, channelId, "", ...body].join("\n");
}

function withoutProxy(file: ArchiveFile): ArchiveFile {
    if (!file.proxyUrl) return file;
    const copy = { ...file };
    delete copy.proxyUrl;
    return copy;
}

function forExport(snapshot: ArchiveSnapshot, withReactions: boolean): ArchiveSnapshot {
    const copy: ArchiveSnapshot = {
        ...snapshot,
        attachments: snapshot.attachments.map(withoutProxy),
        embeds: snapshot.embeds.map(embed => ({ ...embed, media: embed.media.map(withoutProxy) })),
        reactions: withReactions ? snapshot.reactions : undefined
    };
    if (snapshot.reference) copy.reference = forExport(snapshot.reference, withReactions);
    if (snapshot.forwarded) copy.forwarded = snapshot.forwarded.map(item => forExport(item, withReactions));
    return copy;
}

export function toJsonl(snapshots: ArchiveSnapshot[], withReactions: boolean): string {
    if (!snapshots.length) return "";
    return snapshots.map(item => JSON.stringify(forExport(item, withReactions), bigintReplacer)).join("\n") + "\n";
}
