const POLL_MS = 20000;
const charts = {}; // folder -> mini Chart instance
let overlayChart = null;
let compareChart = null;
let lastHives = [];
let lastTodayData = [];

function fmt(val) {
  return (val === null || val === undefined) ? "—" : val;
}

function hiveColor(hue, index) {
  const lightness = Math.min(45 + index * 14, 82);
  return `hsl(${hue}, 75%, ${lightness}%)`;
}

// Fixed colors by hive number (parsed from the name) for the All Hives graph,
// so a given hive is always the same color regardless of metric/order.
const FIXED_HIVE_COLORS = ["#ffffff", "#ff3b30", "#2979ff", "#34c759"];

function hiveNumber(name) {
  const m = /\d+/.exec(name);
  return m ? parseInt(m[0], 10) : null;
}

function hiveFixedColor(name, fallbackIndex) {
  const n = hiveNumber(name);
  if (n && FIXED_HIVE_COLORS[n - 1]) return FIXED_HIVE_COLORS[n - 1];
  return hiveColor(280, fallbackIndex);
}

let compareMetric = "temp";

function tickFormatterFor(range, rawLabels) {
  if (range === "today") {
    return (value, index) => rawLabels[index] ?? "";
  }
  if (range === "ytd") {
    return (value, index) => {
      const iso = rawLabels[index];
      if (!iso) return "";
      return new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", { month: "short" });
    };
  }
  return (value, index) => {
    const iso = rawLabels[index];
    if (!iso) return "";
    return String(new Date(`${iso}T00:00:00`).getDate());
  };
}

// Draws each dataset's label past the right axis, clear of its tick labels,
// at the line's last value (so it doesn't collide with axis tick text).
const lineEndLabelPlugin = {
  id: "lineEndLabel",
  afterDatasetsDraw(chart) {
    const { ctx } = chart;
    const labelX = chart.chartArea.right + (chart.scales.yHum ? chart.scales.yHum.width : 0) + 10;
    chart.data.datasets.forEach((dataset, i) => {
      const meta = chart.getDatasetMeta(i);
      if (meta.hidden) return;
      let point = null;
      for (let j = meta.data.length - 1; j >= 0; j--) {
        if (dataset.data[j] !== null && dataset.data[j] !== undefined) {
          point = meta.data[j];
          break;
        }
      }
      if (!point) return;
      ctx.save();
      ctx.font = "600 11px -apple-system, sans-serif";
      ctx.fillStyle = dataset.borderColor;
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      ctx.fillText(dataset.label, labelX, point.y);
      ctx.restore();
    });
  },
};

// Maps a log entry's timestamp onto the same discrete buckets the chart already
// uses (10-min buckets for "today", calendar days otherwise), so its vertical
// line lines up with the data point it actually happened near.
function eventIndexForRange(rawLabels, range, isoTimestamp) {
  if (range === "today") {
    const [hh, mm] = isoTimestamp.slice(11, 16).split(":").map(Number);
    const bucket = Math.floor((hh * 60 + mm) / 10) * 10;
    const label = `${String(Math.floor(bucket / 60)).padStart(2, "0")}:${String(bucket % 60).padStart(2, "0")}`;
    return rawLabels.indexOf(label);
  }
  return rawLabels.indexOf(isoTimestamp.slice(0, 10));
}

function buildEventMarkerDataset(rawLabels, range, events) {
  const textByIndex = {};
  const data = rawLabels.map(() => null);
  (events || []).forEach((ev) => {
    const idx = eventIndexForRange(rawLabels, range, ev.timestamp);
    if (idx === -1) return;
    data[idx] = 0;
    textByIndex[idx] = ev.text;
  });
  return {
    textByIndex,
    dataset: {
      label: "Event",
      isEventMarker: true,
      data,
      borderColor: "transparent",
      backgroundColor: "transparent",
      pointRadius: 0,
      pointHoverRadius: 6,
      pointHitRadius: 10,
      showLine: false,
      yAxisID: "yEvent",
      spanGaps: false,
    },
  };
}

// Draws a vertical line at each logged event's bucket. The marker dataset
// itself is invisible (radius 0) — this plugin does the actual drawing —
// and only exists so Chart.js's normal tooltip/hover machinery can surface
// the event text without a second, separate hover system.
const eventLinePlugin = {
  id: "eventLine",
  afterDraw(chart) {
    const dsIndex = chart.data.datasets.findIndex((d) => d.isEventMarker);
    if (dsIndex === -1) return;
    const meta = chart.getDatasetMeta(dsIndex);
    const { ctx, chartArea } = chart;
    chart.data.datasets[dsIndex].data.forEach((value, i) => {
      if (value === null || value === undefined) return;
      const point = meta.data[i];
      if (!point) return;
      ctx.save();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(point.x, chartArea.top);
      ctx.lineTo(point.x, chartArea.bottom);
      ctx.stroke();
      ctx.restore();
    });
  },
};

