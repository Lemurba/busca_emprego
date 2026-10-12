// Roda antes da primeira pintura para aplicar o tema salvo (CSP permite só scripts de 'self').
(function () {
  var theme = "light";
  try {
    var saved = localStorage.getItem("radar-theme");
    theme = saved === "dark" || (!saved && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
  } catch (error) { /* sem acesso ao armazenamento: tema claro */ }
  document.documentElement.dataset.theme = theme;
})();
