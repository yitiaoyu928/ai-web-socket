// 全局变量
let detectedElements = [];
let panelContainer = null;
let isPanelVisible = false;

// 元素选择器配置
const SELECTORS = {
  inputs: [
    'input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]):not([type="file"])',
    'textarea',
    'div[contenteditable="true"]'
  ],
  buttons: [
    'button',
    'input[type="button"]',
    'input[type="submit"]',
    '[role="button"]'
  ]
};

// 扫描页面元素
function scanPageElements() {
  detectedElements = [];
  let index = 0;

  // 扫描输入框
  SELECTORS.inputs.forEach(selector => {
    const elements = document.querySelectorAll(selector);
    elements.forEach(el => {
      const rect = el.getBoundingClientRect();
      // 只收集可见元素
      if (rect.width > 0 && rect.height > 0) {
        detectedElements.push({
          index: index++,
          type: el.tagName.toLowerCase() === 'div' ? 'editable' : 'input',
          tagName: el.tagName.toLowerCase(),
          id: el.id || '',
          name: el.name || '',
          placeholder: el.placeholder || '',
          value: el.value || el.textContent || '',
          text: el.textContent?.trim().substring(0, 50) || '',
          label: getLabel(el),
          rect: {
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height
          }
        });
      }
    });
  });

  // 扫描按钮
  SELECTORS.buttons.forEach(selector => {
    const elements = document.querySelectorAll(selector);
    elements.forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        detectedElements.push({
          index: index++,
          type: 'button',
          tagName: el.tagName.toLowerCase(),
          id: el.id || '',
          name: el.name || '',
          text: el.textContent?.trim().substring(0, 50) || el.value || '',
          label: getLabel(el),
          rect: {
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height
          }
        });
      }
    });
  });

  return detectedElements;
}

// 获取元素的标签文本
function getLabel(element) {
  // 尝试通过 for 属性查找 label
  if (element.id) {
    const label = document.querySelector(`label[for="${element.id}"]`);
    if (label) return label.textContent.trim();
  }
  
  // 尝试查找父级 label
  const parentLabel = element.closest('label');
  if (parentLabel) return parentLabel.textContent.trim();
  
  // 返回 placeholder 或文本
  return element.placeholder || element.textContent?.trim().substring(0, 30) || '';
}

// 高亮元素
function highlightElement(elementIndex, highlight = true) {
  const element = detectedElements.find(el => el.index === elementIndex);
  if (!element) return;

  const selector = getElementSelector(element);
  const el = document.querySelector(selector);
  if (!el) return;

  if (highlight) {
    el.style.outline = '3px solid #4CAF50';
    el.style.outlineOffset = '2px';
    el.style.boxShadow = '0 0 10px rgba(76, 175, 80, 0.5)';
  } else {
    el.style.outline = '';
    el.style.outlineOffset = '';
    el.style.boxShadow = '';
  }
}

// 获取元素的选择器
function getElementSelector(element) {
  if (element.id) return `#${element.id}`;
  if (element.name) return `${element.tagName}[name="${element.name}"]`;
  return `${element.tagName}[data-ai-index="${element.index}"]`;
}

