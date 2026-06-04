(() => {
  "use strict";

  const STORAGE_DEFAULTS = {
    followingSnapshot: [],
    followingProfiles: {},
    unfollowList: [],
    scanState: {},
    stats: {
      mutualCount: 0,
      unfollowCount: 0,
      lastUpdated: null
    },
    pendingUnfollowCount: 0
  };

  const SELECTORS = {
    userCell: [
      '[data-testid="UserCell"]',
      'div[data-testid="cellInnerDiv"] article',
      'article[data-testid="tweet"]'
    ].join(","),
    followsYou: [
      '[data-testid="userFollowIndicator"]',
      'span'
    ].join(","),
    followingButton: [
      '[data-testid$="-unfollow"]',
      '[data-testid="unfollow"]',
      '[aria-label*="Following"]',
      '[aria-label*="正在关注"]'
    ].join(",")
  };

  function randomDelay(minMs, maxMs) {
    return Math.floor(minMs + Math.random() * (maxMs - minMs + 1));
  }

  function sleep(minMs, maxMs) {
    return new Promise((resolve) => {
      setTimeout(resolve, randomDelay(minMs, maxMs));
    });
  }

  function safeRuntimeSend(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || { ok: true });
        });
      } catch (error) {
        resolve({ ok: false, error: error.message });
      }
    });
  }

  function storageGet(keys) {
    return chrome.storage.local.get(keys);
  }

  function storageSet(data) {
    return chrome.storage.local.set(data);
  }

  function normalizeUsername(value) {
    if (!value) {
      return "";
    }

    return value
      .replace(/^@/, "")
      .replace(/[^\w]/g, "")
      .trim();
  }

  function getText(node) {
    return (node && node.textContent ? node.textContent : "").trim();
  }

  function getRouteKey() {
    return `${location.pathname}${location.search}`;
  }

  function isRelevantRoute() {
    return /\/(following|followers|verified_followers|i\/connect_people)/i.test(location.pathname);
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function formatTime(timestamp) {
    if (!timestamp) {
      return "未检测";
    }

    try {
      return new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit"
      }).format(new Date(timestamp));
    } catch (error) {
      return "刚刚";
    }
  }

  function profileUrl(record) {
    const username = String(record.username || record.userId || "").replace(/^@/, "").trim();
    return /^\w{1,15}$/.test(username) ? `https://x.com/${username}` : "https://x.com";
  }

  class YaXmanDetector {
    constructor() {
      this.isChecking = false;
      this.lastCheckAt = 0;
      this.lastRoute = getRouteKey();
      this.nextAllowedCheckAt = 0;
      this.widget = null;
      this.badge = null;
      this.panel = null;
      this.scan = { active: false, paused: false, cancelled: false, seen: new Map(), lastHeight: 0, stableRounds: 0 };
      this.routeObserver = null;
      this.pageObserver = null;
      this.knownUserInfo = new Map();
      this.reportedThisSession = new Set();
    }

    async init() {
      await this.ensureDefaults();
      this.createWidget();
      this.installPageHook();
      await this.refreshWidgetBadge();
      this.bindRuntimeMessages();
      this.bindPageHookMessages();
      this.observeRouteChanges();
      this.observeStorageChanges();
      this.scheduleFirstRun();
      this.schedulePassiveCheck();
      this.restoreScanState().catch(() => {});
    }

    async ensureDefaults() {
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
    }

    bindRuntimeMessages() {
      chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!message || !["YAXMAN_CHECK_NOW", "YAXMAN_START_FULL_SCAN"].includes(message.type)) {
          return false;
        }

        const task = message.type === "YAXMAN_START_FULL_SCAN"
          ? this.startFullScan()
          : this.smartCheck({ reason: message.reason || "message", force: message.reason === "manual" });

        task
          .then((result) => sendResponse(result))
          .catch((error) => sendResponse({ ok: false, error: error.message }));

        return true;
      });
    }

    installPageHook() {
      if (document.getElementById("yaxman-page-hook")) {
        return;
      }

      const script = document.createElement("script");
      script.id = "yaxman-page-hook";
      script.src = chrome.runtime.getURL("pageHook.js");
      script.async = false;
      script.onload = () => script.remove();
      (document.head || document.documentElement).appendChild(script);
    }

    bindPageHookMessages() {
      window.addEventListener("message", (event) => {
        if (event.source !== window) {
          return;
        }

        const message = event.data;
        if (!message || message.source !== "YaXmanPageHook" || message.type !== "YAXMAN_GRAPHQL_USERS") {
          return;
        }

        setTimeout(() => {
          this.ingestObservedUsers(message.users, message.route, message.capturedAt).catch(() => {});
        }, randomDelay(400, 1400));
      }, { passive: true });
    }

    observeStorageChanges() {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== "local") {
          return;
        }

        if (changes.pendingUnfollowCount || changes.unfollowList) {
          this.refreshWidgetBadge().catch(() => {});
          this.renderPanel().catch(() => {});
        }
      });
    }

    scheduleFirstRun() {
      setTimeout(() => {
        this.smartCheck({ reason: "first-run" }).catch(() => {});
      }, randomDelay(5000, 8000));
    }

    schedulePassiveCheck() {
      const delay = randomDelay(15 * 60 * 1000, 20 * 60 * 1000);
      setTimeout(async () => {
        await this.smartCheck({ reason: "passive" }).catch(() => {});
        this.schedulePassiveCheck();
      }, delay);
    }

    observeRouteChanges() {
      const onPossibleRouteChange = () => {
        const route = getRouteKey();
        if (route === this.lastRoute) {
          return;
        }

        this.lastRoute = route;
        setTimeout(() => {
          this.smartCheck({ reason: "route-change" }).catch(() => {});
        }, randomDelay(3000, 6000));
      };

      this.routeObserver = new MutationObserver(onPossibleRouteChange);
      this.routeObserver.observe(document.documentElement, {
        childList: true,
        subtree: true
      });

      window.addEventListener("popstate", () => {
        setTimeout(onPossibleRouteChange, randomDelay(800, 2000));
      }, { passive: true });

      document.addEventListener("visibilitychange", () => {
        if (this.scan.active && document.visibilityState !== "visible") {
          this.pauseFullScan("页面已切走，已暂停读取");
        }
      }, { passive: true });
    }

    shouldCheck(force = false) {
      if (document.visibilityState !== "visible") {
        return { ok: false, reason: "页面未处于可见状态，已跳过检测。" };
      }

      if (!force && Date.now() < this.nextAllowedCheckAt) {
        return { ok: false, reason: "检测节奏保护中，稍后会自动重试。" };
      }

      if (!force && !isRelevantRoute()) {
        return { ok: false, reason: "当前页面不是关注列表页面，已跳过轻量检测。" };
      }

      if (this.isChecking) {
        return { ok: false, reason: "检测正在进行中。" };
      }

      return { ok: true };
    }

    async loadStorage() {
      const data = await storageGet(Object.keys(STORAGE_DEFAULTS));
      return {
        followingSnapshot: Array.isArray(data.followingSnapshot) ? data.followingSnapshot : [],
        followingProfiles: data.followingProfiles && typeof data.followingProfiles === "object" ? data.followingProfiles : {},
        unfollowList: Array.isArray(data.unfollowList) ? data.unfollowList : [],
        stats: data.stats || STORAGE_DEFAULTS.stats,
        pendingUnfollowCount: Number(data.pendingUnfollowCount) || 0
      };
    }

    async saveSnapshot(snapshot, profiles = {}, extraStats = {}) {
      const data = await this.loadStorage();
      const nextProfiles = {
        ...data.followingProfiles,
        ...profiles
      };
      const stats = {
        ...(data.stats || STORAGE_DEFAULTS.stats),
        mutualCount: snapshot.length,
        unfollowCount: data.unfollowList.length,
        lastUpdated: Date.now(),
        ...extraStats
      };

      await storageSet({
        followingSnapshot: snapshot,
        followingProfiles: nextProfiles,
        stats
      });
    }

    extractUserInfoFromCell(cell) {
      const profileLink = [...cell.querySelectorAll('a[href^="/"], a[href^="https://x.com/"], a[href^="https://twitter.com/"]')]
        .map((link) => {
          try {
            const url = new URL(link.href, location.origin);
            const username = normalizeUsername(url.pathname.split("/").filter(Boolean)[0]);
            return username && !["i", "home", "explore", "notifications", "messages", "settings"].includes(username)
              ? { link, username }
              : null;
          } catch (error) {
            return null;
          }
        })
        .filter(Boolean)[0];

      if (!profileLink) {
        return null;
      }

      const img = cell.querySelector('img[src*="profile_images"], img[alt]');
      const allText = [...cell.querySelectorAll("span, div")]
        .map(getText)
        .filter(Boolean);
      const handleText = allText.find((text) => /^@\w{1,15}$/.test(text));
      const username = normalizeUsername(handleText || profileLink.username);
      const name = allText.find((text) => text && text !== `@${username}` && !/follows you|关注了你|正在关注|following/i.test(text)) || username;

      return {
        userId: username.toLowerCase(),
        username,
        name,
        avatar: img ? img.src : chrome.runtime.getURL("logo.svg"),
        timestamp: Date.now()
      };
    }

    makeProfiles(users) {
      return users.reduce((profiles, user) => {
        if (user && user.userId) {
          profiles[user.userId] = {
            userId: user.userId,
            username: user.username || user.userId,
            name: user.name || user.username || user.userId,
            avatar: user.avatar || chrome.runtime.getURL("logo.svg"),
            timestamp: Date.now()
          };
        }
        return profiles;
      }, {});
    }

    cellHasFollowsYouSignal(cell) {
      return /follows you|关注了你|也关注你|フォローされています/i.test(getText(cell));
    }

    async detectRelationshipChangesFromDom(previousIds) {
      if (!/\/following/i.test(location.pathname) || !previousIds.length) {
        return [];
      }

      const previousSet = new Set(previousIds);
      const changed = [];

      for (const cell of [...document.querySelectorAll(SELECTORS.userCell)]) {
        const info = this.extractUserInfoFromCell(cell);
        if (!info || !previousSet.has(info.userId)) {
          continue;
        }

        this.knownUserInfo.set(info.userId, info);
        if (!this.cellHasFollowsYouSignal(cell)) {
          changed.push({
            ...info,
            timestamp: Date.now(),
            reason: "relationship-dom"
          });
        }
      }

      return changed;
    }

    async ingestObservedUsers(users, route = location.pathname, capturedAt = Date.now()) {
      if (document.visibilityState !== "visible" || !Array.isArray(users) || !users.length) {
        return;
      }

      const data = await this.loadStorage();
      const previousSet = new Set(data.followingSnapshot);
      const profiles = this.makeProfiles(users);
      const isFollowingData = /following/i.test(route) || users.some((user) => user.source === "following-network");
      const mutualUsers = [];
      const unfollowed = [];

      users.forEach((user) => {
        const normalized = {
          userId: String(user.userId || user.username || "").toLowerCase(),
          username: user.username || user.userId,
          name: user.name || user.username || user.userId,
          avatar: user.avatar || chrome.runtime.getURL("logo.svg"),
          timestamp: capturedAt
        };

        if (!normalized.userId) {
          return;
        }

        this.knownUserInfo.set(normalized.userId, normalized);

        if (isFollowingData && user.followedBy === true) {
          mutualUsers.push(normalized);
        }

        if (isFollowingData && previousSet.has(normalized.userId) && user.followedBy === false) {
          unfollowed.push({
            ...normalized,
            reason: "relationship-network"
          });
        }
      });

      if (mutualUsers.length) {
        const merged = new Set([...data.followingSnapshot, ...mutualUsers.map((user) => user.userId)]);
        await this.saveSnapshot([...merged], { ...data.followingProfiles, ...this.makeProfiles(mutualUsers) });
      } else if (Object.keys(profiles).length) {
        await storageSet({
          followingProfiles: {
            ...data.followingProfiles,
            ...profiles
          }
        });
      }

      if (unfollowed.length) {
        await this.reportUnfollows(unfollowed);
      }
    }

    async reportUnfollows(records) {
      const data = await this.loadStorage();
      const list = records
        .map((record) => {
          const stored = data.followingProfiles[record.userId] || {};
          return {
            ...stored,
            ...record,
            userId: record.userId,
            username: record.username || stored.username || record.userId,
            name: record.name || stored.name || record.username || record.userId,
            avatar: record.avatar || stored.avatar || chrome.runtime.getURL("logo.svg"),
            timestamp: Date.now()
          };
        })
        .filter((record) => {
          if (this.reportedThisSession.has(record.userId)) {
            return false;
          }
          this.reportedThisSession.add(record.userId);
          return true;
        });

      if (!list.length) {
        return;
      }

      const nextSnapshot = data.followingSnapshot.filter((userId) => !list.some((record) => record.userId === userId));
      await storageSet({ followingSnapshot: nextSnapshot });

      await safeRuntimeSend({
        type: "NEW_UNFOLLOW",
        records: list
      });

      this.showToast(list);
      await this.refreshWidgetBadge();
      await this.renderPanel();
    }

    hasMutualSignal(cell) {
      const text = getText(cell).toLowerCase();
      const hasFollowsYou = /follows you|关注了你|也关注你|フォローされています/.test(text);
      const hasFollowing = Boolean(cell.querySelector(SELECTORS.followingButton)) || /following|正在关注|フォロー中/.test(text);

      if (/\/followers/i.test(location.pathname)) {
        return hasFollowing;
      }

      if (/\/following/i.test(location.pathname)) {
        return hasFollowsYou;
      }

      return hasFollowsYou && hasFollowing;
    }

    async getMutualFollowings() {
      await sleep(2000, 5000);

      const cells = [...document.querySelectorAll(SELECTORS.userCell)];
      const users = [];
      const seen = new Set();

      for (const cell of cells) {
        if (!this.hasMutualSignal(cell)) {
          continue;
        }

        const info = this.extractUserInfoFromCell(cell);
        if (!info || seen.has(info.userId)) {
          continue;
        }

        seen.add(info.userId);
        users.push(info);
        this.knownUserInfo.set(info.userId, info);

        if (users.length % 8 === 0) {
          await sleep(300, 900);
        }
      }

      return users;
    }

    async getUserInfo(userId) {
      await sleep(2000, 5000);

      const normalized = String(userId || "").toLowerCase();
      if (this.knownUserInfo.has(normalized)) {
        return this.knownUserInfo.get(normalized);
      }

      const cells = [...document.querySelectorAll(SELECTORS.userCell)];
      for (const cell of cells) {
        const info = this.extractUserInfoFromCell(cell);
        if (info && info.userId === normalized) {
          this.knownUserInfo.set(normalized, info);
          return info;
        }
      }

      return {
        userId: normalized,
        username: normalized,
        name: normalized,
        avatar: chrome.runtime.getURL("logo.svg"),
        timestamp: Date.now()
      };
    }

    async smartCheck(options = {}) {
      const force = Boolean(options.force);
      const checkState = this.shouldCheck(force);
      if (!checkState.ok) {
        return { ok: false, skipped: true, reason: checkState.reason };
      }

      this.isChecking = true;
      this.setWidgetBusy(true);

      try {
        await sleep(2000, 5000);

        const data = await this.loadStorage();
        const currentUsers = await this.getMutualFollowings();
        const currentIds = currentUsers.map((user) => user.userId);
        const currentProfiles = this.makeProfiles(currentUsers);
        const previousIds = data.followingSnapshot;
        const snapshotExists = previousIds.length > 0;
        const relationshipChanged = await this.detectRelationshipChangesFromDom(previousIds);

        if (!currentIds.length && !relationshipChanged.length) {
          return { ok: false, skipped: true, reason: "当前页面没有读取到可用的互关数据。" };
        }

        const tooPartial = snapshotExists && currentIds.length > 0 && currentIds.length < Math.max(3, Math.floor(previousIds.length * 0.35));
        if (tooPartial) {
          if (!relationshipChanged.length) {
            return { ok: false, skipped: true, reason: "当前DOM样本过少，已避免误报。" };
          }
        }

        const mergedSnapshot = snapshotExists
          ? [...new Set([...previousIds, ...currentIds])]
          : currentIds;

        await this.saveSnapshot(mergedSnapshot, currentProfiles);

        if (relationshipChanged.length) {
          await this.reportUnfollows(relationshipChanged);
        }

        this.lastCheckAt = Date.now();
        this.nextAllowedCheckAt = Date.now() + randomDelay(15 * 60 * 1000, 20 * 60 * 1000);
        await this.refreshWidgetBadge();

        return {
          ok: true,
          checked: currentIds.length,
          unfollowed: relationshipChanged.length
        };
      } catch (error) {
        return { ok: false, error: error.message };
      } finally {
        this.isChecking = false;
        this.setWidgetBusy(false);
      }
    }

    getOwnUsernameFromPage() {
      const links = [...document.querySelectorAll('a[data-testid="AppTabBar_Profile_Link"], a[href^="/"][role="link"]')];
      for (const link of links) {
        try {
          const url = new URL(link.href, location.origin);
          const name = normalizeUsername(url.pathname.split("/").filter(Boolean)[0]);
          if (name && !["home", "explore", "notifications", "messages", "i", "settings"].includes(name)) {
            return name;
          }
        } catch (error) {
          // Ignore malformed links.
        }
      }
      return "";
    }

    async goToFollowingPage() {
      if (/\/following/i.test(location.pathname)) {
        return true;
      }

      const username = this.getOwnUsernameFromPage();
      if (username) {
        location.assign(`https://x.com/${username}/following`);
        return false;
      }

      this.showLocalHint("请先进入你的个人主页，YaXman 会继续切到正在关注栏");
      return false;
    }

    async restoreScanState() {
      const data = await storageGet(["scanState"]);
      if (data.scanState && data.scanState.active) {
        this.scan.active = true;
        this.scan.paused = true;
        this.showScanStatus("上次读取未完成，可继续", false, true);
      }
    }

    async startFullScan() {
      if (this.scan.active && this.scan.paused) {
        this.scan.paused = false;
        this.showScanStatus("正在读取关注列表，请稍等");
        this.runFullScanLoop().catch(() => {});
        return { ok: true, resumed: true, checked: this.scan.seen.size };
      }

      this.scan = { active: true, paused: false, cancelled: false, seen: new Map(), lastHeight: 0, stableRounds: 0 };
      await storageSet({ scanState: { active: true, paused: false, startedAt: Date.now() } });
      this.showScanStatus("正在读取关注列表，请稍等");

      const ready = await this.goToFollowingPage();
      if (!ready) {
        return { ok: true, navigating: true };
      }

      this.runFullScanLoop().catch(() => {});
      return { ok: true, started: true };
    }

    pauseFullScan(text = "已暂停读取") {
      this.scan.paused = true;
      storageSet({ scanState: { active: true, paused: true, updatedAt: Date.now() } }).catch(() => {});
      this.showScanStatus(text, false, true);
    }

    cancelFullScan() {
      this.scan.cancelled = true;
      this.scan.active = false;
      storageSet({ scanState: { active: false, paused: false, stoppedAt: Date.now() } }).catch(() => {});
      const box = document.getElementById("yaxman-scan-box");
      if (box) {
        box.remove();
      }
      this.showLocalHint("已取消读取关注列表");
    }

    showScanStatus(text, isError = false, paused = false) {
      let box = document.getElementById("yaxman-scan-box");
      if (!box) {
        box = document.createElement("div");
        box.id = "yaxman-scan-box";
        box.innerHTML = `
          <div class="yaxman-scan-text"></div>
          <div class="yaxman-scan-actions">
            <button class="yaxman-scan-continue" type="button">继续</button>
            <button class="yaxman-scan-cancel" type="button">取消</button>
          </div>
        `;
        box.querySelector(".yaxman-scan-continue").addEventListener("click", () => {
          this.scan.paused = false;
          this.showScanStatus("正在读取关注列表，请稍等");
          this.runFullScanLoop().catch(() => {});
        });
        box.querySelector(".yaxman-scan-cancel").addEventListener("click", () => this.cancelFullScan());
        document.documentElement.appendChild(box);
      }

      box.classList.toggle("is-error", isError);
      box.classList.toggle("is-paused", paused);
      box.querySelector(".yaxman-scan-text").textContent = `${text}，已读取 ${this.scan.seen.size} 个互关账号`;
    }

    async runFullScanLoop() {
      while (this.scan.active && !this.scan.cancelled) {
        if (this.scan.paused || document.visibilityState !== "visible") {
          this.pauseFullScan("已暂停读取");
          return;
        }

        const users = await this.getMutualFollowings();
        users.forEach((user) => this.scan.seen.set(user.userId, user));

        const height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
        this.scan.stableRounds = height === this.scan.lastHeight ? this.scan.stableRounds + 1 : 0;
        this.scan.lastHeight = height;
        this.showScanStatus("正在读取关注列表，请稍等");

        if (this.scan.stableRounds >= 4) {
          const finalUsers = [...this.scan.seen.values()];
          await this.saveSnapshot(finalUsers.map((user) => user.userId), this.makeProfiles(finalUsers));
          this.scan.active = false;
          await storageSet({ scanState: { active: false, paused: false, completedAt: Date.now() } });
          this.showScanStatus("读取完成", false, true);
          this.showLocalHint(`读取完成，共记录 ${finalUsers.length} 个互关账号`);
          setTimeout(() => {
            const box = document.getElementById("yaxman-scan-box");
            if (box) {
              box.remove();
            }
          }, randomDelay(3500, 5200));
          return;
        }

        window.scrollBy({
          top: Math.max(520, Math.floor(window.innerHeight * (0.72 + Math.random() * 0.24))),
          left: 0,
          behavior: "smooth"
        });
        await sleep(2200, 5200);
      }
    }

    createWidget() {
      if (document.getElementById("yaxman-widget")) {
        return;
      }

      const widget = document.createElement("button");
      widget.id = "yaxman-widget";
      widget.type = "button";
      widget.setAttribute("aria-label", "打开 YaXman 取关查询");
      widget.innerHTML = `
        <img class="yaxman-widget-logo" src="${chrome.runtime.getURL("logo.svg")}" alt="">
        <span class="yaxman-widget-text">YaXman护卫</span>
        <span class="yaxman-widget-badge" hidden>0</span>
      `;

      widget.addEventListener("click", () => {
        this.togglePanel().catch(() => {});
      });

      document.documentElement.appendChild(widget);
      this.widget = widget;
      this.badge = widget.querySelector(".yaxman-widget-badge");
      this.createPanel();
    }

    createPanel() {
      if (document.getElementById("yaxman-panel")) {
        this.panel = document.getElementById("yaxman-panel");
        return;
      }

      const panel = document.createElement("section");
      panel.id = "yaxman-panel";
      panel.setAttribute("aria-label", "YaXman 取关记录");
      panel.hidden = true;
      panel.innerHTML = `
        <div class="yaxman-panel-head">
          <div class="yaxman-panel-brand">
            <img src="${chrome.runtime.getURL("logo.svg")}" alt="">
            <div>
              <strong>YaXman护卫</strong>
              <span>已观察互关变化</span>
            </div>
          </div>
          <button class="yaxman-panel-close" type="button" aria-label="关闭">×</button>
        </div>
        <div class="yaxman-panel-stats"></div>
        <div class="yaxman-panel-records"></div>
        <div class="yaxman-panel-actions">
          <button class="yaxman-panel-check" type="button">手动检测当前页</button>
          <button class="yaxman-panel-popup" type="button">打开插件面板</button>
        </div>
      `;

      panel.querySelector(".yaxman-panel-close").addEventListener("click", () => {
        panel.hidden = true;
      });

      panel.querySelector(".yaxman-panel-check").addEventListener("click", async () => {
        const button = panel.querySelector(".yaxman-panel-check");
        button.disabled = true;
        button.textContent = "检测中...";
        const result = await this.smartCheck({ reason: "widget", force: true }).catch((error) => ({ ok: false, error: error.message }));
        button.disabled = false;
        button.textContent = "手动检测当前页";
        this.showLocalHint(result.ok ? `检测完成，发现 ${result.unfollowed || 0} 条变化` : (result.reason || result.error || "检测未完成"));
        await this.renderPanel();
      });

      panel.querySelector(".yaxman-panel-popup").addEventListener("click", () => {
        safeRuntimeSend({ type: "OPEN_POPUP" });
        this.showLocalHint("也可以从浏览器工具栏打开完整面板");
      });

      panel.addEventListener("click", (event) => {
        const recordButton = event.target.closest("[data-yaxman-profile]");
        if (!recordButton) {
          return;
        }

        const url = recordButton.getAttribute("data-yaxman-profile");
        if (url) {
          window.open(url, "_blank", "noopener,noreferrer");
        }
      });

      document.documentElement.appendChild(panel);
      this.panel = panel;
    }

    async togglePanel() {
      if (!this.panel) {
        this.createPanel();
      }

      this.panel.hidden = !this.panel.hidden;
      if (!this.panel.hidden) {
        await this.renderPanel();
      }
    }

    async renderPanel() {
      if (!this.panel) {
        return;
      }

      const data = await this.loadStorage();
      const records = data.unfollowList.slice(0, 6);
      const stats = this.panel.querySelector(".yaxman-panel-stats");
      const list = this.panel.querySelector(".yaxman-panel-records");

      stats.innerHTML = `
        <div><span>已观察互关</span><strong>${data.followingSnapshot.length}</strong></div>
        <div><span>累计取关</span><strong>${data.unfollowList.length}</strong></div>
        <div><span>最后更新</span><strong>${escapeHtml(formatTime(data.stats.lastUpdated))}</strong></div>
      `;

      if (!records.length) {
        list.innerHTML = `<div class="yaxman-panel-empty">暂时没有取关记录</div>`;
        return;
      }

      list.innerHTML = records.map((record) => `
        <button class="yaxman-panel-record" type="button" data-yaxman-profile="${escapeHtml(profileUrl(record))}">
          <img src="${escapeHtml(record.avatar || chrome.runtime.getURL("logo.svg"))}" alt="">
          <span>
            <strong>${escapeHtml(record.name || record.username || "未知用户")}</strong>
            <em>@${escapeHtml(record.username || record.userId || "unknown")}</em>
          </span>
          <time>${escapeHtml(formatTime(record.timestamp))}</time>
        </button>
      `).join("");
    }

    setWidgetBusy(isBusy) {
      if (this.widget) {
        this.widget.classList.toggle("is-busy", isBusy);
      }
    }

    async refreshWidgetBadge() {
      const data = await this.loadStorage();
      if (!this.badge) {
        return;
      }

      const count = data.pendingUnfollowCount || 0;
      this.badge.hidden = count <= 0;
      this.badge.textContent = count > 99 ? "99+" : String(count);
    }

    showToast(records) {
      const count = Array.isArray(records) ? records.length : 1;
      const first = Array.isArray(records) ? records[0] : records;
      const name = first && (first.username || first.name) ? `@${first.username || first.name}` : "新的账号";
      const text = count > 1 ? `发现 ${count} 条新的取关记录` : `${name} 取消了对你的关注`;
      this.showLocalHint(text);
    }

    showLocalHint(text) {
      const oldHint = document.querySelector(".yaxman-toast");
      if (oldHint) {
        oldHint.remove();
      }

      const hint = document.createElement("div");
      hint.className = "yaxman-toast";
      hint.textContent = text;
      document.documentElement.appendChild(hint);

      setTimeout(() => {
        hint.classList.add("is-visible");
      }, randomDelay(40, 140));

      setTimeout(() => {
        hint.classList.remove("is-visible");
        setTimeout(() => hint.remove(), randomDelay(260, 520));
      }, randomDelay(3000, 5000));
    }
  }

  if (!window.__YaXmanDetector) {
    window.__YaXmanDetector = new YaXmanDetector();
    window.__YaXmanDetector.init().catch(() => {});
  }
})();
