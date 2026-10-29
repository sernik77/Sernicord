/*
 * Sernicord ProfileVault — save / favorite / switch Vencord settings+plugins+themes profiles
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { definePluginSettings, PlainSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import {
    Button,
    Forms,
    React,
    showToast,
    TextInput,
    useEffect,
    useState
} from "@webpack/common";

const Author = { name: "sernik", id: 0n };
const STORE_KEY = "SernicordProfileVault";

type VaultEntry = {
    name: string;
    favorite?: boolean;
    createdAt: number;
    updatedAt: number;
    note?: string;
    payload: {
        settings: any;
        quickCss: string;
    };
};

type Vault = { entries: VaultEntry[]; };

async function loadVault(): Promise<Vault> {
    return (await DataStore.get<Vault>(STORE_KEY)) ?? { entries: [] };
}

async function saveVault(v: Vault) {
    await DataStore.set(STORE_KEY, v);
}

async function snapshotCurrent(): Promise<VaultEntry["payload"]> {
    const settings = typeof VencordNative !== "undefined"
        ? VencordNative.settings.get()
        : structuredClone(PlainSettings);
    const quickCss = typeof VencordNative !== "undefined"
        ? await VencordNative.quickCss.get()
        : "";
    return { settings, quickCss };
}

async function applyPayload(payload: VaultEntry["payload"]) {
    if (!payload?.settings) throw new Error("Invalid profile payload");
    Object.assign(PlainSettings, payload.settings);
    if (typeof VencordNative !== "undefined") {
        await VencordNative.settings.set(payload.settings);
        await VencordNative.quickCss.set(payload.quickCss ?? "");
    }
}

function VaultPanel() {
    const [vault, setVault] = useState<Vault>({ entries: [] });
    const [name, setName] = useState("");
    const [note, setNote] = useState("");
    const [busy, setBusy] = useState(false);

    const refresh = async () => setVault(await loadVault());
    useEffect(() => { refresh(); }, []);

    const saveAs = async (favorite = false) => {
        const n = name.trim();
        if (!n) {
            showToast({ text: "Name required", variant: "critical" });
            return;
        }
        setBusy(true);
        try {
            const v = await loadVault();
            const payload = await snapshotCurrent();
            const existing = v.entries.find(e => e.name === n);
            if (existing) {
                existing.payload = payload;
                existing.updatedAt = Date.now();
                existing.note = note || existing.note;
                if (favorite) existing.favorite = true;
            } else {
                v.entries.push({
                    name: n,
                    favorite,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    note,
                    payload
                });
            }
            await saveVault(v);
            setName("");
            setNote("");
            await refresh();
            showToast({ text: `Saved profile "${n}"`, variant: "success" });
        } catch (e) {
            showToast({ text: String(e), variant: "critical" });
        } finally {
            setBusy(false);
        }
    };

    const activate = async (entry: VaultEntry) => {
        setBusy(true);
        try {
            await applyPayload(entry.payload);
            showToast({
                text: `Applied "${entry.name}". Restart / reload (Ctrl+R) for full effect.`,
                variant: "success"
            });
        } catch (e) {
            showToast({ text: String(e), variant: "critical" });
        } finally {
            setBusy(false);
        }
    };

    const toggleFav = async (entry: VaultEntry) => {
        const v = await loadVault();
        const e = v.entries.find(x => x.name === entry.name);
        if (!e) return;
        e.favorite = !e.favorite;
        await saveVault(v);
        await refresh();
    };

    const remove = async (entry: VaultEntry) => {
        const v = await loadVault();
        v.entries = v.entries.filter(x => x.name !== entry.name);
        await saveVault(v);
        await refresh();
        showToast({ text: `Deleted "${entry.name}"`, variant: "info" });
    };

    const exportOne = async (entry: VaultEntry) => {
        const blob = new Blob([JSON.stringify(entry, null, 2)], { type: "application/json" });
        const file = new File([blob], `sernicord-profile-${entry.name}.json`, { type: "application/json" });
        if (IS_DISCORD_DESKTOP) {
            const data = new TextEncoder().encode(JSON.stringify(entry, null, 2));
            DiscordNative.fileManager.saveWithDialog(data, file.name);
        } else {
            const { saveFile } = await import("@utils/web");
            saveFile(file);
        }
    };

    const sorted = [...vault.entries].sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || b.updatedAt - a.updatedAt);

    return (
        <div>
            <Forms.FormText style={{ marginBottom: 8 }}>
                Snapshots include plugin enablement, plugin settings, themes, theme links, and QuickCSS.
                Profiles stay in local DataStore (not cloud). Reload Discord after switching.
            </Forms.FormText>
            <TextInput placeholder="Profile name" value={name} onChange={setName} />
            <div style={{ height: 8 }} />
            <TextInput placeholder="Optional note" value={note} onChange={setNote} />
            <div style={{ display: "flex", gap: 8, marginTop: 8, marginBottom: 16 }}>
                <Button disabled={busy} onClick={() => saveAs(false)}>Save / Update</Button>
                <Button disabled={busy} color={Button.Colors.GREEN} onClick={() => saveAs(true)}>Save as Favorite</Button>
            </div>
            {sorted.length === 0 && <Forms.FormText>No profiles yet.</Forms.FormText>}
            {sorted.map(entry => (
                <div
                    key={entry.name}
                    style={{
                        padding: 10,
                        marginBottom: 8,
                        borderRadius: 8,
                        background: "var(--background-secondary)",
                        border: entry.favorite ? "1px solid var(--status-positive)" : "1px solid transparent"
                    }}
                >
                    <Forms.FormTitle tag="h5" style={{ margin: 0 }}>
                        {entry.favorite ? "★ " : ""}{entry.name}
                    </Forms.FormTitle>
                    <Forms.FormText style={{ fontSize: 12, opacity: 0.75 }}>
                        updated {new Date(entry.updatedAt).toLocaleString()}
                        {entry.note ? ` — ${entry.note}` : ""}
                    </Forms.FormText>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                        <Button size={Button.Sizes.SMALL} disabled={busy} onClick={() => activate(entry)}>Switch</Button>
                        <Button size={Button.Sizes.SMALL} look={Button.Looks.OUTLINED} onClick={() => toggleFav(entry)}>
                            {entry.favorite ? "Unfavorite" : "Favorite"}
                        </Button>
                        <Button size={Button.Sizes.SMALL} look={Button.Looks.OUTLINED} onClick={() => exportOne(entry)}>Export</Button>
                        <Button size={Button.Sizes.SMALL} color={Button.Colors.RED} look={Button.Looks.OUTLINED} onClick={() => remove(entry)}>Delete</Button>
                    </div>
                </div>
            ))}
        </div>
    );
}

export const settings = definePluginSettings({
    manager: {
        type: OptionType.COMPONENT,
        component: () => <VaultPanel />
    }
});

export default definePlugin({
    name: "ProfileVault",
    description: "Save Vencord/Sernicord config, plugins, themes, and QuickCSS as named favorites and switch between them.",
    authors: [Author],
    tags: ["Utility", "Customisation", "Organisation"],
    settings
});
