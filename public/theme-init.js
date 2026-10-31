// Roda antes da primeira pintura para aplicar o tema salvo (CSP permite só scripts de 'self').
(() => {
  let theme = "light";
  try {
    const saved = localStorage.getItem("radar-theme");
    theme = saved === "dark" || (!saved && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
  } catch { /* sem acesso ao armazenamento: tema claro */ }
  document.documentElement.dataset.theme = theme;
})();
