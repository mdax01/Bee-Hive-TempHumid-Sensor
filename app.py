import os
import re
import csv
import json
import logging
import threading
import time
import asyncio
from datetime import datetime, date, timedelta

from flask import Flask, jsonify, request, render_template
from bleak import BleakScanner

logging.basicConfig(
    format='%(asctime)s.%(msecs)03d - %(name)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S',
    level=logging.INFO)
log = logging.getLogger("raspimonitor")
logging.getLogger("bleak").setLevel(logging.WARNING)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SENSORS_FILE = os.path.join(BASE_DIR, "sensors.json")
DISCOVERY_TTL_SECONDS = 300
WATCHDOG_TIMEOUT_SECONDS = 90

app = Flask(__name__)

lock = threading.Lock()
sensors = {}    # mac -> {name, folder, added}
latest = {}     # mac -> {temp_f, hum, batt, last_seen}
discovery = {}  # mac -> {raw_name, last_seen} for every Govee device seen recently
last_written = {}  # mac -> last raw payload written to a hive's CSV, for dedup
last_advertisement_ts = time.time()


def load_sensors():
    global sensors
    if os.path.exists(SENSORS_FILE):
        with open(SENSORS_FILE, "r") as f:
            sensors = json.load(f)
    else:
        sensors = {}


def save_sensors():
    with open(SENSORS_FILE, "w") as f:
        json.dump(sensors, f, indent=2)


def sanitize_folder(name):
    base = re.sub(r'[^A-Za-z0-9]', '', name) or "Hive"
    existing = {v["folder"] for v in sensors.values()}
    folder = base
    n = 2
    while folder in existing:
        folder = f"{base}_{n}"
        n += 1
    return folder


def c2f(val):
    return round(32 + 9 * val / 5, 2)


def decode_govee(name, mfg_data, mac):
    # H5074 manufacturer data = 2-byte company id + 7-byte payload:
    # payload[0] reserved, [1:3] temp_c as little-endian signed int16 (x0.01),
    # [3:5] humidity as little-endian uint16 (x0.01), [5] battery %, [6] reserved.
    if mfg_data is None or name is None or "H5074" not in name or len(mfg_data) < 8:
        return None

    payload = mfg_data[2:]
    temp_c = int.from_bytes(payload[1:3], "little", signed=True) / 100
    hum = int.from_bytes(payload[3:5], "little") / 100
    battery = payload[5]

    temp_f = c2f(temp_c)
    if temp_f > 180.0 or temp_f < -30.0:
        return None

    raw_key = bytes(payload)
    return mac, name, temp_f, hum, battery, raw_key


def write_reading(folder, temp_f, hum, batt, ts):
    hive_dir = os.path.join(BASE_DIR, folder)
    os.makedirs(hive_dir, exist_ok=True)
    day_file = os.path.join(hive_dir, f"{ts.strftime('%Y-%m-%d')}.csv")
    is_new = not os.path.exists(day_file)
    with open(day_file, "a", newline="") as f:
        writer = csv.writer(f)
        if is_new:
            writer.writerow(["timestamp", "temp_f", "hum", "batt"])
        writer.writerow([ts.isoformat(timespec="seconds"), temp_f, hum, batt])


def handle_govee_reading(mac, name, mfg_data):
    try:
        decoded = decode_govee(name, mfg_data, mac)
        if decoded is None:
            return
        mac, raw_name, temp_f, hum, batt, raw_key = decoded
        now = time.time()

        with lock:
            discovery[mac] = {"raw_name": raw_name, "last_seen": now}
            latest[mac] = {"temp_f": temp_f, "hum": hum, "batt": batt, "last_seen": now}
            hive = sensors.get(mac)
            # last_written is scoped separately from discovery/latest so a value
            # already seen before a hive was registered still gets its first write.
            should_write = hive is not None and last_written.get(mac) != raw_key
            if should_write:
                last_written[mac] = raw_key

        if should_write:
            write_reading(hive["folder"], temp_f, hum, batt, datetime.now())
            log.info(f"{hive['name']} ({mac}) temp={temp_f}F hum={hum}% batt={batt}%")
    except Exception:
        log.exception("error handling BLE advertisement")


def ble_detection_callback(device, advertisement_data):
    global last_advertisement_ts
    last_advertisement_ts = time.time()
    name = advertisement_data.local_name or device.name
    for company_id, data in (advertisement_data.manufacturer_data or {}).items():
        # bleak strips the 2-byte company-id prefix into the dict key; put it back
        # so the slicing offsets (lifted from the original BLE decoder) still line up.
        mfg_data = company_id.to_bytes(2, "little") + data
        handle_govee_reading(device.address, name, mfg_data)


