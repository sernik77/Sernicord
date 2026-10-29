/*
 * Sernicord SecretSentinel — watch chat for tokens/keys/emails; log alerts locally
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { showNotice } from "@api/Notices";
import definePlugin, { OptionType } from "@utils/types";
import {
    Button,
    FluxDispatcher,
    Forms,
    React,
    showToast,
    useEffect,
    UserStore,
    useState
} from "@webpack/common";

const Author = { name: "sernik", id: 0n };
const LOG_KEY = "SernicordSecretSentinelLog";

export type Alert = {
    id: string;
    ts: number;
    channelId: string;
    guildId?: string | null;
    messageId: string;
    authorId: string;
    authorTag: string;
    patternName: string;
    reason: string;
    matched: string;
    content: string;
};

type Pattern = { name: string; reason: string; source: string; flags?: string; };

const DEFAULT_PATTERNS: Pattern[] = [
    { name: "discord_user_token", reason: "Discord user token shape", source: "[\\w-]{24}\\.[\\w-]{6}\\.[\\w-]{25,}", flags: "" },
    { name: "discord_mfa_token", reason: "Discord MFA token", source: "mfa\\.[A-Za-z0-9_-]{20,}", flags: "" },
    { name: "discord_bot_token", reason: "Likely bot token paste", source: "Bot\\s+[A-Za-z0-9_\\-.]{50,}", flags: "" },
    { name: "github_pat", reason: "GitHub PAT", source: "gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}", flags: "" },
    { name: "aws_access_key", reason: "AWS access key id", source: "AKIA[0-9A-Z]{16}", flags: "" },
    { name: "slack_token", reason: "Slack token", source: "xox[baprs]-[A-Za-z0-9-]{10,}", flags: "" },
    { name: "private_key", reason: "PEM private key header", source: "-----BEGIN (?:RSA |OPENSSH |EC |OPENSSH )?PRIVATE KEY-----", flags: "" },
    { name: "email", reason: "Email address", source: "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}", flags: "" },
    { name: "jwt", reason: "JWT-like triple", source: "eyJ[A-Za-z0-9_-]+\\.eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+", flags: "" },
    { name: "openai_key", reason: "OpenAI-ish key", source: "sk-[A-Za-z0-9]{20,}", flags: "" },
];

export const settings = definePluginSettings({
    about: {
        type: OptionType.COMPONENT,
        component: () => (
            <Forms.FormText>
                Scans incoming/edited messages for secret-like patterns. Alerts and full message
                contents are saved <b>only locally</b> in DataStore for your review — nothing is uploaded.
                Tune patterns below. Disable noisy ones (email) if needed.
            </Forms.FormText>
        )
    },
    enabledPatterns: {
        type: OptionType.STRING,
        description: "Comma-separated pattern names to enable (empty = all defaults)",
        default: ""
    },
    customPatternsJson: {
        type: OptionType.STRING,
        description: 'Extra patterns JSON array: [{"name","reason","source","flags?"}]',
        default: "[]"
    },
    ignoreSelf: {
        type: OptionType.BOOLEAN,
        description: "Ignore your own messages",
        default: true
    },
    ignoreBots: {
        type: OptionType.BOOLEAN,
        description: "Ignore bot/webhook authors",
        default: false
    },
    channelBlacklist: {
        type: OptionType.STRING,
        description: "Channel IDs to skip",
        default: ""
    },
    toastOnHit: {
        type: OptionType.BOOLEAN,
        description: "Show toast on hit",
        default: true
    },
    noticeOnHit: {
        type: OptionType.BOOLEAN,
        description: "Show top notice on hit",
        default: false
    },
    maxLog: {
        type: OptionType.NUMBER,
        description: "Max stored alerts",
        default: 500
    },
    redactedPreview: {
        type: OptionType.BOOLEAN,
        description: "Redact middle of matched secret in toast/notice (full value still in local log)",
        default: true
    },
    viewer: {
        type: OptionType.COMPONENT,
        component: () => <AlertViewer />
    }
});

function parseIdList(raw: string): Set<string> {
    return new Set(String(raw || "").split(/[\s,;]+/).map(s => s.trim()).filter(Boolean));
}

function redact(s: string): string {
    if (s.length < 10) return "***";
    return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function activePatterns(): Pattern[] {
    let custom: Pattern[] = [];
    try {
        custom = JSON.parse(settings.store.customPatternsJson || "[]");
        if (!Array.isArray(custom)) custom = [];
    } catch {
        custom = [];
    }
    const all = [...DEFAULT_PATTERNS, ...custom];
    const enabled = parseIdList(settings.store.enabledPatterns);
    if (!enabled.size) return all;
    return all.filter(p => enabled.has(p.name));
}

async function loadLog(): Promise<Alert[]> {
    return (await DataStore.get<Alert[]>(LOG_KEY)) ?? [];
}

async function pushAlert(alert: Alert) {
    const max = settings.store.maxLog || 500;
    const log = await loadLog();
    log.unshift(alert);
    while (log.length > max) log.pop();
    await DataStore.set(LOG_KEY, log);
}

function AlertViewer() {
    const [log, setLog] = useState<Alert[]>([]);
    const refresh = async () => setLog(await loadLog());
    useEffect(() => { refresh(); }, []);

    return (
        <div>
            <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <Button size={Button.Sizes.SMALL} onClick={refresh}>Refresh</Button>
                <Button
                    size={Button.Sizes.SMALL}
                    color={Button.Colors.RED}
                    look={Button.Looks.OUTLINED}
                    onClick={async () => {
                        await DataStore.set(LOG_KEY, []);
                        await refresh();
                        showToast({ text: "SecretSentinel log cleared", variant: "info" });
                    }}
                >
                    Clear log
                </Button>
                <Button
                    size={Button.Sizes.SMALL}
                    look={Button.Looks.OUTLINED}
                    onClick={async () => {
                        const data = JSON.stringify(await loadLog(), null, 2);
                        const bytes = new TextEncoder().encode(data);
                        if (IS_DISCORD_DESKTOP) {
                            DiscordNative.fileManager.saveWithDialog(bytes, `secret-sentinel-${Date.now()}.json`);
                        } else {
                            const { saveFile } = await import("@utils/web");
                            saveFile(new File([data], `secret-sentinel-${Date.now()}.json`, { type: "application/json" }));
                        }
                    }}
                >
                    Export JSON
                </Button>
            </div>
            {!log.length && <Forms.FormText>No alerts yet.</Forms.FormText>}
            {log.slice(0, 50).map(a => (
                <div key={a.id} style={{ padding: 8, marginBottom: 6, background: "var(--background-secondary)", borderRadius: 8 }}>
                    <Forms.FormText style={{ fontSize: 12, opacity: 0.75 }}>
                        {new Date(a.ts).toLocaleString()} · {a.patternName} · {a.authorTag} · #{a.channelId}
                    </Forms.FormText>
                    <Forms.FormText><b>{a.reason}</b> → <code>{a.matched}</code></Forms.FormText>
                    <Forms.FormText style={{ whiteSpace: "pre-wrap", userSelect: "text", fontSize: 12 }}>
                        {a.content.slice(0, 800)}
                    </Forms.FormText>
                </div>
            ))}
        </div>
    );
}

function scanMessage(message: any) {
    if (!message?.content || !message.id) return;
    if (settings.store.ignoreSelf && message.author?.id === UserStore.getCurrentUser()?.id) return;
    if (settings.store.ignoreBots && (message.author?.bot || message.webhookId)) return;
    if (parseIdList(settings.store.channelBlacklist).has(message.channel_id || message.channelId)) return;

    const channelId = message.channel_id || message.channelId;
    const content = String(message.content);
    for (const p of activePatterns()) {
        let re: RegExp;
        try {
            re = new RegExp(p.source, p.flags?.includes("g") ? p.flags : `${p.flags || ""}g`);
        } catch {
            continue;
        }
        re.lastIndex = 0;
        const m = re.exec(content);
        if (!m) continue;
        const matched = m[0];
        const alert: Alert = {
            id: `${message.id}-${p.name}-${m.index}`,
            ts: Date.now(),
            channelId,
            guildId: message.guild_id ?? null,
            messageId: message.id,
            authorId: message.author?.id ?? "?",
            authorTag: message.author?.username ?? "?",
            patternName: p.name,
            reason: p.reason,
            matched,
            content
        };
        void pushAlert(alert);
        const preview = settings.store.redactedPreview ? redact(matched) : matched;
        if (settings.store.toastOnHit) {
            showToast({ text: `SecretSentinel: ${p.name} (${preview})`, variant: "warning" });
        }
        if (settings.store.noticeOnHit) {
            showNotice(`SecretSentinel hit: ${p.reason}`, "Dismiss", () => { });
        }
        // one alert per pattern per message is enough for noise control; continue to next pattern
    }
}

function onDispatch(event: any) {
    if (event.type === "MESSAGE_CREATE" || event.type === "MESSAGE_UPDATE") {
        scanMessage(event.message);
    }
}

export default definePlugin({
    name: "SecretSentinel",
    description: "Watches chat for keys, tokens, emails, and custom patterns; saves full alerts locally for review.",
    authors: [Author],
    tags: ["Privacy", "Utility", "Notifications"],
    settings,

    start() {
        FluxDispatcher.subscribe("MESSAGE_CREATE", onDispatch);
        FluxDispatcher.subscribe("MESSAGE_UPDATE", onDispatch);
    },

    stop() {
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", onDispatch);
        FluxDispatcher.unsubscribe("MESSAGE_UPDATE", onDispatch);
    }
});
