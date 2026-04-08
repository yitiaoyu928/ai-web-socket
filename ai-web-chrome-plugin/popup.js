// 获取当前活动标签页
async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// 更新状态显示
function updateStatus(message) {
  document.getElementById('status').textContent = message;
}

// 打开/关闭悬浮面板
document.getElementById('togglePanel').addEventListener('click', async () => {
  try {
    const tab = await getCurrentTab();
    
    chrome.tabs.sendMessage(tab.id, { action: 'togglePanel' }, (response) => {
      if (chrome.runtime.lastError) {
        updateStatus('错误: 无法连接到页面');
        return;
      }
      
      if (response && response.success) {
        updateStatus(response.visible ? '面板已打开' : '面板已关闭');
      }
    });
  } catch (error) {
    updateStatus('错误: ' + error.message);
  }
});

// 快速扫描页面
document.getElementById('scanPage').addEventListener('click', async () => {
  try {
    updateStatus('正在扫描页面...');
    const tab = await getCurrentTab();
    
    // 先确保面板已打开
    chrome.tabs.sendMessage(tab.id, { action: 'showPanel' }, () => {
      if (chrome.runtime.lastError) {
        updateStatus('错误: 无法连接到页面');
        return;
      }
      
      // 然后扫描元素
      setTimeout(() => {
        chrome.tabs.sendMessage(tab.id, { action: 'scanElements' }, (response) => {
          if (chrome.runtime.lastError) {
            updateStatus('错误: 扫描失败');
            return;
          }
          
          if (response && response.success) {
            const count = response.elements.length;
            updateStatus(`扫描完成,找到 ${count} 个元素`);
          }
        });
      }, 500);
    });
  } catch (error) {
    updateStatus('错误: ' + error.message);
  }
});

// 页面加载时检查状态
document.addEventListener('DOMContentLoaded', () => {
  updateStatus('准备就绪');
});
