(() => {
  "use strict";

  if (window.__YaXmanPageHookInstalled) {
    return;
  }

  window.__YaXmanPageHookInstalled = true;

  const INTERESTING_URL = /(Followers|Following|UserByScreenName|UserTweets|graphql)/i;
  const USER_LIMIT = 260;

  function detectSource(url) {
    if (/Following/i.test(url)) {
      return "following-network";
    }
    if (/Followers/i.test(url)) {
      return "followers-network";
    }
    return "network";
  }

  function asBool(value) {
    return value === true || value === "true";
  }

  function normalizeUser(candidate, source) {
    const result = candidate && (candidate.result || candidate.user || candidate);
    const legacy = result && (result.legacy || result.core?.user_results?.result?.legacy);
    const restId = result && (result.rest_id || result.id_str || result.id);

    if (!legacy || !legacy.screen_name) {
      return null;
    }

    const username = String(legacy.screen_name).replace(/^@/, "");
    const relationship = result.relationship_perspectives || result.relationships || {};
    const followedBy = asBool(legacy.followed_by) || asBool(relationship.followed_by);
    const following = asBool(legacy.following) || asBool(relationship.following);

    return {
      userId: username.toLowerCase(),
      restId: restId ? String(restId) : "",
      username,
      name: legacy.name || username,
      avatar: legacy.profile_image_url_https || legacy.profile_image_url || "",
      followedBy,
      following,
      source
    };
  }

  function collectUsers(value, source, out, seen) {
    if (!value || out.length >= USER_LIMIT) {
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        collectUsers(item, source, out, seen);
      }
      return;
    }

    if (typeof value !== "object") {
      return;
    }

    const user = normalizeUser(value, source);
    if (user && !seen.has(user.userId)) {
      seen.add(user.userId);
      out.push(user);
    }

    for (const key of Object.keys(value)) {
      if (key === "entities" || key === "description" || key === "url") {
        continue;
      }
      collectUsers(value[key], source, out, seen);
    }
  }

  function postUsersFromText(url, text) {
    if (!text || !INTERESTING_URL.test(url)) {
      return;
    }

    try {
      const json = JSON.parse(text);
      const source = detectSource(url);
      const users = [];
      collectUsers(json, source, users, new Set());

      if (users.length) {
        window.postMessage({
          source: "YaXmanPageHook",
          type: "YAXMAN_GRAPHQL_USERS",
          route: location.pathname,
          users,
          capturedAt: Date.now()
        }, "*");
      }
    } catch (error) {
      // Non-JSON responses are irrelevant here.
    }
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = async function yaxmanFetch(input, init) {
      const response = await originalFetch.apply(this, arguments);
      try {
        const url = typeof input === "string" ? input : input && input.url;
        if (url && INTERESTING_URL.test(url)) {
          response.clone().text().then((text) => {
            postUsersFromText(url, text);
          }).catch(() => {});
        }
      } catch (error) {
        // The original response is returned untouched.
      }
      return response;
    };
  }

  const OriginalXHR = window.XMLHttpRequest;
  if (typeof OriginalXHR === "function") {
    const originalOpen = OriginalXHR.prototype.open;
    const originalSend = OriginalXHR.prototype.send;

    OriginalXHR.prototype.open = function yaxmanOpen(method, url) {
      this.__yaxmanUrl = String(url || "");
      return originalOpen.apply(this, arguments);
    };

    OriginalXHR.prototype.send = function yaxmanSend() {
      this.addEventListener("load", function yaxmanLoad() {
        try {
          if (this.__yaxmanUrl && INTERESTING_URL.test(this.__yaxmanUrl)) {
            postUsersFromText(this.__yaxmanUrl, this.responseText);
          }
        } catch (error) {
          // Ignore observer failures.
        }
      });
      return originalSend.apply(this, arguments);
    };
  }
})();
