import os
import re
import csv
import json
import logging
import threading
import time
import asyncio
import calendar
import uuid
from datetime import datetime, date, timedelta

from functools import wraps

import markdown
from flask import Flask, jsonify, request, render_template, Response, url_for
from werkzeug.security import check_password_hash
from bleak import BleakScanner

logging.basicConfig(
    format='%(asctime)s.%(msecs)03d - %(name)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S',
    level=logging.INFO)
log = logging.getLogger("raspimonitor")
logging.getLogger("bleak").setLevel(logging.WARNING)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SENSORS_FILE = os.path.join(BASE_DIR, "sensors.json")
README_PATH = os.path.join(BASE_DIR, "README.md")
EXPORT_AUTH_FILE = os.path.join(BASE_DIR, ".export_auth_hash")
GITHUB_REPO_URL = "https://github.com/mdax01/Bee-Hive-TempHumid-Sensor"
LOG_FILENAME = "ACTIONS.LOGGED"
DISCOVERY_TTL_SECONDS = 300
WATCHDOG_TIMEOUT_SECONDS = 90
WRITE_INTERVAL_SECONDS = 5 * 60  # CSV writes are throttled to this cadence per hive

# These admin-ish endpoints (data export, the README/info page, and viewing or
# editing hive logs) are reachable from the internet (e.g. via a Cloudflare
# Tunnel), so they're gated by a password whose hash lives in a local, gitignored
# file — never in source, never sent to the browser. Missing file = disabled.
def load_export_password_hash():
    if os.path.exists(EXPORT_AUTH_FILE):
        with open(EXPORT_AUTH_FILE) as f:
            return f.read().strip()
    return None


EXPORT_PASSWORD_HASH = load_export_password_hash()


def require_admin_auth(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not EXPORT_PASSWORD_HASH:
            return jsonify({"error": "admin password not configured"}), 401
        auth = request.authorization
        if not auth or not check_password_hash(EXPORT_PASSWORD_HASH, auth.password):
            return Response(
                "Authentication required", 401,
                {"WWW-Authenticate": 'Basic realm="RaspiMonitor admin"'},
            )
        return view(*args, **kwargs)
    return wrapped

app = Flask(__name__)
# Static files default to a long browser cache lifetime, which causes stale
# HTML/CSS/JS mismatches after a deploy. Assets here are tiny and change
# rarely enough that always revalidating is the safer default.
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0


@app.template_global()
def asset_url(filename):
    # Appends the file's mtime as a version tag so every deploy gets a brand
    # new URL — this defeats caching at any layer (browser, Cloudflare, etc.)
    # without needing to disable caching everywhere, since the old URL simply
    # stops being referenced once the file (and its mtime) changes.
    path = os.path.join(app.static_folder, filename)
    try:
        version = int(os.path.getmtime(path))
    except OSError:
        version = 0
    return f"{url_for('static', filename=filename)}?v={version}"


lock = threading.Lock()
sensors = {}    # mac -> {name, folder, added}
latest = {}     # mac -> {temp_f, hum, batt, last_seen}
discovery = {}  # mac -> {raw_name, last_seen} for every Govee device seen recently
last_written_at = {}  # mac -> unix time of last CSV write, for write-rate throttling
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

    return mac, name, temp_f, hum, battery


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
        mac, raw_name, temp_f, hum, batt = decoded
        now = time.time()

        with lock:
            discovery[mac] = {"raw_name": raw_name, "last_seen": now}
            latest[mac] = {"temp_f": temp_f, "hum": hum, "batt": batt, "last_seen": now}
            hive = sensors.get(mac)
            # Raw advertisements arrive every 10-30s, far finer than any graph
            # needs (the densest view buckets to 10 minutes), so writes are
            # throttled per hive rather than on every changed reading.
            should_write = hive is not None and (now - last_written_at.get(mac, 0)) >= WRITE_INTERVAL_SECONDS
            if should_write:
                last_written_at[mac] = now

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


@app.route("/info")
@require_admin_auth
def info():
    readme_html = ""
    if os.path.exists(README_PATH):
        with open(README_PATH) as f:
            readme_html = markdown.markdown(f.read(), extensions=["fenced_code", "tables"])
    return render_template("info.html", readme_html=readme_html, repo_url=GITHUB_REPO_URL)


def hive_sort_key(name):
    match = re.search(r"\d+", name)
    return (0, int(match.group())) if match else (1, name)


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
    result.sort(key=lambda h: hive_sort_key(h["name"]))
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


TODAY_BUCKET_MINUTES = 10


def read_bucketed_series(folder, day, bucket_minutes):
    total_buckets = (24 * 60) // bucket_minutes
    by_bucket_temp = {b: [] for b in range(total_buckets)}
    by_bucket_hum = {b: [] for b in range(total_buckets)}
    for timestamp, t, h in read_day_rows(folder, day):
        try:
            hour, minute = int(timestamp[11:13]), int(timestamp[14:16])
        except (ValueError, IndexError):
            continue
        bucket = (hour * 60 + minute) // bucket_minutes
        by_bucket_temp[bucket].append(t)
        by_bucket_hum[bucket].append(h)

    labels, temp, hum = [], [], []
    for b in range(total_buckets):
        hour, minute = divmod(b * bucket_minutes, 60)
        labels.append(f"{hour:02d}:{minute:02d}")
        temp.append(round(sum(by_bucket_temp[b]) / len(by_bucket_temp[b]), 2) if by_bucket_temp[b] else None)
        hum.append(round(sum(by_bucket_hum[b]) / len(by_bucket_hum[b]), 2) if by_bucket_hum[b] else None)
    return labels, temp, hum


MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
               "July", "August", "September", "October", "November", "December"]


