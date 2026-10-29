/*
 * Sernicord OmniSearch — one field to search channels, users, guilds, messages, plugins, settings
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, sendBotMessage } from "@api/Commands";
import { Settings, definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import {
    Button,
    ChannelRouter,
    ChannelStore,
    Forms,
    GuildStore,
    MessageStore,
    Modal,
    NavigationRouter,
    openModal,
    openUserProfileModal,
    RelationshipStore,
    showToast,
    TextInput,
    useMemo,
    UserStore,
    useState
} from "@webpack/common";

const Author = { name: "sernik", id: 0n };

export const settings = definePluginSettings({
    about: {
        type: OptionType.COMPONENT,
        component: () => (
            <Forms.FormText>
                Run <code>/omnisearch</code> or use the Vencord toolbox. Searches loaded messages,
                channels, DMs, friends, servers, plugins, and setting keys in the client.
            </Forms.FormText>
        )
    },
    maxResults: {
        type: OptionType.NUMBER,
        description: "Max results per category",
        default: 25
    },
    searchMessages: {
        type: OptionType.BOOLEAN,
        description: "Include currently loaded DM message cache",
        default: true
    },
    searchPlugins: {
        type: OptionType.BOOLEAN,
        description: "Include Vencord / Sernicord plugins",
        default: true
    },
    searchSettings: {
        type: OptionType.BOOLEAN,
        description: "Include settings key paths",
        default: true
    }
});

type Hit = {
    kind: string;
    title: string;
    subtitle?: string;
    action: () => void;
};

function score(q: string, ...parts: Array<string | undefined | null>): number {
    const needle = q.toLowerCase().trim();
    if (!needle) return 0;
    const hay = parts.filter(Boolean).join(" ").toLowerCase();
    if (!hay) return 0;
    if (hay === needle) return 100;
    if (hay.startsWith(needle)) return 80;
    if (hay.includes(needle)) return 50;
    const tokens = needle.split(/\s+/);
    if (tokens.every(t => hay.includes(t))) return 40;
    return 0;
}

function listChannels(): any[] {
    const out: any[] = [];
    try {
        const priv = (ChannelStore as any).getSortedPrivateChannels?.() ?? [];
        out.push(...priv);
    } catch { /* */ }
    try {
        for (const g of Object.values(GuildStore.getGuilds())) {
            const chans = (ChannelStore as any).getMutableGuildChannelsForGuild?.(g.id)
                ?? (ChannelStore as any).getGuildChannels?.(g.id);
            if (!chans) continue;
            const list = Array.isArray(chans) ? chans : Object.values(chans);
            for (const c of list as any[]) if (c?.id) out.push(c);
        }
    } catch { /* */ }
    return out;
}