function buildLineConfig(rawLabels, temp, hum, range, opts) {
  opts = opts || {};
  const datasets = [
    {
      label: "Temp (°F)",
      data: temp,
      borderColor: "#ff3b30",
      backgroundColor: "transparent",
      yAxisID: "yTemp",
      spanGaps: false,
      tension: 0.25,
      pointRadius: opts.pointRadius ?? 2,
    },
    {
      label: "Humidity (%)",
      data: hum,
      borderColor: "#2979ff",
      backgroundColor: "transparent",
      yAxisID: "yHum",
      spanGaps: false,
      tension: 0.25,
      pointRadius: opts.pointRadius ?? 2,
    },
  ];

  const scales = {
    x: { ticks: { color: "#8fa0c0", callback: tickFormatterFor(range, rawLabels) }, grid: { color: "#1c2c4d" } },
    yTemp: { position: "left", ticks: { color: "#ff3b30" }, grid: { color: "#1c2c4d" } },
    yHum: { position: "right", ticks: { color: "#2979ff" }, grid: { display: false } },
  };

  let textByIndex = {};
  if (opts.events && opts.events.length) {
    const marker = buildEventMarkerDataset(rawLabels, range, opts.events);
    textByIndex = marker.textByIndex;
    datasets.push(marker.dataset);
    scales.yEvent = { display: false, min: -1, max: 1 };
  }

  return {
    type: "line",
    data: { labels: rawLabels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: !!opts.legend, labels: { color: "#e8edf7", filter: (item) => item.text !== "Event" } },
        tooltip: {
          filter: (item) => !(item.dataset.isEventMarker && (item.raw === null || item.raw === undefined)),
          callbacks: {
            label: (item) => (item.dataset.isEventMarker ? textByIndex[item.dataIndex] || "" : `${item.dataset.label}: ${item.formattedValue}`),
          },
        },
      },
      scales,
    },
    plugins: [eventLinePlugin],
  };
}

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `request failed: ${res.status}`);
  }
  return res.json();
}

function cardTemplate(hive) {
  const div = document.createElement("div");
  div.className = "card";
  div.dataset.folder = hive.folder;
  div.innerHTML = `
    <h2 class="hive-name"><span class="hive-dot"></span><span class="hive-name-label"></span></h2>
    <div class="readings">
      <span class="temp"></span>
      <span class="hum"></span>
    </div>
    <div class="mini-chart-wrap"><canvas></canvas></div>
    <div class="range-links">
      <a data-range="week">Weekly</a> · <a data-range="month">Monthly</a> · <a data-range="ytd">Year to Date</a>
    </div>
  `;
  div.querySelector(".mini-chart-wrap").addEventListener("click", () => {
    openOverlay(hive.folder, hive.name, "today");
  });
  div.querySelectorAll(".range-links a").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.stopPropagation();
      openOverlay(hive.folder, hive.name, a.dataset.range);
    });
  });
  return div;
}

function updateCard(div, hive, index) {
  div.querySelector(".hive-name-label").textContent = hive.name;
  div.querySelector(".hive-dot").style.backgroundColor = hiveFixedColor(hive.name, index);
  div.querySelector(".temp").innerHTML = `${fmt(hive.temp_f)}<span class="unit">°F</span>`;
  div.querySelector(".hum").innerHTML = `${fmt(hive.hum)}<span class="unit">%</span>`;
}

// Computes a shared, padded min/max across all hives' values for a metric, so
// every card's y-axis lines up and visual comparison between hives is direct.
function sharedRange(valueArrays) {
  const nums = [];
  for (const arr of valueArrays) {
    for (const v of arr) {
      if (v !== null && v !== undefined) nums.push(v);
    }
  }
  if (nums.length === 0) return null;
  let min = Math.min(...nums);
  let max = Math.max(...nums);
  if (min === max) { min -= 1; max += 1; }
  const pad = (max - min) * 0.08;
  return { min: Math.floor(min - pad), max: Math.ceil(max + pad) };
}

function applyRange(scaleOptions, range) {
  if (range) {
    scaleOptions.min = range.min;
    scaleOptions.max = range.max;
  } else {
    delete scaleOptions.min;
    delete scaleOptions.max;
  }
}