def shifted_month(today, offset):
    month_index = today.year * 12 + (today.month - 1) - offset
    year, month0 = divmod(month_index, 12)
    return year, month0 + 1


def history_range(folder, rng, offset=0):
    today = date.today()

    if rng == "today":
        target = today - timedelta(days=offset)
        labels, temp, hum = read_bucketed_series(folder, target, TODAY_BUCKET_MINUTES)
        label = f"{MONTH_NAMES[target.month - 1]} {target.day}, {target.year}"
        return labels, temp, hum, label

    if rng == "week":
        end = today - timedelta(days=7 * offset)
        start = end - timedelta(days=6)
        label = (f"{MONTH_NAMES[start.month - 1][:3]} {start.day} – "
                 f"{MONTH_NAMES[end.month - 1][:3]} {end.day}, {end.year}")
    elif rng == "month":
        year, month = shifted_month(today, offset)
        start = date(year, month, 1)
        month_end = date(year, month, calendar.monthrange(year, month)[1])
        end = min(today, month_end) if offset == 0 else month_end
        label = f"{MONTH_NAMES[month - 1]} {year}"
    elif rng == "ytd":
        year = today.year - offset
        start = date(year, 1, 1)
        end = today if offset == 0 else date(year, 12, 31)
        label = str(year)
    else:
        return [], [], [], ""

    labels, temp, hum = [], [], []
    d = start
    while d <= end:
        t, h = read_daily_average(folder, d)
        labels.append(d.isoformat())
        temp.append(t)
        hum.append(h)
        d += timedelta(days=1)
    return labels, temp, hum, label


def is_known_folder(folder):
    return any(info["folder"] == folder for info in sensors.values())


@app.route("/api/history/<folder>")
def api_history(folder):
    if not is_known_folder(folder):
        return jsonify({"error": "unknown hive folder"}), 404
    rng = request.args.get("range", "today")
    try:
        offset = max(0, int(request.args.get("offset", 0)))
    except ValueError:
        offset = 0
    labels, temp, hum, label = history_range(folder, rng, offset)
    response = {"labels": labels, "temp": temp, "hum": hum, "label": label}
    if rng == "today":
        # Lets the frontend confirm a log entry actually happened on the date
        # being shown, not just at a matching time-of-day on some other date.
        response["date"] = (date.today() - timedelta(days=offset)).isoformat()
    return jsonify(response)


