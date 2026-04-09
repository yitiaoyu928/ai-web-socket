// WebSocket 连接对象
let ws = null;

// 保存用户当前浏览的标签页 ID（popup 打开时立即获取）
let currentTabId = null;

// 获取用户正在浏览的标签页（不是 popup 自己的页面）
async function getUserTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  console.log("Popup 获取到的标签页:", tab);
  console.log("标签页 URL:", tab?.url);
  
  // 检查是否获取到了有效的标签页
  if (tab && tab.id) {
    currentTabId = tab.id;
    return tab;
  }
  return null;
}

// 向 content.js 发送消息（使用保存的 tab ID）
async function sendToContent(action, data = {}) {
  if (!currentTabId) {
    addMessage("没有可用的标签页 ID", "error");
    return null;
  }
  
  try {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(currentTabId, { action, ...data }, (response) => {
        if (chrome.runtime.lastError) {
          console.error("发送消息失败:", chrome.runtime.lastError);
          addMessage(`发送失败: ${chrome.runtime.lastError.message}`, "error");
          reject(chrome.runtime.lastError);
        } else {
          console.log("收到 content.js 响应:", response);
          resolve(response);
        }
      });
    });
  } catch (error) {
    console.error("发送消息异常:", error);
    addMessage(`发送异常: ${error.message}`, "error");
    return null;
  }
}

// 添加消息到日志
function addMessage(message, type = "info") {
  const log = document.getElementById("message-log");
  const div = document.createElement("div");
  const timestamp = new Date().toLocaleTimeString();
  div.textContent = `[${timestamp}] ${message}`;
  div.style.color =
    type === "error" ? "#f44336" : type === "success" ? "#4CAF50" : "#333";
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

// 更新连接状态
function updateStatus(connected) {
  const status = document.getElementById("status");
  const btn = document.getElementById("connect-btn");

  if (connected) {
    status.textContent = "已连接";
    status.className = "status connected";
    btn.textContent = "断开连接";
  } else {
    status.textContent = "未连接";
    status.className = "status disconnected";
    btn.textContent = "链接Socket";
  }
}

// 连接 WebSocket
function connectWebSocket(url) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    addMessage("已经处于连接状态", "info");
    return;
  }

  try {
    ws = new WebSocket(url);
    addMessage(`正在连接 ${url}...`, "info");

    ws.onopen = async function () {
      addMessage("连接成功！", "success");

      // 使用保存的 tab ID 通知 content.js
      if (currentTabId) {
        try {
          const response = await sendToContent("connected");
          addMessage(`Content 响应: ${response?.message || "无响应"}`, response?.success ? "success" : "error");
        } catch (error) {
          console.error("发送连接通知失败:", error);
          addMessage("发送连接通知失败", "error");
        }
      } else {
        addMessage("未获取到标签页，无法通知 content.js", "error");
      }

      updateStatus(true);

      // 保存地址到本地存储
      chrome.storage.local.set({ wsUrl: url });
    };

    ws.onmessage = function (event) {
      addMessage(`收到: ${event.data}`, "success");
    };

    ws.onerror = function (error) {
      addMessage("连接错误", "error");
      console.error("WebSocket error:", error);
    };

    ws.onclose = function (event) {
      addMessage(`连接已关闭 (代码: ${event.code})`, "info");
      updateStatus(false);
      ws = null;
    };
  } catch (error) {
    addMessage(`连接失败: ${error.message}`, "error");
    updateStatus(false);
  }
}

// 断开 WebSocket 连接
function disconnectWebSocket() {
  if (ws) {
    ws.close();
    addMessage("主动断开连接", "info");
  }
}

// 发送消息到 WebSocket
function sendMessage(message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(message);
    addMessage(`发送: ${message}`, "info");
  } else {
    addMessage("未连接，无法发送消息", "error");
  }
}

// 页面加载时检查状态
document.addEventListener("DOMContentLoaded", async () => {
  console.log("Popup DOMContentLoaded");

  const urlInput = document.getElementById("ws-url");
  const connectBtn = document.getElementById("connect-btn");

  // ⭐ 重要：popup 打开时立即获取用户正在浏览的标签页
  const userTab = await getUserTab();
  if (userTab) {
    addMessage(`当前页面: ${userTab.title || userTab.url}`, "info");
    console.log("已保存标签页 ID:", currentTabId);
  } else {
    addMessage("无法获取当前标签页", "error");
  }

  // 从本地存储加载上次使用的地址
  chrome.storage.local.get(["wsUrl"], function (result) {
    if (result.wsUrl) {
      urlInput.value = result.wsUrl;
    }
  });

  // 连接/断开按钮点击事件
  connectBtn.addEventListener("click", () => {
    const url = urlInput.value.trim();

    if (!url) {
      addMessage("请输入 WebSocket 地址", "error");
      return;
    }

    if (ws && ws.readyState === WebSocket.OPEN) {
      disconnectWebSocket();
    } else {
      connectWebSocket(url);
    }
  });

  // 回车键快速连接
  urlInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      connectBtn.click();
    }
  });

  // 暴露 sendMessage 到全局，供 content.js 调用
  window.sendMessage = sendMessage;
});
