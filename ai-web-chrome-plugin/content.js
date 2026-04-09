if (!window.__AI_WEB_INJECTED) {
  window.__AI_WEB_INJECTED = true;

  let aiUrlMap = new Map();
  let ai = "";

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
      console.log(123321);
      ai = "Qwen";
      chrome.runtime.sendMessage({
        action: "detect",
        data: { message: "AI检测成功", model: "通义千问" },
      });
      return;
    } else if (window.location.href.includes("claude")) {
      ai = "Claude";
      chrome.runtime.sendMessage({
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
      let buttonElement = document.querySelector(elements.button);

      if (inputElement && buttonElement) {
        if (elements.isInput) {
          insertText(inputElement, message);
        } else {
          inputElement.innerHTML = message;
        }
        setTimeout(() => {
          buttonElement.click();
        }, 500);
      }
    }
  }

  // 页面加载时通知 popup 重置状态
  function notifyPageRefresh() {
    chrome.runtime.sendMessage({
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
        let pMsg = JSON.parse(request.data);
        if (pMsg.type === 1001) {
          fillMessage(pMsg.message);
        }
        break;
      case "executeScript":
        // 执行自定义脚本
        try {
          const evalResult = eval(request.code);
          sendResponse({ success: true, result: evalResult });
        } catch (error) {
          sendResponse({ success: false, error: error.message });
        }
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
}
