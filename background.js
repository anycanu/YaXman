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

const ALARM_NAME = "yaxman-background-check";
const HEARTBEAT_MINUTES = 30;

function randomDelay(minMs, maxMs) {
  return Math.floor(minMs + Math.random() * (maxMs - minMs + 1));
}

function storageGet(keys) {
  return chrome.storage.local.get(keys);
}

function storageSet(data) {
  return chrome.storage.local.set(data);
}

async function ensureDefaults() {
  const data = await storageGet(Object.keys(STORAGE_DEFAULTS));
  const patch = {};

  Object.entries(STORAGE_DEFAULTS).forEach(([key, value]) => {
    if (typeof data[key] === "undefined") {
      patch[key] = value;
    }
  });

  if (Object.keys(patch).length) {
    await storageSet(patch);
  }

  await updateActionBadge(Number(data.pendingUnfollowCount) || 0);
}

async function createHeartbeatAlarm() {
  await chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: HEARTBEAT_MINUTES,
    periodInMinutes: HEARTBEAT_MINUTES
  });
}

async function updateActionBadge(count) {
  const text = count > 0 ? (count > 99 ? "99+" : String(count)) : "";
  await chrome.action.setBadgeBackgroundColor({ color: "#764ba2" }).catch(() => {});
  await chrome.action.setBadgeText({ text }).catch(() => {});
}

async function getXTabs() {
  const [xTabs, twitterTabs] = await Promise.all([
    chrome.tabs.query({ url: "https://x.com/*" }),
    chrome.tabs.query({ url: "https://twitter.com/*" })
  ]);

  return [...xTabs, ...twitterTabs].filter((tab) => typeof tab.id === "number");
}

async function askVisibleTabsToCheck(reason = "alarm") {
  const tabs = await getXTabs();

  tabs.forEach((tab) => {
    const delay = randomDelay(2000, 5000);
    setTimeout(async () => {
      try {
        await sendCheckToTab(tab.id, {
        type: "YAXMAN_CHECK_NOW",
        reason
      });
      } catch (error) {
        // The tab may be suspended, restricted, or no longer available.
      }
    }, delay);
  });
}

async function injectContentAssets(tabId) {
  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ["styles.css"]
  }).catch(() => {});

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"]
  });
}

async function sendCheckToTab(tabId, message, retry = true) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (!retry || !/Receiving end does not exist|Could not establish connection/i.test(error.message || "")) {
      throw error;
    }

    await injectContentAssets(tabId);
    await new Promise((resolve) => setTimeout(resolve, randomDelay(500, 1400)));
    return chrome.tabs.sendMessage(tabId, message);
  }
}

function makeNotificationId(userId) {
  const suffix = String(userId || Date.now()).replace(/[^\w-]/g, "").slice(0, 40);
  return `yaxman-unfollow-${suffix}-${Date.now()}`;
}

async function storeUnfollowRecords(records) {
  if (!Array.isArray(records) || !records.length) {
    return { added: [] };
  }

  const data = await storageGet(["unfollowList", "pendingUnfollowCount", "stats"]);
  const unfollowList = Array.isArray(data.unfollowList) ? data.unfollowList : [];
  const knownKeys = new Set(unfollowList.map((item) => `${item.userId}:${item.timestamp}`));
  const knownUsers = new Set(unfollowList.map((item) => item.userId));

  const added = records.filter((record) => {
    const userKey = `${record.userId}:${record.timestamp}`;
    if (knownKeys.has(userKey) || knownUsers.has(record.userId)) {
      return false;
    }
    knownKeys.add(userKey);
    knownUsers.add(record.userId);
    return true;
  });

  if (!added.length) {
    return { added: [] };
  }

  const nextList = [...added, ...unfollowList]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 500);

  const stats = {
    ...(data.stats || STORAGE_DEFAULTS.stats),
    unfollowCount: nextList.length,
    lastUpdated: Date.now()
  };

  await storageSet({
    unfollowList: nextList,
    pendingUnfollowCount: (Number(data.pendingUnfollowCount) || 0) + added.length,
    stats
  });

  await updateActionBadge((Number(data.pendingUnfollowCount) || 0) + added.length);

  return { added };
}

async function notifyUnfollow(record) {
  const display = record.username ? `@${record.username}` : (record.name || "有人");
  const permission = await chrome.notifications.getPermissionLevel().catch(() => "granted");
  if (permission !== "granted") {
    return;
  }

  await chrome.notifications.create(makeNotificationId(record.userId), {
    type: "basic",
    iconUrl: "icon128.png",
    title: "YaXman取关提醒",
    message: `${display} 取消了对你的关注`,
    contextMessage: "点击记录可打开账号主页",
    requireInteraction: true,
    priority: 1
  });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureDefaults()
    .then(createHeartbeatAlarm)
    .catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  ensureDefaults()
    .then(createHeartbeatAlarm)
    .catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) {
    return;
  }

  askVisibleTabsToCheck("alarm").catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    return false;
  }

  if (message.type === "NEW_UNFOLLOW") {
    (async () => {
      const records = Array.isArray(message.records) ? message.records : [message.record].filter(Boolean);
      const { added } = await storeUnfollowRecords(records);

      added.forEach((record) => {
        const delay = randomDelay(500, 1800);
        setTimeout(() => {
          notifyUnfollow(record).catch(() => {});
        }, delay);
      });

      sendResponse({ ok: true, added: added.length });
    })().catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });

    return true;
  }

  if (message.type === "MANUAL_CHECK") {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      let targetTab = tab;

      if (!targetTab || typeof targetTab.id !== "number" || !/^https:\/\/(x|twitter)\.com\//.test(targetTab.url || "")) {
        targetTab = await chrome.tabs.create({ url: "https://x.com/home", active: true });
        await new Promise((resolve) => setTimeout(resolve, randomDelay(3500, 6000)));
      }

      await chrome.tabs.update(targetTab.id, { active: true }).catch(() => {});
      const response = await sendCheckToTab(targetTab.id, {
        type: "YAXMAN_START_FULL_SCAN",
        reason: "manual-full"
      });
      sendResponse(response || { ok: true });
    })().catch((error) => {
      sendResponse({ ok: false, error: error.message || "无法连接页面脚本。" });
    });

    return true;
  }

  if (message.type === "OPEN_POPUP") {
    if (chrome.action && chrome.action.openPopup) {
      chrome.action.openPopup().catch(() => {});
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "OPEN_PROFILE") {
    const username = String(message.username || "").replace(/^@/, "").trim();
    if (!/^\w{1,15}$/.test(username)) {
      sendResponse({ ok: false, error: "账号名无效。" });
      return false;
    }

    chrome.tabs.create({ url: `https://x.com/${username}` })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});
