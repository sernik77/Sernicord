/*
 * Sernicord MegaDrop — large file transfer via bashupload (or similar) / chunked peer threads
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, sendBotMessage } from "@api/Commands";
import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { sendMessage } from "@utils/discord";
import definePlugin, { OptionType } from "@utils/types";
import { chooseFile, saveFile } from "@utils/web";
import { CloudUpload as TCloudUpload } from "@vencord/discord-types";
import { CloudUploadPlatform } from "@vencord/discord-types/enums";
import { findLazy } from "@webpack";
import {
    Button,
    Constants,
    FluxDispatcher,
    Forms,
    Menu,
    React,
    RestAPI,
    SelectedChannelStore,
    showToast,
    SnowflakeUtils,
    useState
} from "@webpack/common";

const Author = { name: "sernik", id: 0n };
const MANIFEST_PREFIX = "MEGADROP1:";
const CloudUpload: typeof TCloudUpload = findLazy(m => m.prototype?.trackUploadFinished);

type Manifest = {
    v: 1;
    name: string;
    size: number;
    parts: number;
    sha256?: string;
    mode: "bashupload" | "chunks";
    url?: string;
    done?: boolean;
};

function MegaDropSendButton() {
    const [busy, setBusy] = useState(false);
    return (
        <Button
            disabled={busy}
            onClick={async () => {
                setBusy(true);
                try { await pickAndSend(); }
                finally { setBusy(false); }
            }}
        >
            Pick file & send (default mode)
        </Button>
    );
}

export const settings = definePluginSettings({
    about: {
        type: OptionType.COMPONENT,
        component: () => (
            <Forms.FormText>
                Default: upload to bashupload.com (or your host) and post the link.
                Peer mode: split into parts, open a thread named <code>filename - N parts</code>,
                and auto-assemble on the receiving MegaDrop client.
            </Forms.FormText>
        )
    },
    uploadHost: {
        type: OptionType.STRING,
        description: "Upload host (bashupload-compatible). https://bashupload.com or https://bashupload.app",
        default: "https://bashupload.com"
    },
    mode: {
        type: OptionType.SELECT,
        description: "Default send mode",
        options: [
            { label: "Host upload (bashupload)", value: "bashupload", default: true },
            { label: "Peer chunk thread", value: "chunks" },
        ]
    },
    partBytes: {
        type: OptionType.NUMBER,
        description: "Chunk size in bytes for peer mode (default ~7.5MB)",
        default: 7_500_000
    },
    autoAssemble: {
        type: OptionType.BOOLEAN,
        description: "Auto-download & combine when all chunk parts are present",
        default: true
    },
    sendNow: {
        type: OptionType.COMPONENT,
        component: () => <MegaDropSendButton />
    }
});

function u8toHex(buf: ArrayBuffer): string {
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function sha256(buf: ArrayBuffer): Promise<string> {
    return u8toHex(await crypto.subtle.digest("SHA-256", buf));
}

async function uploadToHost(file: File): Promise<string> {
    const host = settings.store.uploadHost.replace(/\/$/, "");
    const res = await fetch(`${host}/${encodeURIComponent(file.name)}`, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": "application/octet-stream" }
    });
    const text = await res.text();
    if (!res.ok) {
        const fd = new FormData();
        fd.append("file", file, file.name);
        const res2 = await fetch(host, { method: "POST", body: fd });
        const text2 = await res2.text();
        if (!res2.ok) throw new Error(`Upload failed: ${res.status}/${res2.status}`);
        const url2 = text2.match(/https?:\/\/\S+/)?.[0];
        if (!url2) throw new Error(`No URL in response: ${text2.slice(0, 300)}`);
        return url2;
    }
    const url = text.match(/https?:\/\/\S+/)?.[0] ?? text.trim();
    if (!/^https?:\/\//.test(url)) throw new Error(`Unexpected response: ${text.slice(0, 300)}`);
    return url;
}

function uploadFileToChannel(channelId: string, file: File, content: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const upload = new CloudUpload({
            file,
            isThumbnail: false,
            platform: CloudUploadPlatform.WEB,
        }, channelId);

        upload.on("complete", () => {
            RestAPI.post({
                url: Constants.Endpoints.MESSAGES(channelId),
                body: {
                    channel_id: channelId,
                    content,
                    nonce: SnowflakeUtils.fromTimestamp(Date.now()),
                    sticker_ids: [],
                    type: 0,
                    attachments: [{
                        id: "0",
                        filename: upload.filename,
                        uploaded_filename: upload.uploadedFilename,
                    }]
                }
            }).then(() => resolve()).catch(reject);
        });
        upload.on("error", err => reject(err ?? new Error("upload error")));
        upload.upload();
    });
}

async function createThread(channelId: string, name: string): Promise<string> {
    try {
        const { body } = await RestAPI.post({
            url: `/channels/${channelId}/threads`,
            body: {
                name: name.slice(0, 100),
                type: 11,
                auto_archive_duration: 1440
            }
        });
        if (body?.id) return body.id;
    } catch { /* message-backed fallback */ }

    const anchor = await RestAPI.post({
        url: Constants.Endpoints.MESSAGES(channelId),
        body: {
            content: `MegaDrop: starting **${name.slice(0, 80)}**`,
            nonce: SnowflakeUtils.fromTimestamp(Date.now())
        }
    });
    const thr = await RestAPI.post({
        url: `/channels/${channelId}/messages/${anchor.body.id}/threads`,
        body: { name: name.slice(0, 100), auto_archive_duration: 1440 }
    });
    return thr.body.id;
}

