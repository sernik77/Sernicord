# Sernicord plugins

Each subdirectory is a Vencord-style userplugin. `./sernicord` copies them into
`<target>/src/userplugins/` before build / watch / inject.

Conventions:

- Folder name = plugin id path (e.g. `helloDev/`)
- Entry: `index.ts` or `index.tsx`
- Use `definePlugin` from `@utils/types`
- Keep secrets out of plugin source (no tokens, no personal IDs hard-coded for your main account)

Local-only experiments can live directly under a cloned target’s `src/userplugins/`;
only what you put here is meant for the public Sernicord repo.
