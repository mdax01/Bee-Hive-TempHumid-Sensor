# Hive Environmental Monitor (RaspiMonitor)

A self-contained dashboard for monitoring beehive temperature and humidity using
[Govee H5074](https://www.govee.com/) Bluetooth Low Energy sensors. A Raspberry Pi
passively listens for the sensors' BLE broadcasts, logs readings to per-hive daily
CSV files, and serves a dark-themed web dashboard for live readings and historical
graphs (today, weekly, monthly, year-to-date), with a UI flow for registering newly
activated sensors — no code changes needed as you add more hives.

Repo: https://github.com/mdax01/Bee-Hive-TempHumid-Sensor

## How it works

- A single Python process runs a `bleak`-based BLE scanner in a background thread and
  a Flask web server in the foreground.
- Govee H5074 sensors broadcast manufacturer data every few seconds containing the
  current temperature, humidity, and battery level — no pairing or polling required.
- Each registered hive gets its own subdirectory (e.g. `Hive3/`) containing one CSV
  file per day (`2026-06-20.csv`). Rows are throttled to once every 5 minutes per
  hive (`WRITE_INTERVAL_SECONDS` in `app.py`) — that's already finer than the densest
  graph (10-minute buckets), so there's no value in logging every single advertisement.
- The dashboard reads those CSVs on demand to build the graphs; nothing is stored in
  a database.

## Requirements

- A Raspberry Pi (or any Linux box) with a Bluetooth adapter, running Raspberry Pi OS
  (or another Debian-based distro) with BlueZ.
- Python 3.9+.
- One or more Govee H5074 temperature/humidity sensors.

> **Other Govee models:** `decode_govee()` in `app.py` is written specifically for the
> H5074's manufacturer-data layout (2-byte company ID + 7-byte payload: reserved byte,
> signed int16 LE temp x0.01°C, uint16 LE humidity x0.01%, battery byte, reserved byte).
> Other models (H5075, H5177, etc.) use different layouts — capture a sample
> advertisement (see Troubleshooting below) and adjust the decoder if needed.

## Install

```bash
git clone https://github.com/mdax01/Bee-Hive-TempHumid-Sensor.git RaspiMonitor
cd RaspiMonitor

python3 -m venv venv
venv/bin/pip install -r requirements.txt
```

BLE scanning needs raw Bluetooth adapter access, which is simplest to get by running
the service as root (see the service file below) rather than fighting Linux
capabilities/BlueZ permission policy for a single-purpose appliance box.

### Run it once, in the foreground, to check it works

```bash
sudo venv/bin/python app.py
```

Visit `http://<pi-hostname>:5000/` in a browser. Press Ctrl+C once you've confirmed it
starts cleanly (check the log for `BLE scanner started` with no tracebacks).

### Install as a systemd service (auto-starts on boot)

```bash
sed "s/YOUR_USERNAME/$(whoami)/g" raspimonitor.service | sudo tee /etc/systemd/system/raspimonitor.service
sudo systemctl daemon-reload
sudo systemctl enable --now raspimonitor
sudo systemctl status raspimonitor
```

### Optional: passwordless sudo for routine maintenance

If you'll be restarting/checking the service often, add a narrowly-scoped sudoers rule
so you don't need a password for just those commands:

```bash
cat <<EOF | sudo tee /etc/sudoers.d/raspimonitor
$(whoami) ALL=(root) NOPASSWD: /usr/bin/systemctl start raspimonitor, /usr/bin/systemctl stop raspimonitor, /usr/bin/systemctl restart raspimonitor, /usr/bin/systemctl status raspimonitor, /usr/bin/journalctl -u raspimonitor *
EOF
sudo visudo -cf /etc/sudoers.d/raspimonitor   # validates syntax — run this BEFORE trusting the file
```

Note the `journalctl` rule has a trailing `*` (so extra flags like `-n 50` still match),
but the `systemctl status` rule does not — `sudo systemctl status raspimonitor` matches,
but adding `--no-pager` will not (sudoers requires an exact argument match unless a
rule ends in a wildcard).

## Usage

- Open `http://<pi-hostname>:5000/` (or `http://<pi-ip>:5000/`).
- Click **+ Add Sensor** (top right) to see any Govee H5074 sensors currently
  broadcasting nearby that aren't registered yet. Pick one and give it a hive name —
  it appears as a card immediately and starts logging. Already-registered sensors
  never reappear in that list. Cards and the comparison graph are ordered by the
  number in each hive's name (Hive 1, Hive 2, ...), not by when they were added.
