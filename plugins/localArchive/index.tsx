/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import definePlugin from "@utils/types";
import { Channel, RenderModalProps, User } from "@vencord/discord-types";
import { ChannelType } from "@vencord/discord-types/enums";
import { ChannelStore, closeModal, ConfirmModal, Forms, GuildStore, Menu, Modal, openModal, showToast, useEffect, useState } from "@webpack/common";
import { ReactElement } from "react";

import { ExportSettings, ExportTarget, runExport } from "./exportJob";
import { getProgress, isRunning, requestCancel, subscribe } from "./progress";
import { settings } from "./settings";
import { parseDay } from "./urls";

const ITEM_ID = "vc-local-archive";
const ANCHORS = ["copy-link", "copy-user-id", "copy-id", "mark-as-read", "mute-channel", "unmute-channel", "privacy", "leave-channel", "close-dm", "delete"];

function DownloadIcon(props: { className?: string; width?: number | string; height?: number | string; }) {
    return (
        <svg aria-hidden role="img" width={props.width ?? 20} height={props.height ?? 20} viewBox="0 0 24 24" className={props.className} fill="none">
            <path fill="currentColor" d="M12 2a1 1 0 0 1 1 1v10.59l3.3-3.3a1 1 0 1 1 1.4 1.42l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.42l3.3 3.3V3a1 1 0 0 1 1-1ZM3 20a1 1 0 1 0 0 2h18a1 1 0 1 0 0-2H3Z" />
        </svg>
    );
}

