/*
 * Sernicord BotLens — browse Discord as a bot via API (separate GUI, does not swap your user session)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, sendBotMessage } from "@api/Commands";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import {
    Button,
    Forms,
    Modal,
    openModal,
    React,
    ScrollerThin,
    showToast,
    TextInput,
    useEffect,
    useState
} from "@webpack/common";

const Author = { name: "sernik", id: 0n };
const API = "https://discord.com/api/v10";

export const settings = definePluginSettings({
    about: {
        type: OptionType.COMPONENT,
        component: () => (
            <Forms.FormText>
                Opens a read-oriented Bot Lens panel that calls the Discord API with a <b>bot</b> token.
                It does <b>not</b> replace your logged-in user session. Self-botting / user-token abuse is
                out of scope and blocked. Keep tokens out of cloud sync and public repos. Discord ToS still applies.
            </Forms.FormText>
        )
    },
    botToken: {
        type: OptionType.STRING,
        description: "Bot token (stored in local plugin settings — do not cloud-sync)",
        default: "",
        placeholder: "MTIz..."
    }
});

function looksLikeUserToken(token: string): boolean {
    // Classic user tokens are three base64-ish segments; bot tokens often too, so we also probe /users/@me with Bot prefix.
    // Block MFA user token prefix patterns and explicit "user" pastes that include email-like first segment decode.
    if (/^mfa\./i.test(token)) return true;
    return false;
}

async function botFetch(path: string, token: string, init: RequestInit = {}) {
    const res = await fetch(`${API}${path}`, {
        ...init,
        headers: {
            Authorization: `Bot ${token}`,
            "Content-Type": "application/json",
            ...(init.headers || {})
        }
    });
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`${res.status} ${res.statusText} ${body.slice(0, 200)}`);
    }
    if (res.status === 204) return null;
    return res.json();
}

function BotLensModal({ modalProps }: { modalProps: any; }) {
    const [token, setToken] = useState(settings.store.botToken || "");
    const [me, setMe] = useState<any>(null);
    const [guilds, setGuilds] = useState<any[]>([]);
    const [channels, setChannels] = useState<any[]>([]);
    const [messages, setMessages] = useState<any[]>([]);
    const [guildId, setGuildId] = useState<string | null>(null);
    const [channelId, setChannelId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const connect = async () => {
        setBusy(true);
        setError(null);
        try {
            const t = token.trim();
            if (!t) throw new Error("Paste a bot token");
            if (looksLikeUserToken(t)) throw new Error("Refusing MFA/user-style token. Bot tokens only.");
            const user = await botFetch("/users/@me", t);
            if (user && user.bot === false) {
                throw new Error("Token belongs to a user account. BotLens only accepts bot tokens.");
            }
            setMe(user);
            const g = await botFetch("/users/@me/guilds", t);
            setGuilds(Array.isArray(g) ? g : []);
            settings.store.botToken = t;
            showToast({ text: `BotLens: logged API as ${user.username}`, variant: "success" });
        } catch (e) {
            setMe(null);
            setError(String(e));
        } finally {
            setBusy(false);
        }
    };

    const loadChannels = async (gid: string) => {
        setGuildId(gid);
        setChannelId(null);
        setMessages([]);
        setBusy(true);
        setError(null);
        try {
            const ch = await botFetch(`/guilds/${gid}/channels`, token.trim());
            const textish = (Array.isArray(ch) ? ch : [])
                .filter((c: any) => [0, 5, 10, 11, 12].includes(c.type))
                .sort((a: any, b: any) => (a.position ?? 0) - (b.position ?? 0));
            setChannels(textish);
        } catch (e) {
            setError(String(e));
        } finally {
            setBusy(false);
        }
    };

    const loadMessages = async (cid: string) => {
        setChannelId(cid);
        setBusy(true);
        setError(null);
        try {
            const msgs = await botFetch(`/channels/${cid}/messages?limit=50`, token.trim());
            setMessages(Array.isArray(msgs) ? msgs : []);
        } catch (e) {
            setError(String(e));
        } finally {
            setBusy(false);
        }
    };

    useEffect(() => {
        if (settings.store.botToken) setToken(settings.store.botToken);
    }, []);

    return (
        <Modal.ModalRoot {...modalProps} size={Modal.ModalSize.LARGE}>
            <Modal.ModalHeader>
                <Forms.FormTitle tag="h2">BotLens</Forms.FormTitle>
                <Modal.ModalCloseButton onClick={modalProps.onClose} />
            </Modal.ModalHeader>
            <Modal.ModalContent>
                <Forms.FormText style={{ marginBottom: 8 }}>
                    Separate bot API browser. Your normal Discord account stays untouched.
                </Forms.FormText>
                <TextInput
                    type="password"
                    value={token}
                    placeholder="Bot token"
                    onChange={setToken}
                />
                <div style={{ display: "flex", gap: 8, marginTop: 8, marginBottom: 12 }}>
                    <Button disabled={busy} onClick={connect}>Connect</Button>
                    {me && <Forms.FormText>@{me.username} ({me.id}) bot={String(me.bot)}</Forms.FormText>}
                </div>
                {error && <Forms.FormText style={{ color: "var(--status-danger)" }}>{error}</Forms.FormText>}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1.4fr", gap: 8, minHeight: 360 }}>
                    <ScrollerThin style={{ background: "var(--background-secondary)", borderRadius: 8, padding: 8 }}>
                        <Forms.FormTitle tag="h5">Guilds</Forms.FormTitle>
                        {guilds.map(g => (
                            <Button
                                key={g.id}
                                size={Button.Sizes.SMALL}
                                look={guildId === g.id ? Button.Looks.FILLED : Button.Looks.LINK}
                                style={{ display: "block", width: "100%", textAlign: "left" }}
                                onClick={() => loadChannels(g.id)}
                            >
                                {g.name}
                            </Button>
                        ))}
                    </ScrollerThin>
                    <ScrollerThin style={{ background: "var(--background-secondary)", borderRadius: 8, padding: 8 }}>
                        <Forms.FormTitle tag="h5">Channels</Forms.FormTitle>
                        {channels.map(c => (
                            <Button
                                key={c.id}
                                size={Button.Sizes.SMALL}
                                look={channelId === c.id ? Button.Looks.FILLED : Button.Looks.LINK}
                                style={{ display: "block", width: "100%", textAlign: "left" }}
                                onClick={() => loadMessages(c.id)}
                            >
                                #{c.name}
                            </Button>
                        ))}
                    </ScrollerThin>
                    <ScrollerThin style={{ background: "var(--background-secondary)", borderRadius: 8, padding: 8 }}>
                        <Forms.FormTitle tag="h5">Messages</Forms.FormTitle>
                        {messages.map(m => (
                            <div key={m.id} style={{ marginBottom: 10, paddingBottom: 8, borderBottom: "1px solid var(--background-modifier-accent)" }}>
                                <Forms.FormText style={{ fontSize: 12, opacity: 0.7 }}>
                                    {m.author?.username} · {m.timestamp}
                                </Forms.FormText>
                                <Forms.FormText style={{ whiteSpace: "pre-wrap", userSelect: "text" }}>
                                    {m.content || (m.attachments?.length ? `[${m.attachments.length} attachment(s)]` : "[empty/embed]")}
                                </Forms.FormText>
                            </div>
                        ))}
                        {!messages.length && <Forms.FormText>Select a channel.</Forms.FormText>}
                    </ScrollerThin>
                </div>
            </Modal.ModalContent>
        </Modal.ModalRoot>
    );
}

export function openBotLens() {
    openModal(props => <BotLensModal modalProps={props} />);
}

export default definePlugin({
    name: "BotLens",
    description: "Paste a bot token and browse that bot's guilds/channels/messages in a GUI panel (does not swap your user login).",
    authors: [Author],
    tags: ["Developers", "Utility"],
    settings,
    toolboxActions: {
        "Open BotLens": openBotLens
    },
    commands: [{
        name: "botlens",
        description: "Open BotLens panel",
        inputType: ApplicationCommandInputType.BUILT_IN,
        execute: (_a, ctx) => {
            openBotLens();
            sendBotMessage(ctx.channel.id, { content: "BotLens opened." });
        }
    }]
});
