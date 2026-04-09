let currentTab;
let linkStatus = "unlink";
let ws = null;

function linkWs() {
  const wsUrl = document.querySelector("#ws-url");
  ws = new WebSocket(wsUrl.value);
  ws.onopen = () => {
    console.log("WebSocket 连接成功");
    linkStatus = "link";
  };
  ws.onclose = () => {
    console.log("WebSocket 连接关闭");
    linkStatus = "unlink";
  };
  ws.onmessage = (event) => {
    console.log("WebSocket 接收到消息:", event.data);
  };
}

// 等待 content script 就绪（ping-pong 检测）
function waitForContentReady(tabId, maxRetries = 10, interval = 200) {
  return new Promise((resolve, reject) => {
    let retries = 0;
    const tryPing = () => {
      chrome.tabs.sendMessage(tabId, { action: "ping" }, (response) => {
        if (chrome.runtime.lastError) {
          retries++;
          if (retries >= maxRetries) {
            reject(new Error("Content script 未就绪: " + chrome.runtime.lastError.message));
            return;
          }
          setTimeout(tryPing, interval);
          return;
        }
        if (response && response.success) {
          resolve(response);
        } else {
          retries++;
          if (retries >= maxRetries) {
            reject(new Error("Content script 响应异常"));
            return;
          }
          setTimeout(tryPing, interval);
        }
      });
    };
    tryPing();
  });
}

// 页面加载时检查状态
document.addEventListener("DOMContentLoaded", async () => {
  console.log("Popup DOMContentLoaded 开始");

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    console.error("无法获取当前标签页");
    return;
  }
  currentTab = tab;

  // 先注入 content script
  await chrome.scripting.executeScript({
    target: { tabId: currentTab.id },
    files: ["content.js"],
  });

  // 用 ping-pong 机制等待 content script 就绪
  try {
    await waitForContentReady(currentTab.id);
    console.log("Content script 已就绪");
  } catch (err) {
    console.error(err.message);
    return;
  }

  // 确认就绪后再发送业务消息
  chrome.tabs.sendMessage(currentTab.id, { action: "loaded" }, (response) => {
    if (chrome.runtime.lastError) {
      console.error("发送 loaded 消息失败:", chrome.runtime.lastError.message);
      return;
    }
    console.log("loaded 响应:", response);
    const connectBtn = document.getElementById("connect-btn");
    connectBtn.addEventListener("click", () => {
      console.log(123);
    });
  });
});
