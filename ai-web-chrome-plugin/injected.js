(function () {
  if (window.__AI_WEB_NETWORK_HOOKED) {
    return;
  }
  window.__AI_WEB_NETWORK_HOOKED = true;
  const HOOK_URL_PATTERNS = [
    "/chat/completions",
    "/completions",
    "/api/organizations/",
    "/api/chat_conversations",
    "/api/retry_message",
    "/f/conversation"
  ];
  function shouldHookUrl(url) {
    if (!url || typeof url !== "string") {
      return false;
    }
    return HOOK_URL_PATTERNS.some((pattern) => url.includes(pattern));
  }
  // ─── 工具：发送数据到 content script ───────────────────────────
  function relay(detail) {
    window.dispatchEvent(new CustomEvent("__ext_relay__", { detail }));
  }

  // ─── Hook XHR ─────────────────────────────────────────────────
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__meta = { method: method.toUpperCase(), url: String(url) };
    return _open.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const meta = this.__meta || {};
    if (!shouldHookUrl(meta.url)) {
      return _send.apply(this, [body]);
    }
    const requestId = `xhr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    this.addEventListener("readystatechange", function () {
      if (this.readyState === 4) {
        relay({
          type: "xhr",
          requestId,
          url: meta.url,
          method: meta.method,
          status: this.status,
          headers: this.getAllResponseHeaders(),
          // text/event-stream 也在 responseText 里（XHR 流式支持有限）
          body: this.responseText,
          done: true,
        });
      }
    });

    return _send.apply(this, [body]);
  };

  // ─── Hook Fetch（含 text/event-stream 流）────────────────────
  const _fetch = window.fetch;

  window.fetch = async function (input, init = {}) {
    const requestUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input?.url;
    const url =
      typeof requestUrl === "string" && requestUrl.length > 0
        ? requestUrl
        : window.location.href;
    const method = (
      init.method || (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const shouldHook = shouldHookUrl(url);
    const requestId = `fetch_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    let response;
    try {
      response = await _fetch.apply(this, [input, init]);
    } catch (err) {
      if (shouldHook) {
        relay({ type: "fetch", requestId, url, method, error: err.message });
      }
      throw err;
    }
    if (!shouldHook) {
      return response;
    }

    const contentType = response.headers.get("content-type") || "";
    const isStream =
      contentType.includes("text/event-stream") ||
      contentType.includes("application/stream");

    if (isStream && response.body) {
      // ── 流式：tee 一份 ReadableStream，另一份正常返回给页面 ──
      const [streamForPage, streamForHook] = response.body.tee();

      // 异步消费 hook 那一份，逐块转发
      (async () => {
        const reader = streamForHook.getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              relay({
                type: "fetch_stream",
                requestId,
                url,
                method,
                status: response.status,
                chunk: null,
                done: true,
              });
              break;
            }
            relay({
              type: "fetch_stream",
              requestId,
              url,
              method,
              status: response.status,
              chunk: decoder.decode(value, { stream: true }),
              done: false,
            });
          }
        } catch (e) {
          relay({
            type: "fetch_stream",
            requestId,
            url,
            method,
            error: e.message,
            done: true,
          });
        }
      })();

      // 把 tee 出的另一份还给页面（headers 等不变）
      return new Response(streamForPage, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } else {
      // ── 非流式：clone 后读取 ──
      const cloned = response.clone();
      cloned
        .text()
        .then((body) => {
          relay({
            type: "fetch",
            requestId,
            url,
            method,
            status: response.status,
            contentType,
            body,
            done: true,
          });
        })
        .catch(() => {});

      return response;
    }
  };
})();
