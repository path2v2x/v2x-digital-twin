# path-rfs systemd deployment

Install `v2x-twin-server.service` on path-rfs after running the SimForge OSS vendor script and `pnpm install` in `/home/path/v2x-digital-twin`.

```bash
sudo install -m 0644 scripts/systemd/v2x-twin-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now v2x-twin-server.service
```

The checked-in unit runs as `path`. If the checkout belongs to Andrew Park's `jpark` account, change both `User` and `Group` to `jpark` before installing it. The service uses WebSocket port 8865 and HTTP port 8190 because the drive application owns 8765 and 8090 on path-rfs.

`TWIN_DETECTIONS_URL=http://127.0.0.1:8090/detections/latest` is a deployment placeholder for the local `path2v2x/co-perception` endpoint. Change it if co-perception is bound to another local port. `TWIN_CAMERA_URL_TEMPLATE` points at the local camera relay and substitutes `{channel}` with `ch1` through `ch4`.
