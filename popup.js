const STORAGE_DEFAULTS = {
  followingSnapshot: [],
  followingProfiles: {},
  unfollowList: [],
  stats: {
    mutualCount: 0,
    unfollowCount: 0,
    lastUpdated: null
  },
  pendingUnfollowCount: 0
};

const els = {
  mutualCount: document.getElementById("mutualCount"),
  unfollowCount: document.getElementById("unfollowCount"),
  lastUpdated: document.getElementById("lastUpdated"),
  recordsList: document.getElementById("recordsList"),
  recordHint: document.getElementById("recordHint"),
  manualCheck: document.getElementById("manualCheck"),
  clearRecords: document.getElementById("clearRecords"),
  statusText: document.getElementById("statusText")
};

function randomDelay(minMs, maxMs) {
  return Math.floor(minMs + Math.random() * (maxMs - minMs + 1));
}

function formatTime(timestamp) {
  if (!timestamp) {
    return "未检测";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(timestamp));
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function setStatus(text, isError = false) {
  els.statusText.textContent = text;
  els.statusText.classList.toggle("is-error", isError);
}

function profileUrl(record) {
  const username = String(record.username || record.userId || "").replace(/^@/, "").trim();
  return /^\w{1,15}$/.test(username) ? `https://x.com/${username}` : "https://x.com";
}

async function getState() {
  const data = await chrome.storage.local.get(Object.keys(STORAGE_DEFAULTS));
  return {
    followingSnapshot: Array.isArray(data.followingSnapshot) ? data.followingSnapshot : [],
    followingProfiles: data.followingProfiles && typeof data.followingProfiles === "object" ? data.followingProfiles : {},
    unfollowList: Array.isArray(data.unfollowList) ? data.unfollowList : [],
    stats: data.stats || STORAGE_DEFAULTS.stats,
    pendingUnfollowCount: Number(data.pendingUnfollowCount) || 0
  };
}

async function ensureDefaults() {
  const data = await chrome.storage.local.get(Object.keys(STORAGE_DEFAULTS));
  const patch = {};

  Object.entries(STORAGE_DEFAULTS).forEach(([key, value]) => {
    if (typeof data[key] === "undefined") {
      patch[key] = value;
    }
  });

  if (Object.keys(patch).length) {
    await chrome.storage.local.set(patch);
  }
}

function renderRecords(records) {
  els.recordsList.innerHTML = "";

  if (!records.length) {
    els.recordsList.innerHTML = `
      <div class="empty-state">
        <img src="logo.svg" alt="">
        <p>暂时没有取关记录</p>
      </div>
    `;
    els.recordHint.textContent = "暂无记录";
    return;
  }

  els.recordHint.textContent = `${records.length} 条`;

  const fragment = document.createDocumentFragment();
  records.forEach((record) => {
    const item = document.createElement("article");
    item.className = "record-item";
    item.setAttribute("role", "listitem");
    item.dataset.url = profileUrl(record);
    item.innerHTML = `
      <img class="avatar" src="${escapeHtml(record.avatar || "logo.svg")}" alt="">
      <div class="record-main">
        <strong>${escapeHtml(record.name || record.username || "未知用户")}</strong>
        <span>@${escapeHtml(record.username || record.userId || "unknown")}</span>
      </div>
      <div class="record-side">
        <time>${formatTime(record.timestamp)}</time>
        <button class="open-profile" type="button">打开主页</button>
      </div>
    `;
    item.addEventListener("click", (event) => {
      if (event.target.closest("button")) {
        return;
      }
      chrome.tabs.create({ url: item.dataset.url });
    });
    item.querySelector(".open-profile").addEventListener("click", () => {
      chrome.tabs.create({ url: item.dataset.url });
    });
    fragment.appendChild(item);
  });

  els.recordsList.appendChild(fragment);
}

async function render() {
  const state = await getState();
  els.mutualCount.textContent = String(state.stats.mutualCount || state.followingSnapshot.length || 0);
  els.unfollowCount.textContent = String(state.unfollowList.length || state.stats.unfollowCount || 0);
  els.lastUpdated.textContent = formatTime(state.stats.lastUpdated);
  renderRecords(state.unfollowList);

  if (state.pendingUnfollowCount > 0) {
    await chrome.storage.local.set({ pendingUnfollowCount: 0 });
    await chrome.action.setBadgeText({ text: "" }).catch(() => {});
  }
}

function sendRuntimeMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: true });
    });
  });
}

async function handleManualCheck() {
  els.manualCheck.disabled = true;
  setStatus("正在读取关注列表，请稍等。页面右下角可取消或继续。");

  setTimeout(async () => {
    const response = await sendRuntimeMessage({ type: "MANUAL_CHECK" });

    if (!response.ok) {
      setStatus(response.error || response.reason || "检测没有完成，请确认已打开 X 页面。", true);
    } else {
      const checked = typeof response.checked === "number" ? `已读取 ${response.checked} 个互关样本` : "已启动关注列表读取";
      const found = typeof response.unfollowed === "number" ? `，发现 ${response.unfollowed} 条变化` : "";
      setStatus(`${checked}${found}`);
    }

    await render();
    els.manualCheck.disabled = false;
  }, randomDelay(2000, 5000));
}

async function handleClearRecords() {
  els.clearRecords.disabled = true;
  setStatus("正在清空记录...");

  setTimeout(async () => {
    const state = await getState();
    await chrome.storage.local.set({
      unfollowList: [],
      pendingUnfollowCount: 0,
      stats: {
        ...(state.stats || STORAGE_DEFAULTS.stats),
        unfollowCount: 0,
        lastUpdated: Date.now()
      }
    });
    await render();
    setStatus("历史取关记录已清空。");
    els.clearRecords.disabled = false;
  }, randomDelay(400, 1200));
}

document.addEventListener("DOMContentLoaded", async () => {
  await ensureDefaults();
  await render();

  els.manualCheck.addEventListener("click", handleManualCheck);
  els.clearRecords.addEventListener("click", handleClearRecords);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && (changes.unfollowList || changes.stats || changes.followingSnapshot)) {
    render().catch(() => {});
  }
});
