const POLL_MS = 20000;
const charts = {}; // folder -> mini Chart instance
let overlayChart = null;
let compareChart = null;

function fmt(val) {
  return (val === null || val === undefined) ? "—" : val;
}

function hiveColor(hue, index) {
  const lightness = Math.min(45 + index * 14, 82);
  return `hsl(${hue}, 75%, ${lightness}%)`;
}

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

function buildLineConfig(rawLabels, temp, hum, range, opts) {
  opts = opts || {};
  return {
    type: "line",
    data: {
      labels: rawLabels,
      datasets: [
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
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: !!opts.legend, labels: { color: "#e8edf7" } },
      },
      scales: {
        x: { ticks: { color: "#8fa0c0", callback: tickFormatterFor(range, rawLabels) }, grid: { color: "#1c2c4d" } },
        yTemp: { position: "left", ticks: { color: "#ff3b30" }, grid: { color: "#1c2c4d" } },
        yHum: { position: "right", ticks: { color: "#2979ff" }, grid: { display: false } },
      },
    },
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
    <h2 class="hive-name"></h2>
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

function updateCard(div, hive) {
  div.querySelector(".hive-name").textContent = hive.name;
  div.querySelector(".temp").innerHTML = `${fmt(hive.temp_f)}<span class="unit">°F</span>`;
  div.querySelector(".hum").innerHTML = `${fmt(hive.hum)}<span class="unit">%</span>`;
}

async function refreshMiniChart(div, hive) {
  const data = await fetchJSON(`/api/history/${hive.folder}?range=today`);
  const canvas = div.querySelector(".mini-chart-wrap canvas");
  if (charts[hive.folder]) {
    charts[hive.folder].data.labels = data.labels;
    charts[hive.folder].data.datasets[0].data = data.temp;
    charts[hive.folder].data.datasets[1].data = data.hum;
    charts[hive.folder].options.scales.x.ticks.callback = tickFormatterFor("today", data.labels);
    charts[hive.folder].update();
  } else {
    charts[hive.folder] = new Chart(canvas, buildLineConfig(data.labels, data.temp, data.hum, "today"));
  }
}

async function refreshCompareChart(hives) {
  const section = document.querySelector(".compare-section");
  if (hives.length === 0) {
    section.classList.add("hidden");
    return;
  }
  section.classList.remove("hidden");

  const series = await Promise.all(
    hives.map((hive) => fetchJSON(`/api/history/${hive.folder}?range=week`).catch(() => null))
  );

  let rawLabels = null;
  const datasets = [];
  hives.forEach((hive, i) => {
    const data = series[i];
    if (!data) return;
    rawLabels = rawLabels || data.labels;
    datasets.push({
      label: hive.name,
      data: data.temp,
      borderColor: hiveColor(355, i),
      backgroundColor: "transparent",
      yAxisID: "yTemp",
      spanGaps: false,
      tension: 0.25,
      pointRadius: 2,
    });
    datasets.push({
      label: hive.name,
      data: data.hum,
      borderColor: hiveColor(212, i),
      backgroundColor: "transparent",
      yAxisID: "yHum",
      spanGaps: false,
      tension: 0.25,
      pointRadius: 2,
    });
  });
  if (!rawLabels) return;

  const tickCb = tickFormatterFor("week", rawLabels);
  if (compareChart) {
    compareChart.data.labels = rawLabels;
    compareChart.data.datasets = datasets;
    compareChart.options.scales.x.ticks.callback = tickCb;
    compareChart.update();
    return;
  }

  compareChart = new Chart(document.getElementById("compareChart"), {
    type: "line",
    data: { labels: rawLabels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      layout: { padding: { right: 70 } },
      interaction: { mode: "nearest", intersect: false },
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: "#8fa0c0", callback: tickCb }, grid: { color: "#1c2c4d" } },
        yTemp: { position: "left", ticks: { color: "#ff3b30" }, grid: { color: "#1c2c4d" } },
        yHum: { position: "right", ticks: { color: "#2979ff" }, grid: { display: false } },
      },
    },
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
  const cardsEl = document.getElementById("cards");
  const seen = new Set();
  for (const hive of hives) {
    seen.add(hive.folder);
    let div = cardsEl.querySelector(`.card[data-folder="${hive.folder}"]`);
    if (!div) {
      div = cardTemplate(hive);
      cardsEl.appendChild(div);
    }
    updateCard(div, hive);
    refreshMiniChart(div, hive).catch((e) => console.error(e));
  }
  cardsEl.querySelectorAll(".card").forEach((div) => {
    if (!seen.has(div.dataset.folder)) div.remove();
  });
  refreshCompareChart(hives).catch((e) => console.error(e));
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
const RANGE_LABEL = { today: "Today", week: "Weekly", month: "Monthly", ytd: "Year to Date" };

function currentMonthName() {
  return new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

async function openOverlay(folder, hiveName, range) {
  let title = `${hiveName} — ${RANGE_LABEL[range] || range}`;
  if (range === "month") title += ` (${currentMonthName()})`;
  overlayTitle.textContent = title;
  overlay.classList.remove("hidden");
  const data = await fetchJSON(`/api/history/${folder}?range=${range}`);
  if (overlayChart) overlayChart.destroy();
  overlayChart = new Chart(overlayCanvas, buildLineConfig(data.labels, data.temp, data.hum, range, { legend: true, pointRadius: 3 }));
}
overlayClose.addEventListener("click", () => {
  overlay.classList.add("hidden");
  if (overlayChart) { overlayChart.destroy(); overlayChart = null; }
});

// ---- init ----
pollHives();
setInterval(pollHives, POLL_MS);
