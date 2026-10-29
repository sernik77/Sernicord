/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";
import { Forms } from "@webpack/common";

export const settings = definePluginSettings({
    about: {
        type: OptionType.COMPONENT,
        component: () => (
            <Forms.FormText>
                Right-click a message, channel, thread, category, server, group DM, or friend and choose Download archive.
                Each folder name includes the Discord id, so two channels with the same name stay separate.
                If two files in one folder still share a name, the second becomes name-2, then name-3.
                The same Discord file is stored once when dedupe is on. JSONL is the full history. Markdown is only the readable copy, so a third plain transcript stays off unless you enable it.
            </Forms.FormText>
        )
    },
    writeJson: {
        type: OptionType.BOOLEAN,
        description: "Write messages.jsonl, one JSON object per line, oldest first.",
        default: true
    },
    writeMarkdown: {
        type: OptionType.BOOLEAN,
        description: "Write transcript.md. Saved files are linked by their path inside the zip.",
        default: true
    },
    writePlain: {
        type: OptionType.BOOLEAN,
        description: "Also write transcript.txt. Off by default because it repeats the markdown transcript.",
        default: false
    },
    includeAttachments: {
        type: OptionType.BOOLEAN,
        description: "Save files people attached to messages.",
        default: true
    },
    includeEmbedMedia: {
        type: OptionType.BOOLEAN,
        description: "Save images and video that Discord hosts for embeds.",
        default: true
    },
    includeExternalEmbeds: {
        type: OptionType.BOOLEAN,
        description: "Also download files embedded from other websites.",
        default: false
    },
    includeStickers: {
        type: OptionType.BOOLEAN,
        description: "Save stickers used in messages. Lottie stickers are saved as JSON.",
        default: true
    },
    includeAvatars: {
        type: OptionType.BOOLEAN,
        description: "Save each custom avatar once under avatars/. Off by default so the same picture is not copied onto every message.",
        default: false
    },
    includeGuildAssets: {
        type: OptionType.BOOLEAN,
        description: "On a server export, save the icon, banner, splash, role icons, emoji, and the sticker library.",
        default: true
    },
    includeThreads: {
        type: OptionType.BOOLEAN,
        description: "Include active and archived threads. Private archived threads you cannot open are skipped.",
        default: true
    },
    includeReactions: {
        type: OptionType.BOOLEAN,
        description: "Write reaction names and counts into the transcript. Reaction images are not saved again.",
        default: true
    },
    includeEmptyChannels: {
        type: OptionType.BOOLEAN,
        description: "Write channel.json for channels with no messages, so the server layout is still in the archive.",
        default: true
    },
    dedupeMedia: {
        type: OptionType.BOOLEAN,
        description: "Store each distinct file once. Later messages point at that copy.",
        default: true
    },
    pageDelayMs: {
        type: OptionType.SLIDER,
        description: "Pause between history requests. Raise this if Discord rate limits the export.",
        markers: [0, 100, 250, 500, 1000, 2000],
        default: 250,
        stickToMarkers: true
    },
    mediaConcurrency: {
        type: OptionType.SLIDER,
        description: "How many files to download at once. They are still written into the zip one at a time.",
        markers: [1, 2, 3, 4, 5, 6, 7, 8],
        default: 3,
        stickToMarkers: true
    },
    maxMessagesPerChannel: {
        type: OptionType.NUMBER,
        description: "Stop each channel after this many messages. 0 downloads the whole channel.",
        default: 0
    },
    dateFrom: {
        type: OptionType.STRING,
        description: "Only messages on or after this day (YYYY-MM-DD, UTC). Leave empty for no start.",
        default: "",
        placeholder: "YYYY-MM-DD"
    },
    dateTo: {
        type: OptionType.STRING,
        description: "Only messages on or before this day (YYYY-MM-DD, UTC). Leave empty for no end.",
        default: "",
        placeholder: "YYYY-MM-DD"
    },
    maxFileMegabytes: {
        type: OptionType.NUMBER,
        description: "Skip one file when it is larger than this many megabytes and note that in the transcript. 0 keeps every file.",
        default: 0
    },
    confirmLarge: {
        type: OptionType.BOOLEAN,
        description: "Ask before a server export, or any other export that has no per-channel message cap. A single message never asks.",
        default: true
    }
}, {
    maxMessagesPerChannel: {
        isValid: value => value >= 0 && Number.isFinite(value) || "Use 0 or a positive number"
    },
    maxFileMegabytes: {
        isValid: value => value >= 0 && Number.isFinite(value) || "Use 0 or a positive number"
    },
    dateFrom: {
        isValid: value => validDay(value)
    },
    dateTo: {
        isValid: value => validDay(value)
    }
});

function validDay(value: string): true | string {
    const text = value.trim();
    if (!text) return true;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return "Use YYYY-MM-DD";
    return Number.isNaN(Date.parse(`${text}T00:00:00.000Z`)) ? "Use YYYY-MM-DD" : true;
}
