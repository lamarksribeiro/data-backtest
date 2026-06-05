const stack = () => document.getElementById('toast-stack');

function push(kind, message, duration) {
  const root = stack();
  if (!root) return;
  const node = document.createElement('div');
  node.className = `toast toast--${kind}`;
  node.textContent = message;
  root.appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transform = 'translateY(8px)';
    node.style.transition = 'opacity 0.18s ease, transform 0.18s ease';
    setTimeout(() => node.remove(), 200);
  }, duration);
}

export const toast = {
  ok: (msg, ms = 3000) => push('ok', msg, ms),
  err: (msg, ms = 5000) => push('err', msg, ms),
  warn: (msg, ms = 4000) => push('warn', msg, ms),
  info: (msg, ms = 3000) => push('ok', msg, ms),
};
