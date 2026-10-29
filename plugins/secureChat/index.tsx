/*
 * Sernicord SecureChat — encrypt/decrypt chat when both sides have the plugin
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin, { OptionType } from "@utils/types";
import { Message } from "@vencord/discord-types";
import { ChannelStore, Forms, showToast, useEffect, useState } from "@webpack/common";

import { decryptText, encryptText, isSecurePayload } from "./crypto";

const Author = { name: "sernik", id: 0n };

function parseIdList(raw: string): Set<string> {
    return new Set(
        String(raw || "")
            .split(/[\s,;]+/)
            .map(s => s.trim())
            .filter(Boolean)
    );
}

export const settings = definePluginSettings({
    about: {
        type: OptionType.COMPONENT,
        component: () => (
            <Forms.FormText>
                AES-256-GCM with a shared passphrase. Peers with SecureChat + the same passphrase
                decrypt automatically unless the author is blacklisted. Share the passphrase out of band.
            </Forms.FormText>
        )
    },
    passphrase: {
        type: OptionType.STRING,
        description: "Shared passphrase (both users must match)",
        default: "",
        placeholder: "correct horse battery staple"
    },
    autoEncrypt: {
        type: OptionType.BOOLEAN,
        description: "Encrypt outgoing messages by default (chat-bar lock overrides for the session)",
        default: false
    },
    encryptDmsOnly: {
        type: OptionType.BOOLEAN,
        description: "Only auto-encrypt in DMs / group DMs",
        default: true
    },
    channelAllowlist: {
        type: OptionType.STRING,
        description: "Optional channel IDs that always encrypt (comma-separated). Empty = all (subject to DM-only).",
        default: ""
    },
    userBlacklist: {
        type: OptionType.STRING,
        description: "Never decrypt messages from these user IDs",
        default: ""
    },
    userAllowlist: {
        type: OptionType.STRING,
        description: "If set, only decrypt messages from these user IDs (blacklist still wins)",
        default: ""
    },
    showLockButton: {
        type: OptionType.BOOLEAN,
        description: "Show encrypt toggle on the chat bar",
        default: true
    }
});

let sessionEncrypt: boolean | null = null;

function wantsEncrypt(channelId: string): boolean {
    const enabled = sessionEncrypt ?? settings.store.autoEncrypt;
    if (!enabled) return false;
    const allow = parseIdList(settings.store.channelAllowlist);
    if (allow.size && !allow.has(channelId)) return false;
    if (settings.store.encryptDmsOnly) {
        const ch = ChannelStore.getChannel(channelId);
        if (ch?.guild_id) return false;
    }
    return true;
}

function mayDecryptAuthor(authorId: string): boolean {
    const black = parseIdList(settings.store.userBlacklist);
    if (black.has(authorId)) return false;
    const allow = parseIdList(settings.store.userAllowlist);
    if (allow.size && !allow.has(authorId)) return false;
    return true;
}

function DecryptedAccessory({ message }: { message: Message; }) {
    const [text, setText] = useState<string | null>(null);
    const [err, setErr] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            if (!isSecurePayload(message.content)) return;
            if (!mayDecryptAuthor(message.author.id)) {
                setErr("author blacklisted / not allowlisted");
                return;
            }
            try {
                const plain = await decryptText(message.content, settings.store.passphrase);
                if (!cancelled) {
                    setText(plain);
                    setErr(null);
                }
            } catch (e) {
                if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
            }
        })();
        return () => { cancelled = true; };
    }, [message.id, message.content, settings.store.passphrase]);

    if (!isSecurePayload(message.content)) return null;

    return (
        <div style={{
            marginTop: 4,
            padding: "6px 8px",
            borderRadius: 8,
            background: "var(--background-secondary)",
            borderLeft: "3px solid var(--status-positive, #23a55a)"
        }}>
            <Forms.FormText style={{ fontSize: 11, opacity: 0.7, marginBottom: 2 }}>
                SecureChat decrypted
            </Forms.FormText>
            {text != null && (
                <Forms.FormText style={{ whiteSpace: "pre-wrap", userSelect: "text" }}>{text}</Forms.FormText>
            )}
            {err && (
                <Forms.FormText style={{ color: "var(--status-danger)" }}>
                    decrypt failed: {err}
                </Forms.FormText>
            )}
            {!text && !err && <Forms.FormText>decrypting…</Forms.FormText>}
        </div>
    );
}

const EncryptButton: ChatBarButtonFactory = ({ isMainChat }) => {
    const [on, setOn] = useState(sessionEncrypt ?? settings.store.autoEncrypt);
    if (!isMainChat || !settings.store.showLockButton) return null;
    return (
        <ChatBarButton
            tooltip={on ? "SecureChat encrypt ON" : "SecureChat encrypt OFF"}
            onClick={() => {
                const next = !on;
                sessionEncrypt = next;
                setOn(next);
                showToast({
                    text: next ? "SecureChat encrypt ON" : "SecureChat encrypt OFF",
                    variant: "info"
                });
            }}
        >
            <svg width="20" height="20" viewBox="0 0 24 24">
                <path
                    fill="currentColor"
                    d={on
                        ? "M12 1a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V6a5 5 0 0 0-5-5Zm3 8H9V6a3 3 0 1 1 6 0v3Z"
                        : "M12 1a5 5 0 0 0-5 5v1h2V6a3 3 0 1 1 6 0v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V6a5 5 0 0 0-5-5Z"}
                />
            </svg>
        </ChatBarButton>
    );
};

export default definePlugin({
    name: "SecureChat",
    description: "Encrypt/decrypt chat with a shared passphrase. Auto-decrypt when the peer has SecureChat and is not blacklisted.",
    authors: [Author],
    tags: ["Privacy", "Chat"],
    dependencies: ["MessageEventsAPI", "ChatInputButtonAPI", "MessageAccessoriesAPI"],
    settings,

    async onBeforeMessageSend(channelId, msg) {
        if (!wantsEncrypt(channelId)) return;
        if (!msg.content?.trim()) return;
        if (isSecurePayload(msg.content)) return;
        if (!settings.store.passphrase) {
            showToast({ text: "SecureChat: set a passphrase in plugin settings", variant: "critical" });
            return { cancel: true };
        }
        try {
            msg.content = await encryptText(msg.content, settings.store.passphrase);
        } catch (e) {
            showToast({ text: `SecureChat encrypt failed: ${e}`, variant: "critical" });
            return { cancel: true };
        }
    },

    renderMessageAccessory: ErrorBoundary.wrap(
        (props: { message: Message; }) => <DecryptedAccessory message={props.message} />,
        { noop: true }
    ),

    chatBarButton: {
        icon: () => (
            <svg width="20" height="20" viewBox="0 0 24 24">
                <path fill="currentColor" d="M12 1a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V6a5 5 0 0 0-5-5Z" />
            </svg>
        ),
        render: EncryptButton
    },

    start() {
        sessionEncrypt = null;
    },

    stop() {
        sessionEncrypt = null;
    }
});