// 填充元素内容
function fillElement(elementIndex, value) {
  const element = detectedElements.find(el => el.index === elementIndex);
  if (!element) return { success: false, error: '元素不存在' };

  const selector = getElementSelector(element);
  const el = document.querySelector(selector);
  
  if (!el) {
    return { success: false, error: '未找到元素' };
  }

  try {
    if (element.type === 'input' || element.tagName === 'textarea') {
      el.value = value;
      // 触发 input 事件
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (element.type === 'editable') {
      el.textContent = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// 点击元素
function clickElement(elementIndex) {
  const element = detectedElements.find(el => el.index === elementIndex);
  if (!element) return { success: false, error: '元素不存在' };

  const selector = getElementSelector(element);
  const el = document.querySelector(selector);
  
  if (!el) {
    return { success: false, error: '未找到元素' };
  }

  try {
    el.click();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// 注入悬浮面板
function injectPanel() {
  if (panelContainer) {
    togglePanel();
    return;
  }

  // 创建容器
  panelContainer = document.createElement('div');
  panelContainer.id = 'ai-web-assistant-panel';
  panelContainer.style.cssText = `
    position: fixed;
    top: 100px;
    right: 20px;
    z-index: 2147483647;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  `;

  // 创建 Shadow DOM
  const shadow = panelContainer.attachShadow({ mode: 'open' });

  // 加载面板 HTML
  const panelHTML = `
    <style>
      * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
      }
      
      .panel {
        width: 400px;
        max-height: 80vh;
        background: white;
        border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }
      
      .panel-header {
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color: white;
        padding: 16px 20px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        cursor: move;
        user-select: none;
      }
      
      .panel-title {
        font-size: 18px;
        font-weight: 600;
      }
      
      .panel-controls {
        display: flex;
        gap: 8px;
      }
      
      .panel-btn {
        background: rgba(255, 255, 255, 0.2);
        border: none;
        color: white;
        width: 28px;
        height: 28px;
        border-radius: 6px;
        cursor: pointer;
        font-size: 16px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 0.2s;
      }
      
      .panel-btn:hover {
        background: rgba(255, 255, 255, 0.3);
      }
      
      .panel-content {
        padding: 20px;
        overflow-y: auto;
        max-height: calc(80vh - 60px);
      }
      
      .panel-content.minimized {
        display: none;
      }
      
      .section {
        margin-bottom: 20px;
      }
      
      .section-title {
        font-size: 14px;
        font-weight: 600;
        color: #333;
        margin-bottom: 10px;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      
      .scan-btn {
        width: 100%;
        padding: 12px;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color: white;
        border: none;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        transition: transform 0.2s, box-shadow 0.2s;
      }
      
      .scan-btn:hover {
        transform: translateY(-2px);
        box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
      }
      
      .scan-btn:active {
        transform: translateY(0);
      }
      
      .filter-tabs {
        display: flex;
        gap: 8px;
        margin-bottom: 12px;
      }
      
      .filter-tab {
        flex: 1;
        padding: 8px;
        background: #f5f5f5;
        border: 2px solid transparent;
        border-radius: 6px;
        font-size: 12px;
        cursor: pointer;
        transition: all 0.2s;
        text-align: center;
      }
      
      .filter-tab.active {
        background: #667eea;
        color: white;
        border-color: #667eea;
      }
      
      .element-list {
        max-height: 250px;
        overflow-y: auto;
        border: 1px solid #e0e0e0;
        border-radius: 8px;
        background: #fafafa;
      }
      
      .element-item {
        padding: 10px 12px;
        border-bottom: 1px solid #e0e0e0;
        cursor: pointer;
        transition: background 0.2s;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      
      .element-item:last-child {
        border-bottom: none;
      }
      
      .element-item:hover {
        background: #f0f0f0;
      }
      
      .element-item.selected {
        background: #e3f2fd;
        border-left: 3px solid #667eea;
      }
      
      .element-checkbox {
        width: 16px;
        height: 16px;
        cursor: pointer;
      }
      
      .element-info {
        flex: 1;
        overflow: hidden;
      }
      
      .element-type {
        font-size: 11px;
        color: #667eea;
        font-weight: 600;
        text-transform: uppercase;
      }
      
      .element-label {
        font-size: 13px;
        color: #333;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      
      .file-input-wrapper {
        position: relative;
        overflow: hidden;
        display: inline-block;
        width: 100%;
      }
      
      .file-input-wrapper input[type=file] {
        position: absolute;
        left: -9999px;
      }
      
      .file-input-label {
        display: block;
        padding: 12px;
        background: #f5f5f5;
        border: 2px dashed #ccc;
        border-radius: 8px;
        text-align: center;
        cursor: pointer;
        transition: all 0.2s;
      }
      
      .file-input-label:hover {
        background: #e8e8e8;
        border-color: #667eea;
      }
      
      .file-name {
        font-size: 12px;
        color: #666;
        margin-top: 8px;
        word-break: break-all;
      }
      
      .action-btn {
        width: 100%;
        padding: 12px;
        background: #4CAF50;
        color: white;
        border: none;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        margin-top: 8px;
        transition: all 0.2s;
      }
      
      .action-btn:hover {
        background: #45a049;
        transform: translateY(-2px);
        box-shadow: 0 4px 12px rgba(76, 175, 80, 0.3);
      }
      
      .action-btn:disabled {
        background: #ccc;
        cursor: not-allowed;
        transform: none;
      }
      
      .action-btn.secondary {
        background: #2196F3;
      }
      
      .action-btn.secondary:hover {
        background: #1976D2;
      }
      
      .empty-state {
        text-align: center;
        padding: 30px;
        color: #999;
        font-size: 13px;
      }
      
      .toast {
        position: fixed;
        bottom: 20px;
        left: 50%;
        transform: translateX(-50%);
        padding: 12px 24px;
        background: #333;
        color: white;
        border-radius: 8px;
        font-size: 14px;
        z-index: 2147483647;
        animation: slideUp 0.3s ease;
      }
      
      @keyframes slideUp {
        from {
          transform: translateX(-50%) translateY(100px);
          opacity: 0;
        }
        to {
          transform: translateX(-50%) translateY(0);
          opacity: 1;
        }
      }
      
      .stats {
        font-size: 12px;
        color: #666;
        margin-bottom: 8px;
      }
    </style>
    
    <div class="panel">
      <div class="panel-header">
        <div class="panel-title">🤖 AI 助手</div>
        <div class="panel-controls">
          <button class="panel-btn" id="minimizeBtn">─</button>
          <button class="panel-btn" id="closeBtn">×</button>
        </div>
      </div>
      
      <div class="panel-content" id="panelContent">
        <div class="section">
          <button class="scan-btn" id="scanBtn">🔍 扫描页面元素</button>
        </div>
        
        <div class="section" id="elementSection" style="display: none;">
          <div class="section-title">📋 检测到的元素</div>
          <div class="stats" id="stats"></div>
          <div class="filter-tabs">
            <button class="filter-tab active" data-filter="all">全部</button>
            <button class="filter-tab" data-filter="input">输入框</button>
            <button class="filter-tab" data-filter="button">按钮</button>
          </div>
          <div class="element-list" id="elementList"></div>
        </div>
        
        <div class="section">
          <div class="section-title">📁 文件操作</div>
          <div class="file-input-wrapper">
            <input type="file" id="fileInput" accept=".txt,.json,.xml,.csv,.md,.html,.js,.css">
            <label for="fileInput" class="file-input-label">
              <div>📄 点击选择文件</div>
              <div class="file-name" id="fileName">未选择文件</div>
            </label>
          </div>
          <button class="action-btn" id="fillBtn" disabled>📝 填充到选中输入框</button>
        </div>
        
        <div class="section">
          <div class="section-title">⚡ 执行操作</div>
          <button class="action-btn secondary" id="clickBtn" disabled>👆 点击选中按钮</button>
        </div>
      </div>
    </div>
  `;

  shadow.innerHTML = panelHTML;
  document.body.appendChild(panelContainer);

  // 绑定事件
  bindPanelEvents(shadow);
  isPanelVisible = true;
}

// 绑定面板事件
function bindPanelEvents(shadow) {
  const panel = shadow.querySelector('.panel');
  const panelHeader = shadow.querySelector('.panel-header');
  const panelContent = shadow.querySelector('.panel-content');
  const scanBtn = shadow.querySelector('#scanBtn');
  const minimizeBtn = shadow.querySelector('#minimizeBtn');
  const closeBtn = shadow.querySelector('#closeBtn');
  const fileInput = shadow.querySelector('#fileInput');
  const fileName = shadow.querySelector('#fileName');
  const fillBtn = shadow.querySelector('#fillBtn');
  const clickBtn = shadow.querySelector('#clickBtn');
  const elementList = shadow.querySelector('#elementList');
  const elementSection = shadow.querySelector('#elementSection');
  const stats = shadow.querySelector('#stats');
  const filterTabs = shadow.querySelectorAll('.filter-tab');

  let selectedElements = new Set();
  let currentFilter = 'all';
  let fileContent = null;

  // 拖拽功能
  let isDragging = false;
  let currentX;
  let currentY;
  let initialX;
  let initialY;
  let xOffset = 0;
  let yOffset = 0;

  panelHeader.addEventListener('mousedown', dragStart);
  document.addEventListener('mouseup', dragEnd);
  document.addEventListener('mousemove', drag);

  function dragStart(e) {
    initialX = e.clientX - xOffset;
    initialY = e.clientY - yOffset;
    isDragging = true;
  }

  function dragEnd(e) {
    initialX = currentX;
    initialY = currentY;
    isDragging = false;
  }

  function drag(e) {
    if (isDragging) {
      e.preventDefault();
      currentX = e.clientX - initialX;
      currentY = e.clientY - initialY;
      xOffset = currentX;
      yOffset = currentY;

      panelContainer.style.transform = `translate(${currentX}px, ${currentY}px)`;
    }
  }

  // 最小化/展开
  minimizeBtn.addEventListener('click', () => {
    panelContent.classList.toggle('minimized');
    minimizeBtn.textContent = panelContent.classList.contains('minimized') ? '□' : '─';
  });

  // 关闭面板
  closeBtn.addEventListener('click', () => {
    togglePanel();
  });

  // 扫描按钮
  scanBtn.addEventListener('click', () => {
    const elements = scanPageElements();
    renderElementList(elements);
    showToast(`扫描完成,找到 ${elements.length} 个元素`);
  });

  // 筛选标签
  filterTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      filterTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentFilter = tab.dataset.filter;
      renderElementList(detectedElements);
    });
  });

  // 文件选择
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      fileName.textContent = file.name;
      const reader = new FileReader();
      reader.onload = (event) => {
        fileContent = event.target.result;
        fillBtn.disabled = selectedElements.size === 0;
        showToast('文件读取成功');
      };
      reader.readAsText(file);
    }
  });

  // 填充按钮
  fillBtn.addEventListener('click', () => {
    if (!fileContent) {
      showToast('请先选择文件');
      return;
    }

    let successCount = 0;
    selectedElements.forEach(index => {
      const element = detectedElements.find(el => el.index === index);
      if (element && (element.type === 'input' || element.type === 'editable')) {
        const result = fillElement(index, fileContent);
        if (result.success) successCount++;
      }
    });

    showToast(`成功填充 ${successCount} 个元素`);
  });

  // 点击按钮
  clickBtn.addEventListener('click', () => {
    let successCount = 0;
    selectedElements.forEach(index => {
      const element = detectedElements.find(el => el.index === index);
      if (element && element.type === 'button') {
        const result = clickElement(index);
        if (result.success) successCount++;
      }
    });

    showToast(`成功点击 ${successCount} 个按钮`);
  });

  // 渲染元素列表
  function renderElementList(elements) {
    if (elements.length === 0) {
      elementSection.style.display = 'none';
      return;
    }

    elementSection.style.display = 'block';
    
    const filtered = currentFilter === 'all' 
      ? elements 
      : elements.filter(el => el.type === currentFilter);

    const inputCount = elements.filter(el => el.type === 'input' || el.type === 'editable').length;
    const buttonCount = elements.filter(el => el.type === 'button').length;
    stats.textContent = `共 ${elements.length} 个元素 | 输入框: ${inputCount} | 按钮: ${buttonCount}`;

    elementList.innerHTML = '';
    filtered.forEach(element => {
      const item = document.createElement('div');
      item.className = 'element-item';
      if (selectedElements.has(element.index)) {
        item.classList.add('selected');
      }

      const typeLabel = element.type === 'button' ? '按钮' : 
                       element.type === 'editable' ? '可编辑区域' : '输入框';
      const label = element.label || element.text || element.placeholder || '未命名';

      item.innerHTML = `
        <input type="checkbox" class="element-checkbox" ${selectedElements.has(element.index) ? 'checked' : ''}>
        <div class="element-info">
          <div class="element-type">${typeLabel}</div>
          <div class="element-label">${label}</div>
        </div>
      `;

      // 复选框事件
      const checkbox = item.querySelector('.element-checkbox');
      checkbox.addEventListener('change', (e) => {
        e.stopPropagation();
        if (e.target.checked) {
          selectedElements.add(element.index);
        } else {
          selectedElements.delete(element.index);
        }
        updateButtonStates();
        renderElementList(detectedElements);
      });

      // 点击项高亮
      item.addEventListener('mouseenter', () => {
        highlightElement(element.index, true);
      });

      item.addEventListener('mouseleave', () => {
        highlightElement(element.index, false);
      });

      elementList.appendChild(item);
    });

    updateButtonStates();
  }

  // 更新按钮状态
  function updateButtonStates() {
    const hasInputSelected = Array.from(selectedElements).some(index => {
      const el = detectedElements.find(e => e.index === index);
      return el && (el.type === 'input' || el.type === 'editable');
    });

    const hasButtonSelected = Array.from(selectedElements).some(index => {
      const el = detectedElements.find(e => e.index === index);
      return el && el.type === 'button';
    });

    fillBtn.disabled = !hasInputSelected || !fileContent;
    clickBtn.disabled = !hasButtonSelected;
  }

  // 显示提示
  function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    shadow.querySelector('.panel').appendChild(toast);

    setTimeout(() => {
      toast.remove();
    }, 2000);
  }
}

// 切换面板显示
function togglePanel() {
  if (panelContainer) {
    panelContainer.remove();
    panelContainer = null;
    isPanelVisible = false;
  } else {
    injectPanel();
  }
}

// 监听来自 popup 的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'togglePanel') {
    togglePanel();
    sendResponse({ success: true, visible: isPanelVisible });
  } else if (request.action === 'scanElements') {
    const elements = scanPageElements();
    sendResponse({ success: true, elements });
  } else if (request.action === 'showPanel') {
    if (!isPanelVisible) {
      injectPanel();
    }
    sendResponse({ success: true });
  }
});
