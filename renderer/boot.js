// Tema diterapkan sebelum cat pertama supaya tidak ada kilatan terang (CSP melarang skrip inline,
// jadi potongan kecil ini dimuat sebagai berkas).
(function () {
  var pref = 'system';
  try { pref = localStorage.getItem('kk-theme') || 'system'; } catch (e) { /* abaikan */ }
  var dark = pref === 'dark' || (pref === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();