async function sendChunked(channelId: string, file: File) {
    const binPart = Math.max(50_000, Math.min(settings.store.partBytes || 7_500_000, 8_000_000));
    const buf = await file.arrayBuffer();
    const hash = await sha256(buf);
    const bytes = new Uint8Array(buf);
    const parts = Math.ceil(bytes.length / binPart) || 1;
    const threadName = `${file.name} - ${parts} parts`.slice(0, 100);
    showToast({ text: `MegaDrop: thread for ${parts} parts…`, variant: "info" });
    const threadId = await createThread(channelId, threadName);

    const manifest: Manifest = {
        v: 1, name: file.name, size: file.size, parts, sha256: hash, mode: "chunks"
    };
    await sendMessage(threadId, { content: `${MANIFEST_PREFIX}${JSON.stringify(manifest)}` });

    for (let i = 0; i < parts; i++) {
        const slice = bytes.subarray(i * binPart, Math.min(bytes.length, (i + 1) * binPart));
        const partFile = new File(
            [slice],
            `${file.name}.part${String(i + 1).padStart(4, "0")}of${parts}`,
            { type: "application/octet-stream" }
        );
        await uploadFileToChannel(
            threadId,
            partFile,
            `MEGADROP_PART ${i + 1}/${parts} ${file.name}`
        );
        showToast({ text: `MegaDrop: part ${i + 1}/${parts}`, variant: "info" });
    }

    await sendMessage(threadId, {
        content: `${MANIFEST_PREFIX}${JSON.stringify({ ...manifest, done: true })}`
    });
    showToast({ text: "MegaDrop: all parts sent", variant: "success" });
}

async function sendBashupload(channelId: string, file: File) {
    showToast({ text: `MegaDrop: uploading ${file.name}…`, variant: "info" });
    const url = await uploadToHost(file);
    const hash = await sha256(await file.arrayBuffer());
    const manifest: Manifest = {
        v: 1, name: file.name, size: file.size, parts: 1, sha256: hash, mode: "bashupload", url
    };
    await sendMessage(channelId, {
        content: [
            `**MegaDrop** \`${file.name}\` (${file.size} bytes)`,
            url,
            `\`${MANIFEST_PREFIX}${JSON.stringify(manifest)}\``
        ].join("\n")
    });
    showToast({ text: "MegaDrop: link posted", variant: "success" });
}

async function pickAndSend(mode?: string) {
    const file = await chooseFile("*/*");
    if (!file) return;
    const channelId = SelectedChannelStore.getChannelId();
    if (!channelId) {
        showToast({ text: "No channel selected", variant: "critical" });
        return;
    }
    try {
        if ((mode || settings.store.mode) === "chunks") await sendChunked(channelId, file);
        else await sendBashupload(channelId, file);
    } catch (e) {
        showToast({ text: `MegaDrop failed: ${e}`, variant: "critical" });
        console.error(e);
    }
}

const pending = new Map<string, { manifest: Manifest; parts: Map<number, Uint8Array>; }>();

