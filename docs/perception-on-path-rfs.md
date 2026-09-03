# Co-perception on path-rfs

The production process runs as user `path` from `/home/path/co-perception` on the PR #5 branch (`feat/detections-http-endpoint`). The deployment uses Python 3.12, torch 2.9.1+cu128, and PyNvVideoCodec 2.2.2. `torch.cuda.is_available()` reports `True` on the RTX 5080. MobileNetV3-small weights are pre-cached in `/home/path/.cache/torch/hub/checkpoints`.

## Install and operate

```bash
git clone https://github.com/path2v2x/co-perception.git /home/path/co-perception
cd /home/path/co-perception
git fetch https://github.com/michaelvu1207/co-perception.git feat/detections-http-endpoint
git checkout -b feat/detections-http-endpoint FETCH_HEAD
python3.12 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt

sudo install -d -o path -g path /var/lib/v2x-perception
sudo install -m 0644 /home/path/v2x-digital-twin/scripts/systemd/v2x-perception.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now v2x-perception.service
```

The tracked configuration subscribes to the four world-connectable compressed-camera sockets with GPU decode, publishes latest calibrated detections only on `127.0.0.1:8091`, batches non-empty detection frames to the AWS write API, and reserves `/var/lib/v2x-perception` for the final JSON output. The annotated-frame broadcast is disabled so this process never claims `/tmp/coperception_output.sock`.

Useful checks:

```bash
systemctl status v2x-perception
curl -sS http://127.0.0.1:8091/health
curl -sS http://127.0.0.1:8091/detections/latest
journalctl -u v2x-perception -f
```

## Measured production setting

The final setting is `imgsz: 1280`, `target_fps: 10`. An 11-minute soak on 2026-09-03 held 10.00 synchronized four-camera batches/s in consecutive 30-second log windows, with no service restart. The process used 2,297,308 KiB RSS and 2,700 MiB VRAM. CARLA simultaneously used 9,889 MiB VRAM; the GPU had 2,746 MiB free, above the 1.5 GiB guard. The CARLA RPC/map watchdog probe and `v2x-drive.service` both remained healthy, so reducing resolution or target rate was unnecessary.

A trimmed post-soak response was:

```json
{"cameras":{"ch1":{"ts":1788420026.668,"detections":[]},"ch2":{"ts":1788420026.670,"detections":[]},"ch3":{"ts":1788420026.666,"detections":[]},"ch4":{"ts":1788420026.672,"detections":[]}}}
```

All four calibrated capture clocks updated continuously. At this sample they were about 3.8 seconds behind wall time: approximately 2.6 seconds was upstream camera/demux latency and the remainder was inference/publication latency. Do not replace these capture timestamps with publication time.

The campus was empty throughout the soak, so every camera returned an empty detection array and no non-empty AWS batch POST was generated. Consequently `/detections/recent?limit=3` still showed the prior 2026-09-01 record; a later visible car/person will produce an `Uploaded batch of ... detections.` journal line and a current API record.

The 04:00 `v2x-nightly-restart` stops and starts only the CARLA container and `v2x-drive.service`; it does not stop the camera demux sockets or this service. CARLA releases its allocation before reacquiring it, and `Restart=always` recovers perception if an independent GPU/runtime failure occurs, so no extra restart ordering is required.

A clean deployment exposed the GPU decoder binding missing from co-perception's requirements. The required fix is pushed to the PR #5 head as `cfa1d5f` and recorded on the PR.