@app.route("/api/export/<folder>")
@require_admin_auth
def api_export(folder):
    if not is_known_folder(folder):
        return jsonify({"error": "unknown hive folder"}), 404

    rng = request.args.get("range", "day")
    today = date.today()
    if rng == "year":
        start = date(today.year, 1, 1)
    elif rng == "month":
        start = today.replace(day=1)
    else:
        start = today

    lines = ["timestamp,temp_f,hum,batt"]
    d = start
    while d <= today:
        path = os.path.join(BASE_DIR, folder, f"{d.strftime('%Y-%m-%d')}.csv")
        if os.path.exists(path):
            with open(path) as f:
                lines.extend(f.read().splitlines()[1:])
        d += timedelta(days=1)

    filename = f"{folder}_{rng}_{today.isoformat()}.csv"
    return Response(
        "\n".join(lines) + "\n",
        mimetype="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def logs_path(folder):
    return os.path.join(BASE_DIR, folder, LOG_FILENAME)


def read_logs(folder):
    path = logs_path(folder)
    if not os.path.exists(path):
        return []
    try:
        with open(path) as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return []


def write_logs(folder, entries):
    hive_dir = os.path.join(BASE_DIR, folder)
    os.makedirs(hive_dir, exist_ok=True)
    with open(logs_path(folder), "w") as f:
        json.dump(entries, f, indent=2)


@app.route("/api/logs/<folder>/chart")
def api_logs_chart(folder):
    # Public and unauthenticated on purpose: checking "Show on Chart" is the
    # user's own choice to surface that one entry on the (otherwise public)
    # dashboard graphs, so only checked entries' timestamp/text are exposed here.
    if not is_known_folder(folder):
        return jsonify({"error": "unknown hive folder"}), 404
    visible = [e for e in read_logs(folder) if e.get("show_on_chart")]
    return jsonify([{"timestamp": e["timestamp"], "text": e["text"]} for e in visible])


@app.route("/api/logs/<folder>")
@require_admin_auth
def api_logs_list(folder):
    if not is_known_folder(folder):
        return jsonify({"error": "unknown hive folder"}), 404
    entries = sorted(read_logs(folder), key=lambda e: e["timestamp"], reverse=True)
    return jsonify(entries)


@app.route("/api/logs/<folder>", methods=["POST"])
@require_admin_auth
def api_logs_create(folder):
    if not is_known_folder(folder):
        return jsonify({"error": "unknown hive folder"}), 404
    body = request.get_json(silent=True) or {}
    timestamp = (body.get("timestamp") or "").strip()
    text = (body.get("text") or "").strip()
    if not timestamp or not text:
        return jsonify({"error": "timestamp and text are required"}), 400

    entries = read_logs(folder)
    entry = {"id": uuid.uuid4().hex[:8], "timestamp": timestamp, "text": text, "show_on_chart": False}
    entries.append(entry)
    write_logs(folder, entries)
    return jsonify(entry), 201


@app.route("/api/logs/<folder>/<entry_id>", methods=["PATCH"])
@require_admin_auth
def api_logs_update(folder, entry_id):
    if not is_known_folder(folder):
        return jsonify({"error": "unknown hive folder"}), 404
    body = request.get_json(silent=True) or {}

    entries = read_logs(folder)
    for entry in entries:
        if entry["id"] == entry_id:
            if "show_on_chart" in body:
                entry["show_on_chart"] = bool(body["show_on_chart"])
            write_logs(folder, entries)
            return jsonify(entry)
    return jsonify({"error": "entry not found"}), 404


@app.route("/log/<folder>")
@require_admin_auth
def log_page(folder):
    if not is_known_folder(folder):
        return "Unknown hive", 404
    hive_name = next((info["name"] for info in sensors.values() if info["folder"] == folder), folder)
    return render_template("log.html", folder=folder, hive_name=hive_name)


def main():
    load_sensors()
    threading.Thread(target=run_observer, daemon=True).start()
    from waitress import serve
    serve(app, host="0.0.0.0", port=5000)


if __name__ == "__main__":
    main()
