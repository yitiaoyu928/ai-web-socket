let state = {
  currentTab: null,
  linkStatus: "unlink",
  model: "-----",
};
let messages = [];
let messageRef = null;
let p = new Proxy(state, {
  get: (target, key) => target[key],
  set: (target, key, value) => {
    target[key] = value;
    updateStatus();
    return true;
  },
});
let pMessage = new Proxy(messages, {
  get: (target, key) => target[key],
  set: (target, key, value) => {
    target[key] = value;
    updateMessage();
    return true;
  },
});
function updateStatus() {
  const status = document.getElementById("status");
  const btn = document.getElementById("connect-btn");
  const statusDot = document.getElementById("status-dot");

  if (p.linkStatus === "link") {
    btn.textContent = "断开连接";
    btn.className = "i-btn btn-disconnect";
    status.textContent = "已连接";
    status.className = "status connected";
    statusDot.className = "status-dot dot-connected";
  } else {
    btn.textContent = "连接 WebSocket";
    btn.className = "i-btn btn-connect";
    status.textContent = "未连接";
    status.className = "status disconnected";
    statusDot.className = "status-dot dot-disconnected";
  }
}
function updateMessage() {
  if (!messageRef) {
    messageRef = document.getElementById("message-log");
  }
  messageRef.innerHTML = "";

  const fragment = document.createDocumentFragment();
  pMessage.forEach((item) => {
    const messageElement = document.createElement("div");
    messageElement.className = "message-item";
    messageElement.textContent = `[${item.time}] ${item.content}`;
    fragment.appendChild(messageElement);
  });
  messageRef.appendChild(fragment);
  messageRef.scrollTop = messageRef.scrollHeight;
}
function addMessage(message) {
  pMessage.push({
    time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
    content: message,
  });
}

function connectWs() {
  const wsUrl = document.querySelector("#ws-url").value;
  chrome.runtime.sendMessage(
    {
      action: "connect",
      url: wsUrl,
    },
    (response) => {
      if (chrome.runtime.lastError) {
        console.error("连接失败:", chrome.runtime.lastError.message);
        addMessage("连接失败: " + chrome.runtime.lastError.message);
        return;
      }
      addMessage("正在连接 WebSocket...");
    },
  );
}

function disconnectWs() {
  chrome.runtime.sendMessage({ action: "disconnect" });
  addMessage("正在断开 WebSocket...");
}

async function ensureContentScriptReady(tabId) {
  const loaded = await new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { action: "loaded" }, (response) => {
      if (chrome.runtime.lastError || !response?.success) {
        resolve(false);
        return;
      }
      resolve(true);
    });
  });
  if (loaded) {
    return;
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
  });
  chrome.tabs.sendMessage(tabId, { action: "loaded" }, () => {});
}
// 页面加载时检查状态
document.addEventListener("DOMContentLoaded", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    console.error("无法获取当前标签页");
    return;
  }
  p.currentTab = tab;

  // 从 Background 获取当前状态
  chrome.runtime.sendMessage({ action: "getStatus" }, (response) => {
    if (response) {
      p.linkStatus = response.linkStatus;
      if (response.messageHistory && response.messageHistory.length > 0) {
        messages.splice(0, messages.length, ...response.messageHistory);
        updateMessage();
      }
      updateStatus();
    }
  });

  // 恢复存储的配置
  const stored = await chrome.storage.local.get(["wsUrl", "model"]);
  if (stored.wsUrl) {
    document.querySelector("#ws-url").value = stored.wsUrl;
  }
  if (stored.model) {
    p.model = stored.model;
  }
  document.querySelector(".title").textContent = "当前AI: " + p.model;

  addMessage("初始化完毕！");
  updateStatus();

  await ensureContentScriptReady(p.currentTab.id);

  // 连接/断开按钮
  const connectBtn = document.getElementById("connect-btn");
  connectBtn.addEventListener("click", () => {
    if (p.linkStatus === "unlink") {
      connectWs();
    } else {
      disconnectWs();
    }
  });

  // 监听来自 Background 和 Content Script 的消息
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // 处理 Background 广播的消息
    if (request.type) {
      switch (request.type) {
        case "connected":
          p.linkStatus = "link";
          addMessage(request.message);
          break;
        case "disconnected":
          p.linkStatus = "unlink";
          addMessage(request.message);
          break;
        case "message":
          addMessage("收到: " + request.data);
          break;
        case "error":
          p.linkStatus = "unlink";
          addMessage(request.message);
          break;
        case "pageRefreshed":
          addMessage("检测到页面刷新");
          break;
        case "detect":
          if (request.data?.model) {
            p.model = request.data.model;
            document.querySelector(".title").textContent = "当前AI: " + p.model;
            addMessage(request.data.message + " " + request.data.model);
          }
          break;
      }
    }

    // 处理 Content Script 的直接消息（不处理 Background 转发的）
    if (request.action && sender.tab) {
      // sender.tab 存在说明消息来自 Content Script
      switch (request.action) {
        case "detect":
          document.querySelector(".title").textContent =
            "当前AI: " + request.data.model;
          p.model = request.data.model;
          addMessage(request.data.message + " " + request.data.model);
          break;
      }
    }
  });
});