- The **All Hives** chart at the top compares every hive on one graph — temperature by
  default, with a button (top right of that chart) to switch to humidity and back.
  Each hive gets a fixed color by its number (Hive 1 white, Hive 2 red, Hive 3 blue,
  Hive 4 green; later hives get an auto-generated color), labeled directly on its
  line. It defaults to today at 10-minute resolution; click it (or the **Weekly /
  Monthly / Year to Date** links below it) for a larger view across that range, all
  hives combined, same metric toggle.
- Each hive's own card shows a colored dot matching its line color on the All Hives
  graph, plus its current temp/humidity and a today-at-10-minutes graph with both
  temp (red) and humidity (blue) lines — all cards share the same y-axis scale so
  you can compare hives at a glance. Its own **Weekly / Monthly / Year to Date**
  links open a larger single-hive view.
- In any expanded view, use the **‹ ›** arrows on the sides of the chart to step
  back/forward through prior periods (previous day/week/month/year) — the forward
  arrow disables once you're back at the present. Click the **✕** to return to the
  dashboard.
- **Download Data** (below the cards): **Day / Month / Year** links each download one
  raw CSV per registered hive for that period. Browsers may ask permission the first
  time a page tries to trigger multiple downloads from one click — that's expected
  for more than one hive. If you've exposed the dashboard to the internet (e.g. via a
  Cloudflare Tunnel), these three endpoints are password-protected (see below) so
  they can't be hammered by anyone with the URL; your browser will show its native
  login prompt the first time you click one and remember it for the session.
- **Log** (bottom right, left of Info): pick a hive to view, add, or manage logged
  events for it — e.g. "Opened Entrance 2", with a date/time picker. Each hive's
  entries live in `ACTIONS.LOGGED` inside its own folder. Check **Show on Chart** on
  any entry to plot it as a vertical white line on that hive's own graphs (today,
  weekly, monthly, year-to-date) at the matching point in time; hovering the line
  shows just that entry's text, nothing else. Uncheck it later to remove the line.
  This only affects that one hive's single-hive graphs, not the All Hives comparison
  chart. Requires the same password as Download Data (see below).
- **Info** (bottom right): opens this README along with a link to the GitHub repo.
  Also requires the same password.

### Password-protecting Download Data, Info, and the hive logs

The main dashboard (live readings, all the graphs, Add Sensor) is intentionally open
— it's just readings. But data export, the README/Info page, and viewing or editing
a hive's logged events are all gated by one shared password, since `/api/export/*`
does real file I/O per request and the log endpoints let you write data, both worth
locking down if you've put the Pi on the public internet. Only checked ("Show on
Chart") log entries are exposed unauthenticated, via a separate read-only endpoint —
that's the one piece of log data the public dashboard's own graphs need to render.

The password is never stored in source or sent to the browser — only a one-way hash
lives on disk, in a gitignored file the app reads at startup:

```bash
venv/bin/python -c "from werkzeug.security import generate_password_hash; print(generate_password_hash('your-password-here'))" > .export_auth_hash
chmod 600 .export_auth_hash
sudo systemctl restart raspimonitor
```

If `.export_auth_hash` doesn't exist, the export routes simply refuse all requests
(fail closed) rather than silently allowing unauthenticated access.

## Data files

```
RaspiMonitor/
  sensors.json       # mac -> {name, folder, added} registry (created on first run)
  Hive3/
    2026-06-20.csv    # timestamp,temp_f,hum,batt — one file per day, append-only
    2026-06-21.csv
    ACTIONS.LOGGED    # JSON array of {id, timestamp, text, show_on_chart} entries
  Hive4/
    ...
```

`sensors.json` and the per-hive folders are runtime data (gitignored) — back them up
separately if you want to preserve history.

## Troubleshooting

- **No sensors show up in Add Sensor:** confirm the sensor's battery isn't dead and
  it's within BLE range (check `journalctl -u raspimonitor -f` for `BLE scanner
  started` and no repeated crash/retry messages). Signal strength varies a lot with
  distance/obstructions — a sensor on the edge of range may only report every few
  minutes instead of every 10-30 seconds.
- **`PermissionError` on the BLE adapter:** the process needs root (or properly
  configured capabilities + `bluetooth` group membership). Running the systemd
  service as `root` (as shipped) avoids this entirely.
- **Capturing a sensor's raw advertisement** (useful if adapting `decode_govee()` for
  a different model): temporarily add a log line in `ble_detection_callback()` in
  `app.py` printing `device.address`, the resolved `name`, and
  `advertisement_data.manufacturer_data`, restart the service, and check
  `journalctl -u raspimonitor -f`.
