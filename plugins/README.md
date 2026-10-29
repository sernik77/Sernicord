# Sernicord plugins

Each subdirectory is a Vencord-style userplugin. `./sernicord` copies them into
`<target>/src/userplugins/` before build / watch / inject.

Conventions:

- Folder name = plugin id path (e.g. `helloDev/`)
- Entry: `index.ts` or `index.tsx`
- Use `definePlugin` from `@utils/types`
- Keep secrets out of plugin source (no tokens, no personal IDs hard-coded for your main account)

Bundled plugins:

| Plugin | Role |
| --- | --- |
| `helloDev` | Minimal reload-friendly stub |
| `localArchive` | Local channel/DM/server archive tooling |
| `secureChat` | Shared-passphrase AES-GCM encrypt/decrypt + blacklist |
| `omniSearch` | One field across servers/channels/friends/messages/plugins/settings |
| `profileVault` | Save/favorite/switch settings+plugins+themes profiles |
| `botLens` | Browse as a **bot** via API GUI (does not swap your user login) |
| `embedForge` | Webhook embeds / link buttons / markdown cards (`/embed`) |
| `secretSentinel` | Local-only watcher for tokens/keys/emails + custom patterns |
| `megaDrop` | Huge files via bashupload or peer chunk threads |

Local-only experiments can live directly under a cloned target’s `src/userplugins/`;
only what you put here is meant for the public Sernicord repo.
