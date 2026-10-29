# Sernicord ~ A Better Vencord+ for devs & serniks
> <img width="300" height="501" alt="image" src="https://github.com/user-attachments/assets/f260d09d-a7bc-4b4a-8311-1f13f375f83e" />
> <img width="500" height="501" alt="image" src="https://github.com/user-attachments/assets/dc16b379-6518-4e3a-b002-7acf4d79b31a" />


Isolated Discord mod workspace with a universal sideloader. Default mode builds **Vencord (dev)** with every plugin under `plugins/`, injects into a **local** Discord profile, watches for changes, and launches.

System Discord and `~/.config/discord` stay untouched unless you deliberately pass `--system` (and confirm).

## Quick start

```sh
./sernicord          # or: ./sernicord menu
```

First run expects:

- `git`, `node` (≥18), `pnpm`, `rsync`, `python3`
- Official Linux Discord bootstrap under `discord-app/Discord/` (`updater_bootstrap` + `discord` launcher)
- Network access to clone [Vencord](https://github.com/Vendicated/Vencord) if `vencord/` is missing

Then:

1. Log in inside the **isolated** Discord window (profile lives under `data/`).
2. Edit plugins in `plugins/<Name>/` (synced into the target’s `src/userplugins/`).
3. Save → `pnpm watch` rebuilds → `Ctrl+R` in Discord.
4. Enable the plugin under **Settings → Vencord → Plugins**.

## Sideloader

```text
./sernicord [command] [options]
```

| Command | What it does |
| --- | --- |
| `dev` / default | Sync plugins → build (dev) → inject → watch → launch |
| `menu` | Interactive picker |
| `setup` | Clone target, install deps, prepare Discord |
| `sync-plugins` | Copy `plugins/` → `<target>/src/userplugins/` |
| `build [--prod]` | One-shot build |
| `watch` | Rebuild on save |
| `inject` / `uninject` | Patch / unpatch the profile’s Discord |
| `launch` | Start isolated Discord for the profile |
| `fix` | Rebuild + reinject after Discord updates |
| `update` | `git pull` target + deps + rebuild + reinject |
| `doctor` | Toolchain, paths, injection, privacy fences |
| `status` / `stop` / `profiles` | Inspect or shut down |

Options: `--target vencord|equicord`, `--profile NAME`, `--channel stable|ptb|canary`, `--no-launch`, `--no-watch`, `--prod`, `-y`, `--system` (dangerous).

Examples:

```sh
./sernicord
./sernicord inject --profile alt
./sernicord update --target equicord
./sernicord fix
./sernicord doctor
```

`./dev.sh` remains a thin wrapper around `./sernicord`.

## Layout

| Path | Role | Published? |
| --- | --- | --- |
| `sernicord` | Universal sideloader | yes |
| `plugins/` | Your custom plugins (source of truth) | yes |
| `scripts/secret-scan.sh` | Pre-commit privacy guard | yes |
| `.githooks/pre-commit` | Blocks private paths/secrets | yes |
| `configs/` | Safe examples only | yes |
| `vencord/` / `equicord/` / `clients/` | Managed clones | **no** (local) |
| `discord-app/` | Official Discord bootstrap/client | **no** (local) |
| `data/` | Profiles, cookies, cache, watch logs | **no** (local) |

## Privacy (read this)

This tree is used while logged into a real Discord account. **Do not publish profile data.**

Never commit:

- `data/` (Cookies, Local Storage, LevelDB, sessions, caches)
- `discord-app/` binaries and downloaded `app-*` trees
- `vencord/` / other managed clones (`node_modules`, `dist`, nested `.git`)
- `vencord-settings-backup*.json`, live `settings.json`, tokens, `.env`, keys

Fences:

1. Fortress `.gitignore`
2. `scripts/secret-scan.sh` content + path checks
3. `.githooks/pre-commit` (enable with `git config core.hooksPath .githooks`)

```sh
./sernicord doctor    # verifies fences
```

## Plugins

Ship plugins in `plugins/<PluginName>/`. The sideloader syncs them into the active target before every build/watch/inject.

Bundled plugins:

| Plugin | Role |
| --- | --- |
| `helloDev` | Minimal reload stub |
| `localArchive` | Local archives |
| `secureChat` | E2E-ish chat encrypt/decrypt (shared passphrase) |
| `omniSearch` | Universal in-client search (`/omnisearch`) |
| `profileVault` | Favorite settings/plugins/themes profiles |
| `botLens` | Bot-token API browser GUI (no user-session swap) |
| `embedForge` | Custom embeds / interactive link buttons |
| `secretSentinel` | Pattern watcher; alerts stored locally |
| `megaDrop` | Large files via bashupload or chunk threads |

Upstream Vencord gitignores `src/userplugins`; Sernicord keeps the publishable copies here instead.

## Multiple clients / profiles

- **Targets:** `--target vencord` (default) or `equicord`
- **Profiles:** `--profile NAME` → isolated dirs under `data/profiles/<NAME>/` (default profile can use the legacy `data/config/` layout when present)
- **Channels:** `--channel stable|ptb|canary` for the standalone download
- **Fix loop:** when Discord self-updates and drops the patch → `./sernicord fix`

## License

Sideloader and Sernicord packaging: use under the same spirit as Vencord — plugin code follows **GPL-3.0-or-later** (see each plugin / upstream Vencord). Upstream Vencord remains Vendicated’s project; Sernicord is a workspace + tooling layer on top.