function formatBytes(value: number): string {
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
    return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function finite(value: unknown, fallback: number): number {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function currentOptions(): ExportSettings {
    const { store } = settings;
    const dateFrom = String(store.dateFrom ?? "");
    const dateTo = String(store.dateTo ?? "");
    return {
        writeJson: store.writeJson !== false,
        writeMarkdown: store.writeMarkdown !== false,
        writePlain: !!store.writePlain,
        includeAttachments: store.includeAttachments !== false,
        includeEmbedMedia: store.includeEmbedMedia !== false,
        includeExternalEmbeds: !!store.includeExternalEmbeds,
        includeStickers: store.includeStickers !== false,
        includeAvatars: !!store.includeAvatars,
        includeGuildAssets: store.includeGuildAssets !== false,
        includeThreads: store.includeThreads !== false,
        includeReactions: store.includeReactions !== false,
        includeEmptyChannels: store.includeEmptyChannels !== false,
        dedupeMedia: store.dedupeMedia !== false,
        pageDelayMs: Math.max(0, finite(store.pageDelayMs, 250)),
        mediaConcurrency: Math.min(8, Math.max(1, finite(store.mediaConcurrency, 3))),
        maxMessagesPerChannel: Math.max(0, finite(store.maxMessagesPerChannel, 0)),
        dateFrom,
        dateTo,
        dateFromMs: parseDay(dateFrom, false),
        dateToMs: parseDay(dateTo, true),
        maxFileBytes: Math.max(0, finite(store.maxFileMegabytes, 0)) * 1024 * 1024
    };
}

function needsConfirm(target: ExportTarget): boolean {
    if (!settings.store.confirmLarge) return false;
    if (target.kind === "message") return false;
    if (target.kind === "guild" || target.kind === "category") return true;
    return finite(settings.store.maxMessagesPerChannel, 0) === 0;
}

let progressKey = "";

function ProgressModal(props: RenderModalProps) {
    const [snap, setSnap] = useState(getProgress);
    useEffect(() => subscribe(setSnap), []);
    const lastErrors = snap.errors.slice(-3);
    return (
        <Modal
            {...props}
            title="Local archive"
            subtitle={snap.phase}
            size="md"
            actions={snap.finished
                ? [{ text: "Close", variant: "primary", onClick: props.onClose }]
                : [{ text: "Cancel", variant: "secondary", onClick: () => requestCancel() }]}
        >
            <Forms.FormText>{snap.detail || "Preparing the archive."}</Forms.FormText>
            <Forms.FormText>
                {`Messages ${snap.messages.toLocaleString()} · Channels ${snap.channelsDone}/${snap.channelsTotal} · Files ${snap.files.toLocaleString()} · ${formatBytes(snap.bytes)}`}
            </Forms.FormText>
            {snap.skippedFiles > 0 && (
                <Forms.FormText>{`${snap.skippedFiles.toLocaleString()} files were over the size limit and were skipped.`}</Forms.FormText>
            )}
            {lastErrors.map((error, index) => (
                <Forms.FormText key={`${index}-${error.slice(0, 24)}`}>{error}</Forms.FormText>
            ))}
            {snap.errorCount > lastErrors.length && (
                <Forms.FormText>{`${snap.errorCount.toLocaleString()} errors in total. The list is in errors.txt inside the archive.`}</Forms.FormText>
            )}
            {!snap.native && (
                <Forms.FormText>
                    The save dialog needs one full restart of this Discord after Local Archive is installed. Until then the zip is kept in memory and downloaded through the browser.
                </Forms.FormText>
            )}
            {snap.savedPath ? <Forms.FormText>{snap.savedPath}</Forms.FormText> : null}
        </Modal>
    );
}

function openProgress(): void {
    if (progressKey) return;
    progressKey = openModal(modalProps => <ProgressModal {...modalProps} />, {
        modalKey: "vc-local-archive",
        onCloseRequest() {
            if (!getProgress().finished) {
                requestCancel();
                return;
            }
            closeModal(progressKey);
            progressKey = "";
        },
        onCloseCallback() {
            progressKey = "";
        }
    });
}

function start(target: ExportTarget): void {
    if (isRunning()) {
        showToast({ text: "An archive is already downloading", variant: "default" });
        return;
    }
    const go = () => {
        openProgress();
        void runExport(target, currentOptions());
    };
    if (!needsConfirm(target)) {
        go();
        return;
    }
    openModal(modalProps => (
        <ConfirmModal
            {...modalProps}
            variant="primary"
            title="Download archive"
            confirmText="Download"
            cancelText="Cancel"
            onConfirm={go}
        >
            <Forms.FormText>
                This can download a lot of messages and files from channels you can already open. You can cancel while it runs. The partial zip is still saved.
            </Forms.FormText>
        </ConfirmModal>
    ));
}

function alreadyHas(children: any): boolean {
    const list = Array.isArray(children) ? children : [children];
    for (const child of list) {
        if (!child) continue;
        if (child.props?.id === ITEM_ID) return true;
        if (child.props?.children && alreadyHas(child.props.children)) return true;
    }
    return false;
}

function insertArchiveItem(children: any[], item: ReactElement): void {
    if (alreadyHas(children)) return;
    const group = findGroupChildrenByChildId(ANCHORS, children);
    if (!group) {
        children.push(item);
        return;
    }
    const index = group.findIndex(child => ANCHORS.includes(child?.props?.id));
    group.splice(index < 0 ? group.length : index, 0, item);
}

function archiveMenu(actions: { id: string; label: string; run: () => void; }[]): ReactElement | null {
    if (!actions.length) return null;
    return (
        <Menu.MenuItem
            id={ITEM_ID}
            label="Download archive"
            leadingAccessory={{ type: "icon", icon: DownloadIcon }}
        >
            {actions.map(action => (
                <Menu.MenuItem
                    key={action.id}
                    id={action.id}
                    label={action.label}
                    action={action.run}
                />
            ))}
        </Menu.MenuItem>
    );
}

function personLabel(user: User): string {
    const shown = user.globalName || user.username || "user";
    return shown.length > 40 ? `${shown.slice(0, 39)}…` : shown;
}

function guildIdOf(channel: Channel): string {
    if (channel.guild_id) return channel.guild_id;
    try {
        return channel.getGuildId?.() || "";
    } catch {
        return "";
    }
}

function scopeLabel(channel: Channel): string {
    if (channel.isThread()) return "This thread";
    if (channel.isDM()) return "This DM";
    if (channel.isGroupDM()) return "This group DM";
    if (channel.isCategory()) return "This category";
    return "This channel";
}

function dmWith(userId: string, channel?: Channel): Channel | undefined {
    const known = ChannelStore.getDMChannelFromUserId(userId);
    if (known?.id) return known;
    if (!channel?.isDM()) return;
    const recipient = channel.getRecipientId() ?? channel.recipients?.[0];
    if (recipient === userId) return channel;
}

function channelActions(channel?: Channel): { id: string; label: string; run: () => void; }[] {
    if (!channel?.id) return [];
    const guildId = guildIdOf(channel);
    if (channel.isCategory() || channel.type === ChannelType.GUILD_CATEGORY) {
        if (!guildId) return [];
        return [
            {
                id: "vc-local-archive-category",
                label: "This category",
                run: () => start({ kind: "category", guildId, categoryId: channel.id })
            },
            {
                id: "vc-local-archive-server",
                label: "This server",
                run: () => start({ kind: "guild", guildId })
            }
        ];
    }
    const actions = [
        {
            id: "vc-local-archive-channel",
            label: scopeLabel(channel),
            run: () => start({ kind: "channel", channelId: channel.id, channel })
        }
    ];
    if (guildId && !channel.isPrivate()) {
        actions.push({
            id: "vc-local-archive-server",
            label: "This server",
            run: () => start({ kind: "guild", guildId })
        });
    }
    return actions;
}

const messageMenu: NavContextMenuPatchCallback = (children, props) => {
    const channel = props?.channel as Channel | undefined;
    const message = props?.message as { id?: string; } | undefined;
    if (!channel?.id || !message?.id) return;
    const actions = [
        {
            id: "vc-local-archive-message",
            label: "This message",
            run: () => start({ kind: "message", channelId: channel.id, messageId: message.id!, message, channel })
        },
        ...channelActions(channel).filter(action => action.id !== "vc-local-archive-category")
    ];
    const item = archiveMenu(actions);
    if (item) insertArchiveItem(children, item);
};

const channelMenu: NavContextMenuPatchCallback = (children, props) => {
    const item = archiveMenu(channelActions(props?.channel));
    if (item) insertArchiveItem(children, item);
};

const userMenu: NavContextMenuPatchCallback = (children, props) => {
    const user = props?.user as User | undefined;
    if (!user?.id) return;
    const label = personLabel(user);
    const channel = props?.channel as Channel | undefined;
    const actions: { id: string; label: string; run: () => void; }[] = [];
    const dm = dmWith(user.id, channel);
    if (dm?.id) {
        actions.push({
            id: "vc-local-archive-dm",
            label: `DM with ${label}`,
            run: () => start({ kind: "channel", channelId: dm.id, channel: dm })
        });
    }
    const guildId = String(props?.guildId || (channel ? guildIdOf(channel) : ""));
    if (guildId && channel?.id && !channel.isPrivate()) {
        actions.push({
            id: "vc-local-archive-user-channel",
            label: `Messages by ${label} in this channel`,
            run: () => start({
                kind: "user-search",
                userId: user.id,
                guildId,
                channelId: channel.id,
                label
            })
        });
    }
    if (guildId) {
        actions.push({
            id: "vc-local-archive-user-server",
            label: `Messages by ${label} in this server`,
            run: () => start({ kind: "user-search", userId: user.id, guildId, label })
        });
    }
    const item = archiveMenu(actions);
    if (item) insertArchiveItem(children, item);
};

const guildMenu: NavContextMenuPatchCallback = (children, props) => {
    const guild = props?.guild ?? (props?.guildId ? GuildStore.getGuild(props.guildId) : undefined);
    if (!guild?.id) return;
    const item = archiveMenu([{
        id: "vc-local-archive-guild",
        label: "This server",
        run: () => start({ kind: "guild", guildId: guild.id })
    }]);
    if (item) insertArchiveItem(children, item);
};

export default definePlugin({
    name: "LocalArchive",
    description: "Download a message, DM, channel, thread, or whole server as a zip of history and media.",
    authors: [{ name: "you", id: 0n }],
    tags: ["Utility", "Chat", "Media"],
    searchTerms: ["export", "archive", "download", "zip", "backup"],
    settings,
    contextMenus: {
        "message": messageMenu,
        "channel-context": channelMenu,
        "thread-context": channelMenu,
        "gdm-context": channelMenu,
        "user-context": userMenu,
        "guild-context": guildMenu,
        "guild-header-popout": guildMenu
    }
});
