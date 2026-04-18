const AI_WEB_CONTENT_VERSION = "2026-04-18.2";
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
  window.__AI_WEB_AGENT_STATUS = null;

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
          } catch (error) { }
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
    inputs: [
      ".message-input-textarea",
      "textarea",
      "[contenteditable='true']",
    ],
    buttons: [
      ".send-button",
      "button[type='submit']",
      "button[aria-label*='Send']",
    ],
    isInput: true,
  });
  aiUrlMap.set("Claude", {
    inputs: [
      "div[contenteditable='true']",
      "div[contenteditable='plaintext-only']",
      "textarea",
    ],
    buttons: [
      "button[aria-label='Send message']",
      "button[aria-label='Send Message']",
      "button[data-testid='send-button']",
      "button[type='submit']",
    ],
    isInput: false,
  });
  aiUrlMap.set("GPT", {
    inputs: [
      "div[contenteditable='true']",
      "div[contenteditable='plaintext-only']",
      "textarea",
    ],
    buttons: [
      "button[aria-label='Send message']",
      "button[aria-label='Send Message']",
      "button[data-testid='send-button']",
      "button[type='submit']",
    ],
    isInput: false,
  });

  function findFirstElement(selectors) {
    if (!Array.isArray(selectors)) {
      return null;
    }
    for (const selector of selectors) {
      try {
        const element = document.querySelector(selector);
        if (element) {
          return element;
        }
      } catch (error) { }
    }
    return null;
  }

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
    } else if (window.location.href.includes("chatgpt")) {
      ai = "GPT";
      safeSendRuntimeMessage({
        action: "detect",
        data: { message: "AI检测成功", model: "ChatGPT" },
      });
      return;
    }
  }

  function insertText(element, text) {
    element.focus();
    const prototype =
      element instanceof HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    const nativeSetter = descriptor && descriptor.set;
    if (nativeSetter) {
      nativeSetter.call(element, element.value + text);
    } else {
      element.value = `${element.value || ""}${text}`;
    }

    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function insertContentEditableText(element, text) {
    element.focus();
    element.textContent = text;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function triggerSend(inputElement, buttonElement) {
    if (buttonElement) {
      buttonElement.click();
      return;
    }
    inputElement.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
      }),
    );
  }

  function fillMessage(message) {
    if (!ai) {
      autoQuerySelectorElement();
    }
    let elements = aiUrlMap.get(ai);
    if (elements) {
      let inputElement = findFirstElement(elements.inputs);

      if (inputElement) {
        const useNativeInput =
          elements.isInput &&
          (inputElement instanceof HTMLTextAreaElement ||
            inputElement instanceof HTMLInputElement);

        if (useNativeInput) {
          insertText(inputElement, message);
        } else {
          insertContentEditableText(inputElement, message);
        }
        setTimeout(() => {
          let buttonElement = findFirstElement(elements.buttons);
          triggerSend(inputElement, buttonElement);
        }, 500);
      } else {
        console.warn("[Content] input element not found for", ai, elements.inputs);
      }
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
        autoQuerySelectorElement();
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
        if (!ai) {
          autoQuerySelectorElement();
        }
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
        }
        sendResponse({ success: true });
        break;
      case "agent_status":
        window.__AI_WEB_AGENT_STATUS = request.data || null;
        window.dispatchEvent(
          new CustomEvent("__aiws_agent_status__", {
            detail: window.__AI_WEB_AGENT_STATUS,
          }),
        );
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
