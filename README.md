# Hive Environmental Monitor (RaspiMonitor)

A self-contained dashboard for monitoring beehive temperature and humidity using
[Govee H5074](https://www.govee.com/) Bluetooth Low Energy sensors. A Raspberry Pi
passively listens for the sensors' BLE broadcasts, logs readings to per-hive daily
CSV files, and serves a dark-themed web dashboard for live readings and historical
graphs (today, weekly, monthly, year-to-date), with a UI flow for registering newly
activated sensors — no code changes needed as you add more hives.

## How it works

- A single Python process runs a `bleak`-based BLE scanner in a background thread and
  a Flask web server in the foreground.
- Govee H5074 sensors broadcast manufacturer data every few seconds containing the
  current temperature, humidity, and battery level — no pairing or polling required.
- Each registered hive gets its own subdirectory (e.g. `Hive3/`) containing one CSV
  file per day (`2026-06-20.csv`) with raw `timestamp,temp_f,hum,batt` rows.
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
git clone <your-repo-url> RaspiMonitor
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
  never reappear in that list.
- Each card shows the hive's current temp/humidity and an hour-by-hour graph for
  today. **Weekly / Monthly / Year to Date** links open a larger view for that range;
  click the **✕** to return to the dashboard.
- The chart above the cards compares every hive's week-over-week temperature (shades
  of red) and humidity (shades of blue) on one graph, each line labeled by hive name.

## Data files

```
RaspiMonitor/
  sensors.json       # mac -> {name, folder, added} registry (created on first run)
  Hive3/
    2026-06-20.csv    # timestamp,temp_f,hum,batt — one file per day, append-only
    2026-06-21.csv
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
