async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `request failed: ${res.status}`);
  }
  return res.json();
}

function formatTimestamp(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

const entriesEl = document.getElementById("logEntries");

function entryRow(entry) {
  const div = document.createElement("div");
  div.className = "log-entry";
  div.innerHTML = `
    <label class="log-entry-checkbox">
      <input type="checkbox" ${entry.show_on_chart ? "checked" : ""}>
      <span>Show on Chart</span>
    </label>
    <div class="log-entry-body">
      <div class="log-entry-time">${formatTimestamp(entry.timestamp)}</div>
      <div class="log-entry-text"></div>
    </div>
  `;
  div.querySelector(".log-entry-text").textContent = entry.text;

  div.querySelector('input[type="checkbox"]').addEventListener("change", async (e) => {
    const checked = e.target.checked;
    try {
      await fetchJSON(`/api/logs/${LOG_FOLDER}/${entry.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ show_on_chart: checked }),
      });
    } catch (err) {
      e.target.checked = !checked;
      alert(`Could not update entry: ${err.message}`);
    }
  });

  return div;
}

async function loadEntries() {
  let entries = [];
  try {
    entries = await fetchJSON(`/api/logs/${LOG_FOLDER}`);
  } catch (err) {
    entriesEl.innerHTML = `<p class="log-empty">Could not load entries: ${err.message}</p>`;
    return;
  }
  entriesEl.innerHTML = "";
  if (entries.length === 0) {
    entriesEl.innerHTML = '<p class="log-empty">No log entries yet.</p>';
    return;
  }
  entries.forEach((entry) => entriesEl.appendChild(entryRow(entry)));
}

const logFormModal = document.getElementById("logFormModal");
const logDateInput = document.getElementById("logDateInput");
const logTextInput = document.getElementById("logTextInput");

document.getElementById("addLogBtn").addEventListener("click", () => {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  logDateInput.value = now.toISOString().slice(0, 16);
  logTextInput.value = "";
  logFormModal.classList.remove("hidden");
  logTextInput.focus();
});

document.getElementById("logCancelBtn").addEventListener("click", () => {
  logFormModal.classList.add("hidden");
});

document.getElementById("logSaveBtn").addEventListener("click", async () => {
  const timestamp = logDateInput.value;
  const text = logTextInput.value.trim();
  if (!timestamp || !text) return;
  try {
    await fetchJSON(`/api/logs/${LOG_FOLDER}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timestamp, text }),
    });
    logFormModal.classList.add("hidden");
    loadEntries();
  } catch (err) {
    alert(`Could not save entry: ${err.message}`);
  }
});

logTextInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("logSaveBtn").click();
});

loadEntries();
