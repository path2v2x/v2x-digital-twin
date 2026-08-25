# Surviving V2X systemd units

The SimForge twin itself is started from the repository root with `pnpm dev`.
That command owns twin-server (`:8765`, `:8090`) and twin-web (`:5188`). The
retired simulator, Python drive bridge, dashboard, hourly restart, and frontend
link-repair units are not part of this directory.

The remaining units support the independent live perception pipeline and
optional Cloudflare transports:

| Unit | Purpose |
|---|---|
| `v2x-perception.service` | Four-camera live ingestion and detection |
| `v2x-cloudflared-drive.service` | Optional transport to twin-server `:8765` |
| `v2x-cloudflared-perception.service` | Optional transport to perception/twin MJPEG `:8090` |

`v2x-perception.env.example` documents the perception service environment.
Install only the units needed by the host:

```bash
sudo install -m 0644 scripts/systemd/v2x-perception.service /etc/systemd/system/
sudo install -m 0644 scripts/systemd/v2x-perception.env.example /etc/v2x-perception.env
sudo install -m 0644 scripts/systemd/v2x-cloudflared-drive.service /etc/systemd/system/
sudo install -m 0644 scripts/systemd/v2x-cloudflared-perception.service /etc/systemd/system/
sudo systemctl daemon-reload
```

Do not install units from older revisions: they target paths and processes that
no longer exist. See `../../docs/twin-protocol-v2.md` for the active `/drive`
and `/twin` transports.
