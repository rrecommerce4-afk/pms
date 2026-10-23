// Social Media Studio — small progressive enhancements. Every action is a normal form POST
// validated on the server; this script only opens the input modals and tidies controls.
(function () {
  function pad(n) { return String(n).padStart(2, '0'); }
  // Current date/time as "YYYY-MM-DDTHH:mm" in the PMS business time zone (the server reads
  // form times in that zone), falling back to the browser's own zone.
  function nowLocal(tz) {
    var d = new Date();
    if (tz && window.Intl) {
      try {
        var p = {};
        new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
          .formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
        return p.year + '-' + p.month + '-' + p.day + 'T' + p.hour + ':' + p.minute;
      } catch (e) { /* unknown zone: use the browser's */ }
    }
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
      modal.querySelectorAll('[data-now]').forEach(function (el) { var n = nowLocal(el.getAttribute('data-tz')); el.value = n; el.max = n; });
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
    var msg = (e.submitter && e.submitter.getAttribute('data-confirm')) || e.target.getAttribute('data-confirm');
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

  // ---------------------------------------------------------------- publishing slots
  // Suggestions only: the server recalculates the editing deadline (publish − 24h) on save.
  var DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  function pad2(n) { return String(n).padStart(2, '0'); }
  function toInputValue(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function parseInputValue(v) { var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v || ''); return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5]) : null; }
  function fmtSlot(t) { var p = t.split(':'), h = +p[0]; return (h % 12 || 12) + ':' + p[1] + ' ' + (h < 12 ? 'AM' : 'PM'); }
  function fmtWhen(d) { return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) + ', ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); }
  function slotsOn(week, day) {
    var cfg = week && week[DAY_KEYS[day.getDay()]];
    if (!cfg || !cfg.enabled) return [];
    return cfg.slots.map(function (t) { var p = t.split(':'); return { t: t, at: new Date(day.getFullYear(), day.getMonth(), day.getDate(), +p[0], +p[1]) }; });
  }
  function nextSlot(week, after) {
    for (var i = 0; i <= 14; i++) {
      var day = new Date(after.getFullYear(), after.getMonth(), after.getDate() + i);
      var hit = slotsOn(week, day).filter(function (s) { return s.at > after; })[0];
      if (hit) return hit.at;
    }
    return null;
  }
  document.querySelectorAll('[data-sm-publish]').forEach(function (block) {
    var form = block.closest('form');
    var schedule = {};
    try { schedule = JSON.parse(block.getAttribute('data-schedule') || '{}'); } catch (e) { schedule = {}; }
    var input = block.querySelector('[data-publish-input]');
    var panel = block.querySelector('[data-slot-panel]');
    var preview = block.querySelector('[data-deadline-preview]');
    var box = form.querySelector('input[name=hasPublishAt]');
    var pageSel = form.querySelector('select[name=pageId]');
    var pageHidden = form.querySelector('input[type=hidden][name=pageId]');
    var shootInput = form.querySelector('input[name=shootAt]');
    var editDone = block.getAttribute('data-edit-done') === '1';
    function pageId() { return pageHidden ? pageHidden.value : pageSel.value; }
    function pageName() { var o = pageSel && pageSel.options[pageSel.selectedIndex]; return o ? o.text.replace(/\s*\(.*\)$/, '') : 'this page'; }
    function button(label, date) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'btn small outline'; b.textContent = label;
      b.addEventListener('click', function () { input.value = toInputValue(date); if (box && !box.checked) { box.checked = true; box.dispatchEvent(new Event('change')); } render(); });
      return b;
    }
    function render() {
      var week = schedule[pageId()];
      // "now" as wall-clock time in the PMS time zone, like the slot and input values.
      var now = parseInputValue(nowLocal(block.getAttribute('data-tz'))) || new Date();
      var shoot = parseInputValue(shootInput && shootInput.value) || now;
      // Until editing is done, a suggested slot must leave 24 h for editing after the shoot.
      var base = shoot > now ? shoot : now;
      var after = editDone ? now : new Date(base.getTime() + 24 * 3600000);
      panel.textContent = '';
      var hasAny = week && Object.keys(week).some(function (k) { return week[k].enabled && week[k].slots.length; });
      if (!hasAny) {
        panel.textContent = 'No publishing schedule is configured for ' + pageName() + ' — choose a time, or configure it in Settings → Publishing Schedule.';
      } else {
        var chosen = parseInputValue(input.value);
        var day = chosen || after;
        var todays = slotsOn(week, day);
        var line = document.createElement('div');
        line.className = 'sm-slot-line';
        line.appendChild(document.createTextNode(todays.length ? 'Slots on ' + day.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' }) + ': ' : 'No publishing slot on ' + day.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' }) + '. '));
        todays.forEach(function (s) { line.appendChild(button(fmtSlot(s.t), s.at)); });
        panel.appendChild(line);
        var next = nextSlot(week, after);
        var line2 = document.createElement('div');
        line2.className = 'sm-slot-line';
        if (next) { line2.appendChild(document.createTextNode('Next suitable ' + pageName() + ' slot' + (editDone ? '' : ' (leaves 24 h for editing after the shoot)') + ': ' + fmtWhen(next) + ' ')); line2.appendChild(button('Use this slot', next)); }
        else line2.textContent = 'No upcoming slot in the next two weeks.';
        panel.appendChild(line2);
      }
      var pub = box && !box.checked ? null : parseInputValue(input.value);
      if (!pub) { preview.textContent = 'No publishing time → no editing deadline yet. Editing must be completed 24 hours before the publishing time once it is set.'; return; }
      var dl = new Date(pub.getTime() - 24 * 3600000);
      preview.innerHTML = '';
      preview.appendChild(document.createTextNode('Editing deadline: '));
      var b = document.createElement('b'); b.textContent = fmtWhen(dl); preview.appendChild(b);
      preview.appendChild(document.createTextNode(' (24 hours before publishing)'));
      if (dl <= now) { var w = document.createElement('b'); w.className = 'red-txt'; w.textContent = ' — already passed: editing would be overdue immediately'; preview.appendChild(w); }
    }
    [input, pageSel, shootInput, box].forEach(function (el) { if (el) { el.addEventListener('change', render); el.addEventListener('input', render); } });
    render();
  });

  // ---------------------------------------------------------------- weekly schedule editor
  document.addEventListener('click', function (e) {
    var add = e.target.closest('[data-add-slot]');
    if (add) {
      var list = add.parentNode.querySelector('[data-slot-list]');
      var tpl = document.createElement('span');
      tpl.className = 'sm-slot';
      tpl.innerHTML = '<input type="time" name="' + add.getAttribute('data-add-slot') + '_slots" required aria-label="Publishing time"><button type="button" class="sm-slot-x" data-remove-slot aria-label="Remove this slot">×</button>';
      list.appendChild(tpl);
      tpl.querySelector('input').focus();
      var en = add.closest('tr').querySelector('input[type=checkbox]');
      if (en) en.checked = true;
      return;
    }
    var rm = e.target.closest('[data-remove-slot]');
    if (rm) rm.closest('.sm-slot').remove();
  });

  // ---------------------------------------------------------------- Manage reels (bulk select)
  document.querySelectorAll('[data-bulk-form]').forEach(function (form) {
    var all = form.querySelector('[data-select-all]');
    var boxes = form.querySelectorAll('[data-row-check]');
    var label = form.querySelector('[data-selected-count]');
    function sync() {
      var n = 0;
      boxes.forEach(function (b) { if (b.checked) n++; });
      if (label) label.textContent = n + ' selected';
      if (all) { all.checked = n > 0 && n === boxes.length; all.indeterminate = n > 0 && n < boxes.length; }
      form.querySelectorAll('button[type=submit]').forEach(function (btn) { btn.disabled = n === 0; });
    }
    if (all) all.addEventListener('change', function () { boxes.forEach(function (b) { b.checked = all.checked; }); sync(); });
    boxes.forEach(function (b) { b.addEventListener('change', sync); });
    sync();
  });

  // Close the notifications panel when clicking elsewhere.
  document.addEventListener('click', function (e) {
    document.querySelectorAll('details.sm-notif[open]').forEach(function (d) { if (!d.contains(e.target)) d.removeAttribute('open'); });
  });
})();
