// Injected at the top of every page of a live HTML 교안 (see site.ts). It tells the app
// which slide the page shows and how far it is scrolled, and moves the page when the
// app asks (the teacher moved, or a page button was pressed).
(function () {
  if (window.parent === window) return;
  var app = window.parent;

  // The sandbox blocks web storage. Give the page an in-memory stand-in so it doesn't crash.
  ['localStorage', 'sessionStorage'].forEach(function (name) {
    try {
      if (window[name]) return;
    } catch (e) {}
    var data = new Map();
    var store = {
      getItem: function (k) {
        return data.has(String(k)) ? data.get(String(k)) : null;
      },
      setItem: function (k, v) {
        data.set(String(k), String(v));
      },
      removeItem: function (k) {
        data.delete(String(k));
      },
      clear: function () {
        data.clear();
      },
      key: function (i) {
        var keys = Array.from(data.keys());
        return i < keys.length ? keys[i] : null;
      },
      get length() {
        return data.size;
      },
    };
    try {
      Object.defineProperty(window, name, { value: store, configurable: true });
    } catch (e) {}
  });

  function reveal() {
    var r = window.Reveal;
    return r && typeof r.getIndices === 'function' && (!r.isReady || r.isReady()) ? r : null;
  }
  // The slide number: reveal.js knows it; otherwise the first number in the hash (#/3, #slide-3).
  function page() {
    var r = reveal();
    if (r) return r.getIndices().h + 1;
    var m = /\d+/.exec(location.hash);
    return m ? Math.min(10000, Math.max(1, parseInt(m[0], 10))) : 1;
  }
  function total() {
    var r = reveal();
    if (r) return r.getHorizontalSlides().length;
    var n = document.querySelectorAll('.slide, .slides > section').length;
    return n > 1 ? n : 0; // 0 = unknown, e.g. a scrolling page
  }

  // A move is the viewer's own if they just pressed a key, clicked, scrolled or touched the
  // page, and the app hasn't sent a command since (moves made at the app's request, and the
  // page setting itself up, are not).
  var lastInput = 0;
  var lastCommand = 0;
  ['keydown', 'pointerdown', 'wheel', 'touchstart', 'touchmove'].forEach(function (type) {
    addEventListener(
      type,
      function (e) {
        if (e.isTrusted) lastInput = Date.now();
      },
      { capture: true, passive: true },
    );
  });
  function byViewer() {
    return Date.now() - lastInput < 1000 && lastInput > lastCommand;
  }

  var last = '';
  function report(force) {
    var s = {
      type: 'ss:state',
      page: page(),
      total: total(),
      hash: location.hash,
      x: Math.round(window.scrollX),
      y: Math.round(window.scrollY),
      user: byViewer(),
    };
    var key = [s.page, s.total, s.hash, s.x, s.y].join('|');
    if (key === last && !force) return;
    last = key;
    app.postMessage(s, '*');
  }
  var frame = 0;
  function schedule() {
    if (!frame)
      frame = requestAnimationFrame(function () {
        frame = 0;
        report();
      });
  }
  addEventListener('scroll', schedule, { passive: true });
  addEventListener('hashchange', schedule);
  addEventListener('popstate', schedule);
  // Many decks change slides with history.replaceState, which fires no event.
  ['pushState', 'replaceState'].forEach(function (fn) {
    var original = history[fn];
    history[fn] = function () {
      var result = original.apply(this, arguments);
      schedule();
      return result;
    };
  });
  setInterval(report, 500); // anything else that changes the slide silently

  function goPage(n) {
    var r = reveal();
    if (r) return r.slide(n - 1);
    if (/\d+/.test(location.hash)) location.hash = location.hash.replace(/\d+/, String(n));
    else if (n > 1) location.hash = '#/' + n;
  }
  function where() {
    return page() + location.hash + '|' + window.scrollY;
  }
  function press(key) {
    var before = where();
    ['keydown', 'keyup'].forEach(function (type) {
      document.dispatchEvent(new KeyboardEvent(type, { key: key, code: key, bubbles: true, cancelable: true }));
    });
    // A page without slides ignores arrow keys: scroll by most of a screen instead.
    setTimeout(function () {
      if (where() !== before) return;
      var dir = key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : 0;
      if (dir) window.scrollBy({ top: dir * window.innerHeight * 0.85, behavior: 'instant' });
    }, 150);
  }
  function scrollTo(x, y) {
    window.scrollTo({ left: x, top: y, behavior: 'instant' });
  }

  addEventListener('message', function (e) {
    var m = e.data;
    if (e.source !== app || !m || typeof m.type !== 'string' || m.type.indexOf('ss:') !== 0) return;
    if (m.type === 'ss:text') {
      var text = document.body ? document.body.innerText : '';
      app.postMessage({ type: 'ss:text', id: m.id, text: text.slice(0, 8000) }, '*');
      return;
    }
    lastCommand = Date.now();
    if (m.type === 'ss:nav') {
      var hash = String(m.hash || '');
      var x = +m.x || 0;
      var y = +m.y || 0;
      if (hash !== location.hash) location.hash = hash || '#';
      scrollTo(x, y);
      // Jumping to a hash may scroll the page by itself; restore the position after it.
      requestAnimationFrame(function () {
        scrollTo(x, y);
      });
    } else if (m.type === 'ss:page') goPage(+m.page || 1);
    else if (m.type === 'ss:key') press(String(m.key));
    else if (m.type === 'ss:scroll') window.scrollBy({ left: +m.dx || 0, top: +m.dy || 0, behavior: 'instant' });
    else if (m.type === 'ss:hello') report(true);
  });

  document.addEventListener('DOMContentLoaded', function () {
    report(true);
  });
  addEventListener('load', function () {
    report(true);
  });
})();