function renderMiniChart(div, hive, data, tempRange, humRange, events) {
  if (!data) return;
  const canvas = div.querySelector(".mini-chart-wrap canvas");
  // Whether the event-marker dataset is present can change poll to poll, so
  // the dataset shape isn't stable enough to patch in place — recreate instead.
  if (charts[hive.folder]) charts[hive.folder].destroy();
  const config = buildLineConfig(data.labels, data.temp, data.hum, "today", { events });
  applyRange(config.options.scales.yTemp, tempRange);
  applyRange(config.options.scales.yHum, humRange);
  charts[hive.folder] = new Chart(canvas, config);
}

function datasetsFromSeries(hives, series, metric) {
  let rawLabels = null;
  let label = "";
  const datasets = [];
  const axisId = metric === "hum" ? "yHum" : "yTemp";
  hives.forEach((hive, i) => {
    const data = series[i];
    if (!data) return;
    rawLabels = rawLabels || data.labels;
    label = label || data.label;
    datasets.push({
      label: hive.name,
      data: metric === "hum" ? data.hum : data.temp,
      borderColor: hiveFixedColor(hive.name, i),
      backgroundColor: "transparent",
      yAxisID: axisId,
      spanGaps: false,
      tension: 0.25,
      pointRadius: 2,
    });
  });
  return { rawLabels, datasets, label };
}

async function buildCompareSeries(hives, range, offset, metric) {
  const series = await Promise.all(
    hives.map((hive) => fetchJSON(`/api/history/${hive.folder}?range=${range}&offset=${offset}`).catch(() => null))
  );
  return datasetsFromSeries(hives, series, metric);
}

function compareChartOptions(rawLabels, range, metric) {
  const scales = {
    x: { ticks: { color: "#8fa0c0", callback: tickFormatterFor(range, rawLabels) }, grid: { color: "#1c2c4d" } },
  };
  if (metric === "hum") {
    scales.yHum = { position: "left", ticks: { color: "#2979ff" }, grid: { color: "#1c2c4d" } };
  } else {
    scales.yTemp = { position: "left", ticks: { color: "#ff3b30" }, grid: { color: "#1c2c4d" } };
  }
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    layout: { padding: { right: 70 } },
    interaction: { mode: "nearest", intersect: false },
    plugins: { legend: { display: false } },
    scales,
  };
}

const COMPARE_RANGE = "today";

function compareTitleText(metric) {
  return `All Hives ${metric === "hum" ? "Humidity" : "Temperature"}`;
}

function refreshCompareChart(hives, todayData) {
  const section = document.querySelector(".compare-section");
  if (hives.length === 0) {
    section.classList.add("hidden");
    return;
  }
  section.classList.remove("hidden");
  document.querySelector(".compare-title").textContent = compareTitleText(compareMetric);

  const { rawLabels, datasets } = datasetsFromSeries(hives, todayData, compareMetric);
  if (!rawLabels) return;

  if (compareChart) compareChart.destroy();
  compareChart = new Chart(document.getElementById("compareChart"), {
    type: "line",
    data: { labels: rawLabels, datasets },
    options: compareChartOptions(rawLabels, COMPARE_RANGE, compareMetric),
    plugins: [lineEndLabelPlugin],
  });
}

async function pollHives() {
  let hives;
  try {
    hives = await fetchJSON("/api/hives");
  } catch (e) {
    console.error("failed to load hives", e);
    return;
  }

  lastHives = hives;
  document.getElementById("exportHeader").classList.toggle("hidden", hives.length === 0);

  const todayData = await Promise.all(
    hives.map((hive) => fetchJSON(`/api/history/${hive.folder}?range=today`).catch(() => null))
  );
  lastTodayData = todayData;
  const eventsData = await Promise.all(
    hives.map((hive) => fetchJSON(`/api/logs/${hive.folder}/chart`).catch(() => []))
  );
  const tempRange = sharedRange(todayData.filter(Boolean).map((d) => d.temp));
  const humRange = sharedRange(todayData.filter(Boolean).map((d) => d.hum));

  const cardsEl = document.getElementById("cards");
  const seen = new Set();
  hives.forEach((hive, i) => {
    seen.add(hive.folder);
    let div = cardsEl.querySelector(`.card[data-folder="${hive.folder}"]`);
    if (!div) {
      div = cardTemplate(hive);
    }
    cardsEl.appendChild(div); // re-appending an existing node moves it, keeping DOM order in sync with hives' sort order
    updateCard(div, hive, i);
    renderMiniChart(div, hive, todayData[i], tempRange, humRange, eventsData[i]);
  });
  cardsEl.querySelectorAll(".card").forEach((div) => {
    if (!seen.has(div.dataset.folder)) div.remove();
  });
  refreshCompareChart(hives, todayData);
}