async def _scan_forever():
    global last_advertisement_ts
    last_advertisement_ts = time.time()
    async with BleakScanner(ble_detection_callback):
        log.info("BLE scanner started")
        while True:
            await asyncio.sleep(10)
            if time.time() - last_advertisement_ts > WATCHDOG_TIMEOUT_SECONDS:
                raise RuntimeError("no BLE advertisements seen recently, restarting scanner")


def run_observer():
    while True:
        try:
            asyncio.run(_scan_forever())
        except Exception:
            log.exception("BLE scanner crashed, retrying in 15s")
            time.sleep(15)


def prune_discovery():
    cutoff = time.time() - DISCOVERY_TTL_SECONDS
    for mac in [m for m, v in discovery.items() if v["last_seen"] < cutoff]:
        del discovery[mac]


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/hives")
def api_hives():
    with lock:
        result = [
            {
                "mac": mac,
                "name": info["name"],
                "folder": info["folder"],
                "temp_f": latest.get(mac, {}).get("temp_f"),
                "hum": latest.get(mac, {}).get("hum"),
                "batt": latest.get(mac, {}).get("batt"),
                "last_seen": latest.get(mac, {}).get("last_seen"),
            }
            for mac, info in sensors.items()
        ]
    result.sort(key=lambda h: h["name"])
    return jsonify(result)


@app.route("/api/discover")
def api_discover():
    with lock:
        prune_discovery()
        result = [
            {"mac": mac, "raw_name": v["raw_name"]}
            for mac, v in discovery.items() if mac not in sensors
        ]
    return jsonify(result)


@app.route("/api/hives", methods=["POST"])
def api_add_hive():
    body = request.get_json(silent=True) or {}
    mac = (body.get("mac") or "").strip()
    name = (body.get("name") or "").strip()
    if not mac or not name:
        return jsonify({"error": "mac and name are required"}), 400

    with lock:
        if mac in sensors:
            return jsonify({"error": "sensor already registered"}), 400
        folder = sanitize_folder(name)
        sensors[mac] = {
            "name": name,
            "folder": folder,
            "added": datetime.now().isoformat(timespec="seconds"),
        }
        save_sensors()

    os.makedirs(os.path.join(BASE_DIR, folder), exist_ok=True)
    return jsonify({"mac": mac, "name": name, "folder": folder}), 201


def read_day_rows(folder, day):
    path = os.path.join(BASE_DIR, folder, f"{day.strftime('%Y-%m-%d')}.csv")
    if not os.path.exists(path):
        return
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            try:
                yield row["timestamp"], float(row["temp_f"]), float(row["hum"])
            except (KeyError, TypeError, ValueError):
                continue


def read_daily_average(folder, day):
    temps, hums = [], []
    for _, t, h in read_day_rows(folder, day):
        temps.append(t)
        hums.append(h)
    if not temps:
        return None, None
    return round(sum(temps) / len(temps), 2), round(sum(hums) / len(hums), 2)


def read_hourly_series(folder, day):
    by_hour_temp = {h: [] for h in range(24)}
    by_hour_hum = {h: [] for h in range(24)}
    for timestamp, t, h in read_day_rows(folder, day):
        try:
            hour = int(timestamp[11:13])
        except (ValueError, IndexError):
            continue
        by_hour_temp[hour].append(t)
        by_hour_hum[hour].append(h)

    labels, temp, hum = [], [], []
    for hour in range(24):
        labels.append(str(hour))
        temp.append(round(sum(by_hour_temp[hour]) / len(by_hour_temp[hour]), 2) if by_hour_temp[hour] else None)
        hum.append(round(sum(by_hour_hum[hour]) / len(by_hour_hum[hour]), 2) if by_hour_hum[hour] else None)
    return labels, temp, hum


def history_range(folder, rng):
    today = date.today()
    if rng == "today":
        return read_hourly_series(folder, today)

    if rng == "month":
        start = today.replace(day=1)
    elif rng == "ytd":
        start = date(today.year, 1, 1)
    else:
        start = today - timedelta(days=6)

    labels, temp, hum = [], [], []
    d = start
    while d <= today:
        t, h = read_daily_average(folder, d)
        labels.append(d.isoformat())
        temp.append(t)
        hum.append(h)
        d += timedelta(days=1)
    return labels, temp, hum


@app.route("/api/history/<folder>")
def api_history(folder):
    rng = request.args.get("range", "today")
    labels, temp, hum = history_range(folder, rng)
    return jsonify({"labels": labels, "temp": temp, "hum": hum})


def main():
    load_sensors()
    threading.Thread(target=run_observer, daemon=True).start()
    from waitress import serve
    serve(app, host="0.0.0.0", port=5000)


if __name__ == "__main__":
    main()
