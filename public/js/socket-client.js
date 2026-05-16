// ==================== 共享 Socket.IO 客户端 ====================
const socket = io({
  transports: ['websocket', 'polling']
});

socket.on('connect', () => {
  console.log('[Socket] 已连接');
});

socket.on('disconnect', () => {
  console.log('[Socket] 已断开');
});

socket.on('error', (msg) => {
  toast(msg, 'error');
});

// ==================== Toast 提示 ====================
function toast(msg, type = 'info') {
  const container = document.querySelector('.toast-container');
  if (!container) {
    const div = document.createElement('div');
    div.className = 'toast-container';
    document.body.appendChild(div);
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.querySelector('.toast-container').appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(-10px)';
    el.style.transition = 'all 0.3s ease';
    setTimeout(() => el.remove(), 300);
  }, 2500);
}
