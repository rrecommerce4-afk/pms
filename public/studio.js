// Social Media Studio — small progressive enhancements. Every action is a normal form POST
// validated on the server; this script only opens the input modals and tidies controls.
(function () {
  function pad(n) { return String(n).padStart(2, '0'); }
  function nowLocal() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  var openModal = null;
  function close() {
    if (openModal) openModal.classList.remove('open');
    openModal = null;
  }

  document.addEventListener('click', function (e) {
    var trigger = e.target.closest('[data-sm-modal]');
    if (trigger) {
      e.preventDefault();
      var modal = document.getElementById('sm-modal-' + trigger.getAttribute('data-sm-modal'));
      if (!modal) return;
      var form = modal.querySelector('form');
      var d = trigger.dataset;
      form.setAttribute('action', d.url);
      form.reset();
      modal.querySelectorAll('[data-fill]').forEach(function (el) {
        var v = d[el.getAttribute('data-fill')];
        var prefix = el.getAttribute('data-prefix') || '';
        el.textContent = v ? prefix + v : (el.getAttribute('data-empty') || el.textContent);
      });
      modal.querySelectorAll('[data-fill-value]').forEach(function (el) { el.value = d[el.getAttribute('data-fill-value')] || ''; });
      modal.querySelectorAll('[data-fill-placeholder]').forEach(function (el) { el.placeholder = d[el.getAttribute('data-fill-placeholder')] || ''; });
      modal.querySelectorAll('[data-now]').forEach(function (el) { el.value = nowLocal(); el.max = nowLocal(); });
      modal.querySelectorAll('[data-show-if]').forEach(function (el) { el.hidden = !d[el.getAttribute('data-show-if')]; });
      modal.querySelectorAll('[data-show-unless]').forEach(function (el) { el.hidden = !!d[el.getAttribute('data-show-unless')]; });
      modal.classList.add('open');
      openModal = modal;
      var first = modal.querySelector('input:not([type=hidden]):not([type=checkbox]), textarea');
      if (first) first.focus();
      return;
    }
    if (e.target.closest('[data-close]') || (openModal && e.target === openModal)) close();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

  // Forms that need a confirmation (e.g. delete).
  document.addEventListener('submit', function (e) {
    var msg = e.target.getAttribute('data-confirm');
    if (msg && !window.confirm(msg)) e.preventDefault();
  });

  // Reporting period: presets submit straight away; "Custom" reveals the date inputs.
  document.querySelectorAll('[data-sm-range]').forEach(function (form) {
    var sel = form.querySelector('select[name=preset]');
    var custom = form.querySelector('.sm-range-custom');
    sel.addEventListener('change', function () {
      if (sel.value === 'custom') { custom.hidden = false; return; }
      form.submit();
    });
  });

  // Filter selects that apply immediately.
  document.querySelectorAll('[data-autosubmit]').forEach(function (el) {
    el.addEventListener('change', function () { el.form.submit(); });
  });

  // Optional date fields in the reel form.
  document.querySelectorAll('[data-toggle-field]').forEach(function (box) {
    var target = document.getElementById(box.getAttribute('data-toggle-field'));
    function sync() { if (target) { target.hidden = !box.checked; var input = target.querySelector('input'); if (input) input.disabled = !box.checked; } }
    box.addEventListener('change', sync);
    sync();
  });

  // Close the notifications panel when clicking elsewhere.
  document.addEventListener('click', function (e) {
    document.querySelectorAll('details.sm-notif[open]').forEach(function (d) { if (!d.contains(e.target)) d.removeAttribute('open'); });
  });
})();
