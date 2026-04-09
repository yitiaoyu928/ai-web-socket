if (!window.__AI_WEB_INJECTED) {
  window.__AI_WEB_INJECTED = true;

  let aiUrlMap = new Map();
  let ai = "";

  aiUrlMap.set("Qwen", {
    input: ".message-input-textarea",
    button: ".send-button",
    isInput: true,
  });
  function autoQuerySelectorElement() {
    if (window.location.href.includes("qwen")) {
      ai = "Qwen";
      chrome.runtime.sendMessage({
        action: "detect",
        data: { message: "AI检测成功", model: "通义千问" },
      });
      return;
    }
  }
  function fillMessage(message) {
    let elements = aiUrlMap.get(ai);
    if (elements) {
      let inputElement = document.querySelector(elements.input);
      let buttonElement = document.querySelector(elements.button);
      if (inputElement && buttonElement) {
        if (elements.isInput) {
          inputElement.value = "test";
        }
        buttonElement.click();
      }
    }
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
        sendResponse({ success: true, message: "收到连接通知" });
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
}