function parseManifest(content: string): Manifest | null {
    const idx = content.indexOf(MANIFEST_PREFIX);
    if (idx < 0) return null;
    try {
        const raw = content.slice(idx + MANIFEST_PREFIX.length);
        const start = raw.indexOf("{");
        const end = raw.lastIndexOf("}");
        if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
    } catch { /* */ }
    return null;
}

async function tryAssemble(channelId: string, state: { manifest: Manifest; parts: Map<number, Uint8Array>; }) {
    if (state.parts.size < state.manifest.parts) return;
    const chunks: Uint8Array[] = [];
    for (let i = 1; i <= state.manifest.parts; i++) {
        const p = state.parts.get(i);
        if (!p) return;
        chunks.push(p);
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    if (state.manifest.sha256) {
        const h = await sha256(out.buffer);
        if (h !== state.manifest.sha256) {
            showToast({ text: "MegaDrop: checksum mismatch", variant: "critical" });
            return;
        }
    }
    if (IS_DISCORD_DESKTOP) {
        DiscordNative.fileManager.saveWithDialog(out, state.manifest.name);
    } else {
        saveFile(new File([out], state.manifest.name, { type: "application/octet-stream" }));
    }
    showToast({ text: `MegaDrop: assembled ${state.manifest.name}`, variant: "success" });
    pending.delete(channelId);
}

async function onMessage(event: any) {
    if (event.type !== "MESSAGE_CREATE") return;
    const message = event.message;
    if (!message) return;
    const content = message.content || "";
    const channelId = message.channel_id;

    const man = parseManifest(content);
    if (man?.mode === "bashupload" && man.url) {
        showToast({ text: `MegaDrop available: ${man.name}`, variant: "info" });
    }
    if (man?.mode === "chunks") {
        const st = pending.get(channelId) ?? { manifest: man, parts: new Map() };
        st.manifest = { ...st.manifest, ...man };
        pending.set(channelId, st);
    }

    const partMatch = content.match(/MEGADROP_PART\s+(\d+)\/(\d+)/);
    if (partMatch && message.attachments?.length) {
        const idx = Number(partMatch[1]);
        const att = message.attachments[0];
        try {
            const res = await fetch(att.url);
            const buf = new Uint8Array(await res.arrayBuffer());
            const st = pending.get(channelId) ?? {
                manifest: {
                    v: 1 as const,
                    name: String(att.filename || "file").replace(/\.part\d+of\d+$/, ""),
                    size: 0,
                    parts: Number(partMatch[2]),
                    mode: "chunks" as const
                },
                parts: new Map<number, Uint8Array>()
            };
            st.parts.set(idx, buf);
            pending.set(channelId, st);
            if (settings.store.autoAssemble) await tryAssemble(channelId, st);
            else showToast({ text: `MegaDrop part ${idx}/${st.manifest.parts}`, variant: "info" });
        } catch (e) {
            console.error("MegaDrop part fetch", e);
        }
    }
}

const attachMenuPatch: NavContextMenuPatchCallback = children => {
    children.push(
        <Menu.MenuItem
            id="sc-megadrop-host"
            label="MegaDrop: upload via host"
            action={() => pickAndSend("bashupload")}
        />,
        <Menu.MenuItem
            id="sc-megadrop-chunks"
            label="MegaDrop: peer chunk thread"
            action={() => pickAndSend("chunks")}
        />
    );
};

export default definePlugin({
    name: "MegaDrop",
    description: "Send huge files via bashupload (or similar) or peer chunk threads that auto-assemble on the other MegaDrop client.",
    authors: [Author],
    tags: ["Utility", "Chat", "Media"],
    settings,
    contextMenus: { "channel-attach": attachMenuPatch },
    toolboxActions: { "MegaDrop send": () => pickAndSend() },
    commands: [{
        name: "megadrop",
        description: "Send a large file (picker)",
        inputType: ApplicationCommandInputType.BUILT_IN,
        execute: async (_a, ctx) => {
            sendBotMessage(ctx.channel.id, { content: "MegaDrop: pick a file…" });
            await pickAndSend();
        }
    }],
    start() {
        FluxDispatcher.subscribe("MESSAGE_CREATE", onMessage);
    },
    stop() {
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessage);
        pending.clear();
    }
});
