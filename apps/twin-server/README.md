# twin-server

SimForge-native digital-twin server (WS :8765 `/drive` + `/twin`, MJPEG :8090).
Protocol: ../../docs/twin-protocol-v2.md. Engine consumed read-only from a
pinned worktree of SimForgeinc/simforge@22480b76 via pnpm file: deps
(see pnpm-workspace.yaml overrides).

Run: `pnpm install && pnpm dev` (needs the engine worktree at
/home/path/worktrees/twinserver-engine, built:
`pnpm --filter @simforge/training-env... build && pnpm --filter @simforge/maps... build`,
and the richmond-field-station map bundle at
/home/path/simforge-assets/map-bundles/richmond-field-station).