// ---- Add Sensor flow ----
const addSensorBtn = document.getElementById("addSensorBtn");
const discoverPanel = document.getElementById("discoverPanel");
const discoverSelect = document.getElementById("discoverSelect");
const discoverEmpty = document.getElementById("discoverEmpty");
const discoverChoose = document.getElementById("discoverChoose");
const discoverCancel = document.getElementById("discoverCancel");

async function openDiscoverPanel() {
  discoverPanel.classList.remove("hidden");
  discoverSelect.innerHTML = "";
  discoverEmpty.classList.add("hidden");
  discoverSelect.classList.remove("hidden");
  discoverChoose.disabled = true;

  let found = [];
  try {
    found = await fetchJSON("/api/discover");
  } catch (e) {
    console.error("failed to load discoverable sensors", e);
  }

  if (found.length === 0) {
    discoverSelect.classList.add("hidden");
    discoverEmpty.classList.remove("hidden");
    return;
  }
  for (const item of found) {
    const opt = document.createElement("option");
    opt.value = item.mac;
    opt.textContent = `${item.raw_name} (${item.mac})`;
    discoverSelect.appendChild(opt);
  }
  discoverChoose.disabled = false;
}

addSensorBtn.addEventListener("click", () => {
  if (discoverPanel.classList.contains("hidden")) {
    openDiscoverPanel();
  } else {
    discoverPanel.classList.add("hidden");
  }
});
discoverCancel.addEventListener("click", () => discoverPanel.classList.add("hidden"));

const nameModal = document.getElementById("nameModal");
const nameModalMac = document.getElementById("nameModalMac");
const hiveNameInput = document.getElementById("hiveNameInput");
const hiveNameSave = document.getElementById("hiveNameSave");
const hiveNameCancel = document.getElementById("hiveNameCancel");
let pendingMac = null;

discoverChoose.addEventListener("click", () => {
  if (!discoverSelect.value) return;
  pendingMac = discoverSelect.value;
  nameModalMac.textContent = discoverSelect.selectedOptions[0].textContent;
  hiveNameInput.value = "";
  discoverPanel.classList.add("hidden");
  nameModal.classList.remove("hidden");
  hiveNameInput.focus();
});

function closeNameModal() {
  nameModal.classList.add("hidden");
  pendingMac = null;
}
hiveNameCancel.addEventListener("click", closeNameModal);

hiveNameSave.addEventListener("click", async () => {
  const name = hiveNameInput.value.trim();
  if (!name || !pendingMac) return;
  try {
    await fetchJSON("/api/hives", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mac: pendingMac, name }),
    });
    closeNameModal();
    pollHives();
  } catch (e) {
    alert(`Could not add sensor: ${e.message}`);
  }
});
hiveNameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") hiveNameSave.click();
});

// ---- Expanded overlay ----
const overlay = document.getElementById("overlay");
const overlayTitle = document.getElementById("overlayTitle");
const overlayClose = document.getElementById("overlayClose");
const overlayCanvas = document.getElementById("overlayChart");
const overlayPrev = document.getElementById("overlayPrev");
const overlayNext = document.getElementById("overlayNext");
const overlayMetricBtn = document.getElementById("overlayMetricBtn");
const RANGE_LABEL = { today: "Today", week: "Weekly", month: "Monthly", ytd: "Year to Date" };

function rangeWord(range, offset) {
  if (range === "today") return offset === 0 ? "Today" : "Daily";
  if (range === "ytd") return offset === 0 ? "Year to Date" : "Yearly";
  return RANGE_LABEL[range] || range;
}

let overlayState = { mode: null, folder: null, hiveName: null, range: null, offset: 0 };

