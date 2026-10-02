// Perilaku kerangka halaman (sidebar buka/lipat, tooltip ikon, tema), disalin dari pola template admin KarirLink.
export function initShell() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  const main = document.getElementById('mainColumn');
  const open = () => { sidebar.classList.remove('-translate-x-full'); overlay.classList.remove('hidden'); };
  const close = () => { sidebar.classList.add('-translate-x-full'); overlay.classList.add('hidden'); };
  document.getElementById('openSidebarBtn').addEventListener('click', open);
  document.getElementById('closeSidebarBtn').addEventListener('click', close);
  overlay.addEventListener('click', close);
  window.addEventListener('hashchange', close);

  const KEY = 'repo-hub-sidebar-collapsed';
  const apply = (c) => { sidebar.classList.toggle('sidebar-collapsed', c); main.classList.toggle('lg:pl-[264px]', !c); main.classList.toggle('lg:pl-[72px]', c); };
  let collapsed = false;
  try { collapsed = localStorage.getItem(KEY) === 'true'; } catch { /* abaikan */ }
  apply(collapsed);
  document.getElementById('collapseSidebarBtn').addEventListener('click', () => {
    collapsed = !collapsed; apply(collapsed);
    try { localStorage.setItem(KEY, String(collapsed)); } catch { /* abaikan */ }
  });

  // tooltip tetap (dipakai ikon sidebar saat menu dilipat)
  const tip = document.getElementById('tooltipFixed');
  document.querySelectorAll('[data-tooltip-trigger]').forEach((t) => {
    const show = () => {
      if (t.dataset.tooltipSide === 'right' && !sidebar.classList.contains('sidebar-collapsed')) return;
      tip.textContent = t.dataset.tooltipText; tip.style.opacity = '0';
      requestAnimationFrame(() => {
        const r = t.getBoundingClientRect(), tr = tip.getBoundingClientRect();
        tip.style.left = `${r.right + 8}px`;
        tip.style.top = `${Math.max(8, Math.min(r.top + (r.height - tr.height) / 2, innerHeight - tr.height - 8))}px`;
        tip.style.opacity = '1';
      });
    };
    const hide = () => { tip.style.opacity = '0'; };
    t.addEventListener('mouseenter', show); t.addEventListener('mouseleave', hide);
    t.addEventListener('focus', show); t.addEventListener('blur', hide);
  });
}

export function setActiveNav(key) {
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('nav-item-active', a.dataset.nav === key));
}
