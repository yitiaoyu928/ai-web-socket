const AI_WEB_CONTENT_VERSION = "2026-04-10.2";
if (window.__AI_WEB_CONTENT_VERSION !== AI_WEB_CONTENT_VERSION) {
  if (window.__AI_WEB_RELAY_HANDLER) {
    window.removeEventListener("__ext_relay__", window.__AI_WEB_RELAY_HANDLER);
  }
  window.__AI_WEB_INJECTED = false;
}
window.__AI_WEB_CONTENT_VERSION = AI_WEB_CONTENT_VERSION;

if (!window.__AI_WEB_INJECTED) {
  window.__AI_WEB_INJECTED = true;
  window.__AI_WEB_RUNTIME_DEAD = false;
  window.__AI_WEB_RELAY_COUNT = 0;

  let aiUrlMap = new Map();
  let ai = "";

  function safeSendRuntimeMessage(message, callback) {
    try {
      if (
        window.__AI_WEB_RUNTIME_DEAD ||
        typeof chrome === "undefined" ||
        !chrome.runtime ||
        !chrome.runtime.id ||
        !chrome.runtime.sendMessage
      ) {
        return false;
      }
      if (typeof callback === "function") {
        chrome.runtime.sendMessage(message, (response) => {
          try {
            const lastError = chrome.runtime && chrome.runtime.lastError;
            if (lastError) {
              if (String(lastError.message || "").includes("Extension context invalidated")) {
                window.__AI_WEB_RUNTIME_DEAD = true;
              }
              return;
            }
            callback(response);
          } catch (error) {}
        });
      } else {
        const result = chrome.runtime.sendMessage(message);
        if (result && typeof result.catch === "function") {
          result.catch((error) => {
            if (String(error?.message || "").includes("Extension context invalidated")) {
              window.__AI_WEB_RUNTIME_DEAD = true;
            }
          });
        }
      }
      return true;
    } catch (error) {
      if (String(error?.message || "").includes("Extension context invalidated")) {
        window.__AI_WEB_RUNTIME_DEAD = true;
      }
      return false;
    }
  }

  aiUrlMap.set("Qwen", {
    input: ".message-input-textarea",
    button: ".send-button",
    isInput: true,
  });
  aiUrlMap.set("Claude", {
    input: "div[contenteditable='true']",
    button: "button[aria-label='Send message']",
    isInput: false,
  });
  function autoQuerySelectorElement() {
    if (window.location.href.includes("qwen")) {
      ai = "Qwen";
      safeSendRuntimeMessage({
        action: "detect",
        data: { message: "AI检测成功", model: "通义千问" },
      });
      return;
    } else if (window.location.href.includes("claude")) {
      ai = "Claude";
      safeSendRuntimeMessage({
        action: "detect",
        data: { message: "AI检测成功", model: "Claude" },
      });
      return;
    }
  }
  // content.js
  function insertText(element, text) {
    element.focus();

    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    ).set;

    nativeInputValueSetter.call(element, element.value + text);

    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function fillMessage(message) {
    let elements = aiUrlMap.get(ai);
    if (elements) {
      let inputElement = document.querySelector(elements.input);

      if (inputElement) {
        if (elements.isInput) {
          insertText(inputElement, message);
        } else {
          inputElement.focus();
          inputElement.textContent = message;
          inputElement.dispatchEvent(new Event("input", { bubbles: true }));
          inputElement.dispatchEvent(new Event("change", { bubbles: true }));
        }
        setTimeout(() => {
          let buttonElement = document.querySelector(elements.button);
          if (buttonElement) {
            buttonElement.click();
          }
        }, 500);
      }
    }
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function isVisible(el) {
    if (!el) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findClickableByText(text) {
    const wanted = normalizeText(text);
    if (!wanted) {
      return null;
    }
    const selectors = [
      "button",
      "[role='button']",
      "label",
      "li",
      ".option",
      ".choice",
      ".select-option",
    ];
    const all = document.querySelectorAll(selectors.join(","));
    let exactMatch = null;
    let fuzzyMatch = null;
    for (const el of all) {
      if (!isVisible(el)) {
        continue;
      }
      const textContent = normalizeText(el.innerText || el.textContent);
      if (!textContent) {
        continue;
      }
      if (textContent === wanted) {
        exactMatch = el;
        break;
      }
      if (!fuzzyMatch && (textContent.includes(wanted) || wanted.includes(textContent))) {
        fuzzyMatch = el;
      }
    }
    return exactMatch || fuzzyMatch;
  }

  async function runSelectionPlan(plan) {
    const steps = Array.isArray(plan?.steps) ? plan.steps : [];
    for (const step of steps) {
      const optionText = step?.answer || step?.selectedOption || "";
      if (!optionText) {
        continue;
      }
      const target = findClickableByText(optionText);
      if (target) {
        target.click();
      }
      await delay(2000);
    }
    if (typeof plan?.qaText === "string" && plan.qaText.trim()) {
      fillMessage(plan.qaText.trim());
    }
  }

  // 页面加载时通知 popup 重置状态
  function notifyPageRefresh() {
    safeSendRuntimeMessage({
      action: "pageRefreshed",
      data: { url: window.location.href, timestamp: Date.now() },
    });
  }

  // 监听来自 popup 的消息
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log("Content script 收到消息:", request);

    switch (request.action) {
      case "loaded":
        sendResponse({
          success: true,
          data: {
            message: "初始化成功",
            type: "loaded",
          },
        });
        break;
      case "connected":
        // WebSocket 连接成功通知
        autoQuerySelectorElement(sendResponse);
        sendResponse({ success: true, message: "链接成功" });
        // fillMessage("链接成功");
        break;
      case "message_receive":
        let pMsg = null;
        try {
          pMsg =
            typeof request.data === "string"
              ? JSON.parse(request.data)
              : request.data;
        } catch (error) {
          sendResponse({ success: false, message: "消息解析失败" });
          break;
        }
        if (pMsg?.type === 1001 && typeof pMsg.message === "string") {
          fillMessage(pMsg.message);
        } else if (pMsg?.type === 2002 && typeof pMsg.message === "string") {
          try {
            const plan = JSON.parse(pMsg.message);
            runSelectionPlan(plan);
          } catch (error) {}
        }
        sendResponse({ success: true });
        break;

      default:
        sendResponse({ success: false, message: "未知的操作" });
    }

    return true; // 保持消息通道开放以支持异步响应
  });

  // 页面加载完成后通知刷新
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", notifyPageRefresh);
  } else {
    notifyPageRefresh();
  }

  if (!window.__AI_WEB_HOOK_SCRIPT_INJECTED) {
    window.__AI_WEB_HOOK_SCRIPT_INJECTED = true;
    safeSendRuntimeMessage({ action: "injectHookMainWorld" });
  }

  if (!window.__AI_WEB_RELAY_BOUND) {
    window.__AI_WEB_RELAY_BOUND = true;
    window.__AI_WEB_RELAY_HANDLER = (e) => {
      window.__AI_WEB_RELAY_COUNT += 1;
      if (window.__AI_WEB_RELAY_COUNT <= 5 || window.__AI_WEB_RELAY_COUNT % 20 === 0) {
        console.log("[Content Relay] forwarding", {
          count: window.__AI_WEB_RELAY_COUNT,
          type: e.detail?.type,
          url: e.detail?.url,
        });
      }
      const ok = safeSendRuntimeMessage({
        source: "ext_hook",
        payload: e.detail,
      });
      if (!ok || window.__AI_WEB_RUNTIME_DEAD) {
        window.removeEventListener("__ext_relay__", window.__AI_WEB_RELAY_HANDLER);
        window.__AI_WEB_RELAY_BOUND = false;
      }
    };
    window.addEventListener("__ext_relay__", window.__AI_WEB_RELAY_HANDLER);
  }
  console.log("[Content] initialized", {
    version: window.__AI_WEB_CONTENT_VERSION,
    runtimeDead: window.__AI_WEB_RUNTIME_DEAD,
    href: window.location.href,
  });
}
