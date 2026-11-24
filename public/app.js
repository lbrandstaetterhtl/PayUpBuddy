// Confirmation prompts for destructive forms (no inline handlers, CSP-friendly).
document.addEventListener('submit', (e) => {
  const msg = e.target.dataset?.confirm;
  if (msg && !window.confirm(msg)) e.preventDefault();
});
