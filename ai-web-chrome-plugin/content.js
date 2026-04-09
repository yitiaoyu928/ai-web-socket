let aiUrlMap = new Map();
let ai = "";

aiUrlMap.set("Qwen", {
  input: ".message-input-textarea",
  button: ".send-button",
  isInput: true,
});
function autoQuerySelectorElement(response) {
  console.log(window.location.href);
  if (window.location.href.includes("qwen")) {
    ai = "Qwen";
    console.log("qwen")
    response({ success: true, message: "网页检测成功！" });
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
    case "connected":
      // WebSocket 连接成功通知
      console.log("WebSocket 已连接");
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