function collect(query: string): Hit[] {
    const limit = settings.store.maxResults;
    const hits: Array<Hit & { s: number; }> = [];

    for (const g of Object.values(GuildStore.getGuilds())) {
        const s = score(query, g.name, g.id, (g as any).description);
        if (s) hits.push({
            kind: "Server",
            title: g.name,
            subtitle: g.id,
            s,
            action: () => NavigationRouter.transitionToGuild(g.id)
        });
    }

    for (const ch of listChannels()) {
        const s = score(query, ch.name, ch.id, ch.topic);
        if (!s) continue;
        hits.push({
            kind: ch.guild_id ? "Channel" : "DM",
            title: ch.name || ch.id,
            subtitle: ch.guild_id ? `${GuildStore.getGuild(ch.guild_id)?.name ?? "server"} · ${ch.id}` : ch.id,
            s,
            action: () => ChannelRouter.transitionToChannel(ch.id)
        });
    }

    for (const id of RelationshipStore.getFriendIDs()) {
        const u = UserStore.getUser(id);
        if (!u) continue;
        const s = score(query, u.username, u.globalName, u.id);
        if (!s) continue;
        hits.push({
            kind: "Friend",
            title: u.globalName || u.username,
            subtitle: `@${u.username} · ${u.id}`,
            s,
            action: () => openUserProfileModal({ userId: u.id })
        });
    }

    if (settings.store.searchMessages) {
        try {
            for (const ch of ((ChannelStore as any).getSortedPrivateChannels?.() ?? [])) {
                const msgs = MessageStore.getMessages?.(ch.id);
                const arr = (msgs as any)?._array ?? (msgs as any)?.toArray?.() ?? [];
                for (const m of arr) {
                    const s = score(query, m.content, m.author?.username, m.id);
                    if (!s) continue;
                    hits.push({
                        kind: "Message",
                        title: (m.content || "[embed/attachment]").slice(0, 120),
                        subtitle: `${m.author?.username ?? "?"} · #${ch.id}`,
                        s: s - 5,
                        action: () => ChannelRouter.transitionToChannel(ch.id)
                    });
                }
            }
        } catch { /* */ }
    }

    if (settings.store.searchPlugins) {
        try {
            const plugins = (Vencord as any).Plugins?.plugins ?? {};
            for (const [name, p] of Object.entries(plugins) as [string, any][]) {
                const s = score(query, name, p.description, ...(p.tags ?? []), ...(p.searchTerms ?? []));
                if (!s) continue;
                hits.push({
                    kind: "Plugin",
                    title: name,
                    subtitle: p.description,
                    s,
                    action: () => showToast({
                        text: `${name}: ${p.started ? "running" : "stopped"} — open Vencord settings → Plugins`,
                        variant: "info"
                    })
                });
            }
        } catch { /* */ }
    }

    if (settings.store.searchSettings) {
        const walk = (obj: any, path: string, depth: number) => {
            if (!obj || typeof obj !== "object" || depth > 3) return;
            for (const [k, v] of Object.entries(obj)) {
                if (["__proto__", "constructor", "prototype"].includes(k)) continue;
                const p = path ? `${path}.${k}` : k;
                const s = score(query, p, typeof v === "string" ? v : k);
                if (s) hits.push({
                    kind: "Setting",
                    title: p,
                    subtitle: typeof v === "object" ? "{…}" : String(v).slice(0, 80),
                    s: s - 10,
                    action: () => showToast({ text: `Setting: ${p}`, variant: "info" })
                });
                if (typeof v === "object") walk(v, p, depth + 1);
            }
        };
        try { walk(Settings, "", 0); } catch { /* */ }
    }

    hits.sort((a, b) => b.s - a.s);
    const perKind = new Map<string, number>();
    const out: Hit[] = [];
    for (const h of hits) {
        const n = perKind.get(h.kind) ?? 0;
        if (n >= limit) continue;
        perKind.set(h.kind, n + 1);
        out.push(h);
        if (out.length >= limit * 6) break;
    }
    return out;
}

function OmniModal({ modalProps }: { modalProps: any; }) {
    const [q, setQ] = useState("");
    const results = useMemo(() => (q.trim().length >= 2 ? collect(q) : []), [q]);

    return (
        <Modal.ModalRoot {...modalProps} size={Modal.ModalSize.MEDIUM}>
            <Modal.ModalHeader>
                <Forms.FormTitle tag="h2">OmniSearch</Forms.FormTitle>
                <Modal.ModalCloseButton onClick={modalProps.onClose} />
            </Modal.ModalHeader>
            <Modal.ModalContent>
                <TextInput
                    value={q}
                    placeholder="Search everywhere…"
                    onChange={setQ}
                    autoFocus
                />
                <div style={{ marginTop: 12, maxHeight: 420, overflow: "auto" }}>
                    {q.trim().length < 2 && <Forms.FormText>Type at least 2 characters.</Forms.FormText>}
                    {results.map((r, i) => (
                        <Button
                            key={i}
                            look={Button.Looks.LINK}
                            style={{ display: "block", width: "100%", textAlign: "left", marginBottom: 4 }}
                            onClick={() => {
                                r.action();
                                modalProps.onClose();
                            }}
                        >
                            <strong>[{r.kind}]</strong> {r.title}
                            {r.subtitle && <div style={{ opacity: 0.7, fontSize: 12 }}>{r.subtitle}</div>}
                        </Button>
                    ))}
                    {q.trim().length >= 2 && results.length === 0 && (
                        <Forms.FormText>No hits in currently loaded client data.</Forms.FormText>
                    )}
                </div>
            </Modal.ModalContent>
        </Modal.ModalRoot>
    );
}

export function openOmniSearch() {
    openModal(props => <OmniModal modalProps={props} />);
}

export default definePlugin({
    name: "OmniSearch",
    description: "One search field for servers, channels, DMs, friends, loaded messages, plugins, and settings.",
    authors: [Author],
    tags: ["Utility", "Organisation", "Shortcuts"],
    settings,
    commands: [{
        name: "omnisearch",
        description: "Open OmniSearch",
        inputType: ApplicationCommandInputType.BUILT_IN,
        execute: (_args, ctx) => {
            openOmniSearch();
            sendBotMessage(ctx.channel.id, { content: "OmniSearch opened." });
        }
    }],
    toolboxActions: {
        "OmniSearch": openOmniSearch
    }
});