async function renderOverlay() {
  const { mode, folder, hiveName, range, offset } = overlayState;
  overlay.classList.remove("hidden");
  overlayNext.disabled = offset === 0;
  overlayMetricBtn.classList.toggle("hidden", mode !== "compare");
  overlayMetricBtn.textContent = compareMetric === "hum" ? "Temperature" : "Humidity";

  let label = "";
  let titleSubject = hiveName;
  if (mode === "compare") {
    titleSubject = compareTitleText(compareMetric);
    const hives = await fetchJSON("/api/hives");
    const built = await buildCompareSeries(hives, range, offset, compareMetric);
    label = built.label;
    if (overlayChart) overlayChart.destroy();
    overlayChart = built.rawLabels
      ? new Chart(overlayCanvas, {
          type: "line",
          data: { labels: built.rawLabels, datasets: built.datasets },
          options: compareChartOptions(built.rawLabels, range, compareMetric),
          plugins: [lineEndLabelPlugin],
        })
      : null;
  } else {
    const [data, events] = await Promise.all([
      fetchJSON(`/api/history/${folder}?range=${range}&offset=${offset}`),
      fetchJSON(`/api/logs/${folder}/chart`).catch(() => []),
    ]);
    label = data.label;
    if (overlayChart) overlayChart.destroy();
    overlayChart = new Chart(overlayCanvas, buildLineConfig(data.labels, data.temp, data.hum, range, { legend: true, pointRadius: 3, events }));
  }

  overlayTitle.textContent = `${titleSubject} — ${rangeWord(range, offset)}${label ? ` (${label})` : ""}`;
}

function navOverlay(delta) {
  overlayState.offset = Math.max(0, overlayState.offset + delta);
  renderOverlay().catch((e) => console.error(e));
}

function openOverlay(folder, hiveName, range) {
  overlayState = { mode: "single", folder, hiveName, range, offset: 0 };
  return renderOverlay();
}

function openCompareOverlay(range) {
  overlayState = { mode: "compare", folder: null, hiveName: "All Hives", range, offset: 0 };
  return renderOverlay();
}

overlayPrev.addEventListener("click", () => navOverlay(1));
overlayNext.addEventListener("click", () => navOverlay(-1));

overlayClose.addEventListener("click", () => {
  overlay.classList.add("hidden");
  if (overlayChart) { overlayChart.destroy(); overlayChart = null; }
});

document.getElementById("compareChartWrap").addEventListener("click", () => {
  openCompareOverlay(COMPARE_RANGE).catch((e) => console.error(e));
});
document.querySelectorAll(".compare-section .range-links a").forEach((a) => {
  a.addEventListener("click", (e) => {
    e.stopPropagation();
    openCompareOverlay(a.dataset.range).catch((err) => console.error(err));
  });
});

const compareMetricBtn = document.getElementById("compareMetricBtn");

function setCompareMetric(metric) {
  compareMetric = metric;
  const offerText = metric === "hum" ? "Temperature" : "Humidity";
  compareMetricBtn.textContent = offerText;
  if (lastHives.length) refreshCompareChart(lastHives, lastTodayData);
  if (!overlay.classList.contains("hidden") && overlayState.mode === "compare") {
    renderOverlay().catch((e) => console.error(e));
  }
}

compareMetricBtn.addEventListener("click", () => setCompareMetric(compareMetric === "temp" ? "hum" : "temp"));
overlayMetricBtn.addEventListener("click", () => setCompareMetric(compareMetric === "temp" ? "hum" : "temp"));

// ---- CSV export ----
function downloadExport(range) {
  lastHives.forEach((hive) => {
    const a = document.createElement("a");
    a.href = `/api/export/${hive.folder}?range=${range}`;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
}
document.getElementById("exportDay").addEventListener("click", () => downloadExport("day"));
document.getElementById("exportMonth").addEventListener("click", () => downloadExport("month"));
document.getElementById("exportYear").addEventListener("click", () => downloadExport("year"));

// ---- Log hive picker ----
const logHiveModal = document.getElementById("logHiveModal");
const logHiveSelect = document.getElementById("logHiveSelect");

document.getElementById("logLink").addEventListener("click", async (e) => {
  e.preventDefault();
  const hives = lastHives.length ? lastHives : await fetchJSON("/api/hives").catch(() => []);
  if (hives.length === 0) {
    alert("No hives registered yet.");
    return;
  }
  logHiveSelect.innerHTML = "";
  hives.forEach((hive) => {
    const opt = document.createElement("option");
    opt.value = hive.folder;
    opt.textContent = hive.name;
    logHiveSelect.appendChild(opt);
  });
  logHiveModal.classList.remove("hidden");
});
document.getElementById("logHiveCancel").addEventListener("click", () => logHiveModal.classList.add("hidden"));
document.getElementById("logHiveGo").addEventListener("click", () => {
  window.location.href = `/log/${logHiveSelect.value}`;
});

// ---- init ----
pollHives();
setInterval(pollHives, POLL_MS);
