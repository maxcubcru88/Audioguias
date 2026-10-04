/* Audioguía de París · zona Centro
   Mapa a pantalla completa y una sola tarjeta: caminando → has llegado → (al terminar) caminando.
   Una sola fuente de datos (data/paris-centro.json) alimenta el mapa, los avisos y la voz. */
(function () {
  'use strict';

  const TOUR_URL = 'data/paris-centro.json';
  const STORE = 'audioguia-paris-centro-v1';
  // Mapa gratuito, sin clave y sin límites: https://openfreemap.org
  const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';
  const MAP_CACHE = 'map-v1';
  const WPM = 150;

  const $ = s => document.querySelector(s);
  const pad = n => String(n).padStart(2, '0');
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtDist = m => m < 1000 ? (Math.round(m / 10) * 10) + ' m' : (m / 1000).toFixed(1).replace('.', ',') + ' km';
  function dist(a, b, c, d) {
    const R = 6371000, r = Math.PI / 180;
    const x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  const pathLen = pts => pts.reduce((s, p, i) => i ? s + dist(pts[i - 1][0], pts[i - 1][1], p[0], p[1]) : 0, 0);
  const ll = p => [p[1], p[0]]; // [lat,lng] -> [lng,lat]
  const fmtTime = s => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

  const ICON = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15L19.5 12z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 4.5h4v15H6zM14 4.5h4v15h-4z"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 9l6 6 6-6"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a8 8 0 1 0 2.6-5.9"/><path d="M4 4v4.5h4.5"/></svg>',
    fwd: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v4.5h-4.5"/></svg>'
  };

  // ---------- Estado ----------
  // view: parada que muestra la tarjeta (null = modo caminando)
  const S = { mode: null, target: 0, visited: [], showText: false, rate: 1, voiceName: '', mapSaved: false, pos: null, acc: null, arrived: null, view: null };
  const P = { playing: false, stop: -1, c: 0, session: 0 };
  let tour, map, userDot, markers = [], lastMarkerTap = 0, cardH = 0;
  let speechReady = false, audioCtx = null, wake = null, watchId = null, voice = null, gpsError = '';
  const synth = window.speechSynthesis || null;

  function load() {
    try {
      const d = JSON.parse(localStorage.getItem(STORE) || '{}');
      ['mode', 'target', 'visited', 'showText', 'rate', 'voiceName', 'mapSaved'].forEach(k => { if (k in d) S[k] = d[k]; });
    } catch (e) {}
  }
  function save() {
    try {
      const { mode, target, visited, showText, rate, voiceName, mapSaved } = S;
      localStorage.setItem(STORE, JSON.stringify({ mode, target, visited, showText, rate, voiceName, mapSaved }));
    } catch (e) {}
  }

  let toastTimer;
  function toast(msg, ms) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms || 3500);
  }

  // ---------- Datos ----------
  function prepare(t) {
    t.stops.forEach((st, i) => {
      const parts = st.paras.slice();
      if (st.toNext) parts.push('Para ir a la siguiente parada: ' + st.toNext);
      st.chunks = [];
      parts.forEach((p, pi) => {
        p.replace(/([.!?…])\s+(?=[A-ZÁÉÍÓÚÑ¿¡«"])/g, '$1\u0001').split('\u0001').forEach(s => {
          s = s.trim(); if (s) st.chunks.push({ pi, s });
        });
      });
      st.words = parts.join(' ').split(/\s+/).length;
      st.cum = []; let acc = 0;
      st.chunks.forEach(c => { st.cum.push(acc); acc += c.s.split(/\s+/).length / WPM * 60; });
      st.secs = acc;
      st.min = Math.max(1, Math.round(st.words / WPM));
      st.legNext = t.legs[i] ? pathLen(t.legs[i]) : 0;
    });
    t.totalM = t.legs.reduce((s, l) => s + pathLen(l), 0);
    const audioMin = t.stops.reduce((s, st) => s + st.words, 0) / WPM;
    t.totalH = (audioMin + t.totalM / 75 + t.stops.length * 3) / 60; // ~4,5 km/h y 3 min de margen por parada
  }

  // ---------- Mapa (MapLibre + OpenFreeMap) ----------
  function routeBounds() {
    const b = new maplibregl.LngLatBounds();
    tour.legs.flat().forEach(p => b.extend(ll(p)));
    return b;
  }
  const fitPad = () => ({ top: 64, bottom: cardH + 24, left: 36, right: 64 });
  function legsData() {
    return {
      type: 'FeatureCollection',
      features: tour.legs.map((leg, i) => ({
        type: 'Feature',
        properties: { state: (S.visited.includes(i) && S.visited.includes(i + 1)) ? 'done' : (i + 1 === S.target ? 'next' : 'todo') },
        geometry: { type: 'LineString', coordinates: leg.map(ll) }
      }))
    };
  }
  function initMap() {
    map = new maplibregl.Map({
      container: 'map', style: STYLE_URL,
      bounds: routeBounds(), fitBoundsOptions: { padding: { top: 64, bottom: 220, left: 36, right: 64 } },
      attributionControl: { compact: true },
      dragRotate: false, pitchWithRotate: false, touchPitch: false, maxZoom: 19
    });
    map.touchZoomRotate.disableRotation();
    map.on('load', () => {
      map.addSource('legs', { type: 'geojson', data: legsData() });
      map.addLayer({ id: 'legs-casing', type: 'line', source: 'legs', filter: ['!=', ['get', 'state'], 'done'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#FFFFFF', 'line-width': ['match', ['get', 'state'], 'next', 10, 8], 'line-opacity': .9 } });
      map.addLayer({ id: 'legs-done', type: 'line', source: 'legs', filter: ['==', ['get', 'state'], 'done'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#8A97A1', 'line-width': 4, 'line-dasharray': [0.5, 2] } });
      map.addLayer({ id: 'legs-main', type: 'line', source: 'legs', filter: ['!=', ['get', 'state'], 'done'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#1E3E66', 'line-width': ['match', ['get', 'state'], 'next', 6, 4], 'line-opacity': ['match', ['get', 'state'], 'next', 1, .55] } });
      refreshMap();
    });
    tour.stops.forEach((st, i) => {
      const el = document.createElement('button');
      el.type = 'button'; el.className = 'mk';
      el.setAttribute('aria-label', (i + 1) + '. ' + st.title);
      el.innerHTML = '<span class="plaque">' + (i + 1) + '</span>';
      el.addEventListener('click', e => {
        e.stopPropagation(); lastMarkerTap = Date.now();
        if (S.mode === 'sim') setPos(st.lat, st.lng, 5);
        if (S.view !== i) openView(i);
      });
      markers.push({ el, m: new maplibregl.Marker({ element: el }).setLngLat([st.lng, st.lat]).addTo(map) });
    });
    map.on('click', e => {
      if (Date.now() - lastMarkerTap < 400) return;
      if (S.mode === 'sim') setPos(e.lngLat.lat, e.lngLat.lng, 5);
    });
  }
  function fitRoute() { map.fitBounds(routeBounds(), { padding: fitPad(), duration: 600 }); }
  function flyTo(lat, lng, zoom) {
    map.easeTo({ center: [lng, lat], zoom: zoom || Math.max(map.getZoom(), 16), offset: [0, -cardH / 2 + 20], duration: 600 });
  }
  function refreshMap() {
    markers.forEach(({ el }, i) => {
      el.classList.toggle('is-done', S.visited.includes(i));
      el.classList.toggle('is-next', i === S.target);
      el.classList.toggle('is-here', i === S.view);
    });
    const src = map && map.getSource && map.getSource('legs');
    if (src) src.setData(legsData());
  }
  function drawUser() {
    if (!S.pos) return;
    if (!userDot) {
      const el = document.createElement('div'); el.className = 'me';
      userDot = new maplibregl.Marker({ element: el }).setLngLat(ll(S.pos)).addTo(map);
    } else userDot.setLngLat(ll(S.pos));
  }

  // ---------- Posición y llegadas ----------
  function setPos(lat, lng, acc) {
    S.pos = [lat, lng]; S.acc = acc;
    drawUser();
    if (!checkArrival() && S.view == null) renderCard();
    if (!$('#sheet').hidden) renderList();
  }
  function nextUnvisited(from) {
    const n = tour.stops.length;
    for (let k = from + 1; k < n; k++) if (!S.visited.includes(k)) return k;
    for (let k = 0; k < n; k++) if (!S.visited.includes(k)) return k;
    return null;
  }
  function checkArrival() {
    if (!S.pos) return false;
    const tol = Math.min(S.acc || 0, 25);
    const order = [S.target].concat(tour.stops.map((_, i) => i).filter(i => i !== S.target));
    for (const i of order) {
      if (i == null || S.visited.includes(i)) continue;
      const st = tour.stops[i];
      if (dist(S.pos[0], S.pos[1], st.lat, st.lng) <= st.radius + tol) { arrive(i); return true; }
    }
    return false;
  }
  function arrive(i) {
    S.visited.push(i); S.arrived = i; S.target = nextUnvisited(i); save();
    buzz();
    openView(i);
    if (speechReady) playStop(i);
    else toast('Has llegado. Pulsa «Escuchar».');
  }

  function startGps() {
    if (!('geolocation' in navigator)) { gpsError = 'Este navegador no da acceso al GPS. Prueba el modo prueba desde el menú ☰.'; renderCard(); return; }
    stopGps();
    watchId = navigator.geolocation.watchPosition(
      p => { gpsError = ''; setPos(p.coords.latitude, p.coords.longitude, p.coords.accuracy); },
      err => {
        gpsError = err.code === 1
          ? 'Sin permiso de ubicación. En iPhone: Ajustes › Privacidad › Localización › Safari › «Al usar la app».'
          : 'No consigo tu posición. Sal a un sitio despejado.';
        if (S.view == null) renderCard();
      },
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 }
    );
  }
  function stopGps() { if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; } }

  function setMode(mode) {
    S.mode = mode; gpsError = ''; save();
    $('#modeBadge').hidden = mode !== 'sim';
    $('#modeGps').setAttribute('aria-pressed', String(mode === 'gps'));
    $('#modeSim').setAttribute('aria-pressed', String(mode === 'sim'));
    if (mode === 'gps') { S.pos = null; startGps(); renderCard(); }
    else {
      stopGps();
      if (!S.pos) { const st = tour.stops[S.target != null ? S.target : 0]; setPos(st.lat + 0.0011, st.lng - 0.0004, 5); }
      else renderCard();
    }
  }

  // ---------- Avisos ----------
  function unlockAudio() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) {}
    if (synth && !speechReady) {
      try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; synth.speak(u); } catch (e) {}
      speechReady = true;
    }
  }
  function buzz() {
    try { if (navigator.vibrate) navigator.vibrate([180, 90, 180]); } catch (e) {}
    if (!audioCtx) return;
    try {
      const t0 = audioCtx.currentTime;
      [[659.3, 0], [880, .18]].forEach(([f, dt]) => {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t0 + dt);
        g.gain.exponentialRampToValueAtTime(0.25, t0 + dt + .02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + .45);
        o.connect(g).connect(audioCtx.destination); o.start(t0 + dt); o.stop(t0 + dt + .5);
      });
    } catch (e) {}
  }
  async function requestWake() {
    try {
      if ('wakeLock' in navigator && !wake) {
        wake = await navigator.wakeLock.request('screen');
        wake.addEventListener('release', () => { wake = null; });
      }
    } catch (e) { wake = null; }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.mode) requestWake(); });

  // ---------- Voz ----------
  function loadVoices() {
    if (!synth) return;
    const es = synth.getVoices().filter(v => /^es([-_]|$)/i.test(v.lang));
    const score = v => (/(premium|mejorad|enhanced|natural|neural)/i.test(v.name) ? 4 : 0) + (v.lang.replace('_', '-') === 'es-ES' ? 2 : 0) + (v.localService ? 1 : 0);
    es.sort((a, b) => score(b) - score(a));
    const sel = $('#optVoice');
    sel.innerHTML = '<option value="">Voz del sistema</option>' + es.map(v => '<option value="' + esc(v.name) + '">' + esc(v.name) + ' (' + esc(v.lang) + ')</option>').join('');
    voice = es.find(v => v.name === S.voiceName) || es[0] || null;
    sel.value = voice ? voice.name : '';
  }
  function playStop(i, fromPart) {
    if (!synth) { toast('Este navegador no puede leer en voz alta.'); return; }
    unlockAudio();
    const st = tour.stops[i];
    if (P.stop !== i) { P.stop = i; P.c = 0; }
    if (fromPart != null) P.c = Math.max(0, st.chunks.findIndex(c => c.pi === fromPart));
    if (P.c >= st.chunks.length) P.c = 0;
    P.playing = true;
    restartSpeech();
    requestWake();
    renderPlayer();
  }
  function restartSpeech() { P.session++; synth.cancel(); setTimeout(speakNext, 60); }
  function pauseSpeech() { P.playing = false; P.session++; if (synth) synth.cancel(); renderPlayer(); }
  function speakNext() {
    const st = tour.stops[P.stop];
    const id = ++P.session;
    if (!P.playing) return;
    if (P.c >= st.chunks.length) {
      // Fin de la parada: la tarjeta vuelve a «caminando» hacia la siguiente.
      P.playing = false; P.c = 0; P.stop = -1;
      S.view = null; renderCard(); refreshMap();
      return;
    }
    const u = new SpeechSynthesisUtterance(st.chunks[P.c].s);
    u.lang = voice ? voice.lang : tour.lang;
    if (voice) u.voice = voice;
    u.rate = S.rate;
    u.onend = () => { if (id !== P.session || !P.playing) return; P.c++; speakNext(); };
    u.onerror = e => {
      if (id !== P.session) return;
      if (e.error === 'interrupted' || e.error === 'canceled') return;
      P.playing = false; renderPlayer();
      toast('No se pudo reproducir (' + e.error + '). Prueba otra voz en el menú ☰.');
    };
    renderPlayer(true);
    try { synth.resume(); } catch (e) {}
    synth.speak(u);
  }

  // ---------- Tarjeta ----------
  function openView(i) {
    S.view = i;
    renderCard(); refreshMap();
    const st = tour.stops[i];
    flyTo(st.lat, st.lng, 16.5);
  }
  function closeView() {
    if (P.playing) pauseSpeech();
    S.view = null; renderCard(); refreshMap();
  }

  function renderCard() {
    const card = $('#card');
    let h = '';
    if (S.view != null) {
      const i = S.view, st = tour.stops[i];
      const isArrival = i === S.arrived;
      h += '<div class="c-head"><span class="plaque">' + pad(i + 1) + '</span><div class="c-main">' +
        '<p class="eyebrow' + (isArrival ? ' ok' : '') + '">' + (isArrival ? 'Has llegado' : 'Parada ' + (i + 1) + ' de ' + tour.stops.length) + '</p>' +
        '<h2 class="c-title">' + esc(st.title) + '</h2></div>' +
        '<button class="x" type="button" data-act="close" aria-label="Cerrar parada">' + ICON.close + '</button></div>' +
        '<p class="c-text">' + esc(st.where) + '</p>' +
        '<div class="ctrl">' +
          '<button class="skip" type="button" data-act="back" aria-label="Retroceder una frase">' + ICON.back + '</button>' +
          '<button class="btn btn-primary btn-big" id="btnPlay" type="button" data-act="play"></button>' +
          '<button class="skip" type="button" data-act="fwd" aria-label="Avanzar una frase">' + ICON.fwd + '</button>' +
        '</div>' +
        '<div class="seek"><input type="range" id="seek" min="0" max="' + (st.chunks.length - 1) + '" step="1" value="0" aria-label="Posición en la explicación">' +
          '<div class="times"><span id="tNow">0:00</span><span>' + fmtTime(st.secs) + '</span></div></div>' +
        '<button class="txt-toggle" id="txtToggle" type="button" data-act="text" aria-expanded="' + S.showText + '" aria-controls="cBody">' +
          '<span id="txtLabel">' + (S.showText ? 'Ocultar texto' : 'Ver texto') + '</span>' + ICON.chevron + '</button>' +
        '<div class="c-body" id="cBody"' + (S.showText ? '' : ' hidden') + '>' +
          st.paras.map((p, pi) => '<p class="para" data-p="' + pi + '">' + esc(p) + '</p>').join('') +
          (st.toNext ? '<p class="next-box" data-p="' + st.paras.length + '"><b>Camino a la siguiente · ' + fmtDist(st.legNext) + '</b>' + esc(st.toNext) + '</p>' : '') +
        '</div>';
    } else if (S.target == null) {
      h += '<div class="c-head"><span class="plaque">✓</span><div class="c-main"><p class="eyebrow ok">Recorrido completado</p><h2 class="c-title">¡Bravo!</h2></div></div>' +
        '<p class="c-text">Has visitado las ' + tour.stops.length + ' paradas. Puedes volver a escuchar cualquiera tocando su número en el mapa.</p>' +
        '<button class="btn btn-primary btn-big" type="button" data-act="restart">Empezar de nuevo</button>';
    } else {
      const t = tour.stops[S.target];
      const d = S.pos ? dist(S.pos[0], S.pos[1], t.lat, t.lng) : null;
      const prev = S.target > 0 ? tour.stops[S.target - 1] : null;
      const how = (prev && S.visited.includes(S.target - 1) && prev.toNext) ? prev.toNext : t.where;
      h += '<div class="c-head"><span class="plaque">' + pad(S.target + 1) + '</span><div class="c-main">' +
        '<p class="eyebrow">' + (S.visited.length ? 'Siguiente parada' : 'Punto de partida') + '</p>' +
        '<h2 class="c-title">' + esc(t.title) + '</h2></div>' +
        (d != null ? '<span class="c-dist">' + fmtDist(d) + '</span>' : '') + '</div>' +
        '<p class="c-text">' + esc(how) + '</p>';
      if (S.mode === 'gps' && !S.pos) h += '<p class="c-text muted">' + esc(gpsError || 'Buscando tu posición…') + '</p>';
      if (S.mode === 'sim') h += '<button class="btn btn-ghost btn-big" type="button" data-act="sim-go">Simular llegada</button>';
    }
    card.innerHTML = h;
    if (S.view != null) renderPlayer();
    measureCard();
  }

  function measureCard() {
    const h = $('#card').offsetHeight;
    if (Math.abs(h - cardH) > 2) { cardH = h; document.documentElement.style.setProperty('--card-h', h + 'px'); }
  }

  let seeking = false;
  function paintSeek(c) {
    const st = tour.stops[S.view], el = $('#seek'); if (!el) return;
    const max = st.chunks.length - 1;
    el.style.setProperty('--pct', (max ? 100 * c / max : 0) + '%');
    $('#tNow').textContent = fmtTime(st.cum[c] / S.rate);
  }
  function seekTo(c) {
    if (S.view == null) return;
    const st = tour.stops[S.view];
    if (P.stop !== S.view) { if (P.playing) pauseSpeech(); P.stop = S.view; }
    P.c = Math.max(0, Math.min(c, st.chunks.length - 1));
    if (P.playing) restartSpeech();
    renderPlayer(true);
  }
  function renderPlayer(scroll) {
    const btn = $('#btnPlay'); if (!btn || S.view == null) return;
    const st = tour.stops[S.view];
    const active = P.stop === S.view;
    const playing = active && P.playing;
    const started = active && (P.playing || P.c > 0);
    btn.innerHTML = playing ? ICON.pause + ' Pausar' : ICON.play + (started ? ' Continuar' : ' Escuchar · ' + st.min + ' min');
    const c = active ? Math.min(P.c, st.chunks.length - 1) : 0;
    if (!seeking) { $('#seek').value = c; paintSeek(c); }
    const pi = started ? st.chunks[Math.min(P.c, st.chunks.length - 1)].pi : -1;
    document.querySelectorAll('#cBody [data-p]').forEach(p => p.classList.toggle('is-reading', +p.dataset.p === pi));
    if (scroll && started && S.showText) {
      const cur = document.querySelector('#cBody [data-p="' + pi + '"]');
      if (cur && cur.dataset.seen !== '1') {
        document.querySelectorAll('#cBody [data-p]').forEach(p => { p.dataset.seen = ''; });
        cur.dataset.seen = '1';
        cur.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      }
    }
  }

  // ---------- Paradas y ajustes ----------
  function renderList() {
    $('#stopList').innerHTML = tour.stops.map((st, i) => {
      const v = S.visited.includes(i), nx = i === S.target;
      const meta = nx ? 'Siguiente' : v ? 'Visitada' : (S.pos ? fmtDist(dist(S.pos[0], S.pos[1], st.lat, st.lng)) : st.min + ' min');
      return '<li><button type="button" class="si' + (v ? ' is-done' : '') + (nx ? ' is-next' : '') + '" data-i="' + i + '">' +
        '<span class="plaque">' + pad(i + 1) + '</span>' +
        '<span><span class="si-title">' + esc(st.title) + '</span><span class="si-sub">' + esc(st.subtitle) + '</span></span>' +
        '<span class="si-meta">' + meta + '</span></button></li>';
    }).join('');
  }
  function openSheet() { renderList(); $('#sheet').hidden = false; }
  function closeSheet() { $('#sheet').hidden = true; }

  // ---------- Mapa sin conexión (automático) ----------
  function lon2x(lon, z) { return Math.floor((lon + 180) / 360 * 2 ** z); }
  function lat2y(lat, z) { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z); }
  async function saveOffline() {
    const msg = $('#offlineMsg');
    if (!('caches' in window) || !navigator.onLine) return;
    try {
      const cache = await caches.open(MAP_CACHE);
      const getJson = async u => { const r = await fetch(u); await cache.put(u, r.clone()); return r.json(); };
      const style = await getJson(STYLE_URL);
      const urls = [];
      const bb = routeBounds();
      const w = bb.getWest() - 0.01, e = bb.getEast() + 0.01, n = bb.getNorth() + 0.006, s = bb.getSouth() - 0.006;
      for (const src of Object.values(style.sources || {})) {
        if (src.type !== 'vector') continue;
        const tj = src.url ? await getJson(src.url) : src;
        const tpl = (tj.tiles || [])[0]; if (!tpl) continue;
        for (let z = 10; z <= Math.min(tj.maxzoom || 14, 14); z++)
          for (let x = lon2x(w, z); x <= lon2x(e, z); x++)
            for (let y = lat2y(n, z); y <= lat2y(s, z); y++)
              urls.push(tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y));
      }
      const stacks = new Set();
      (style.layers || []).forEach(l => { const f = l.layout && l.layout['text-font']; if (Array.isArray(f) && f.every(x => typeof x === 'string')) stacks.add(f.join(',')); });
      if (style.glyphs) stacks.forEach(st => ['0-255', '256-511', '8192-8447'].forEach(r => urls.push(style.glyphs.replace('{fontstack}', encodeURIComponent(st)).replace('{range}', r))));
      const sprites = Array.isArray(style.sprite) ? style.sprite.map(x => x.url) : (style.sprite ? [style.sprite] : []);
      sprites.forEach(sp => ['.json', '.png', '@2x.json', '@2x.png'].forEach(ext => urls.push(sp + ext)));

      let fails = 0, k = 0;
      async function worker() {
        while (k < urls.length) {
          const u = urls[k++];
          try { if (!(await cache.match(u))) { const r = await fetch(u); if (r.ok) await cache.put(u, r); else fails++; } } catch (err) { fails++; }
        }
      }
      await Promise.all(Array.from({ length: 4 }, worker));
      if (!fails) { S.mapSaved = true; save(); msg.textContent = 'Mapa de la zona guardado: funciona sin datos.'; }
    } catch (err) { /* se reintenta la próxima vez que se abra la app */ }
  }

  // ---------- Eventos ----------
  function resetTour() {
    pauseSpeech(); S.visited = []; S.target = 0; S.arrived = null; S.view = null; P.stop = -1; P.c = 0; save();
    closeSheet(); renderCard(); refreshMap(); fitRoute(); toast('Recorrido reiniciado.');
  }
  function begin(mode) {
    unlockAudio(); requestWake();
    $('#intro').hidden = true;
    map.resize();
    setMode(mode);
    if (!S.mapSaved) setTimeout(saveOffline, 4000);
  }
  function bind() {
    $('#startGps').addEventListener('click', () => begin('gps'));
    $('#startSim').addEventListener('click', () => begin('sim'));

    $('#card').addEventListener('click', e => {
      const b = e.target.closest('[data-act]');
      const act = b && b.dataset.act;
      if (act === 'close') { closeView(); return; }
      if (act === 'play') { if (P.playing && P.stop === S.view) pauseSpeech(); else playStop(S.view); return; }
      if (act === 'text') {
        S.showText = !S.showText; save();
        $('#cBody').hidden = !S.showText;
        $('#txtLabel').textContent = S.showText ? 'Ocultar texto' : 'Ver texto';
        $('#txtToggle').setAttribute('aria-expanded', String(S.showText));
        measureCard();
        if (S.showText) renderPlayer(true);
        return;
      }
      if (act === 'restart') { resetTour(); return; }
      if (act === 'back' || act === 'fwd') {
        const cur = P.stop === S.view ? P.c : 0;
        seekTo(cur + (act === 'back' ? -1 : 1));
        return;
      }
      if (act === 'sim-go' && S.target != null) { const t = tour.stops[S.target]; setPos(t.lat, t.lng, 5); return; }
      const p = e.target.closest('[data-p]');
      if (p && S.view != null) playStop(S.view, +p.dataset.p);
    });

    $('#card').addEventListener('input', e => {
      if (e.target.id !== 'seek') return;
      seeking = true; paintSeek(+e.target.value);
    });
    $('#card').addEventListener('change', e => {
      if (e.target.id !== 'seek') return;
      seeking = false; seekTo(+e.target.value);
    });
    $('#btnLocate').addEventListener('click', () => { if (S.pos) flyTo(S.pos[0], S.pos[1], 17); else fitRoute(); });
    $('#btnMenu').addEventListener('click', openSheet);
    $('#sheetClose').addEventListener('click', closeSheet);
    $('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });
    $('#stopList').addEventListener('click', e => {
      const b = e.target.closest('.si'); if (!b) return;
      closeSheet(); openView(+b.dataset.i);
    });
    $('#modeGps').addEventListener('click', () => setMode('gps'));
    $('#modeSim').addEventListener('click', () => setMode('sim'));
    $('#optRate').addEventListener('change', e => { S.rate = parseFloat(e.target.value) || 1; save(); if (P.playing) restartSpeech(); });
    $('#optVoice').addEventListener('change', e => {
      voice = synth ? synth.getVoices().find(v => v.name === e.target.value) || null : null;
      S.voiceName = voice ? voice.name : ''; save(); if (P.playing) restartSpeech();
    });

    let resetArmed = 0;
    $('#btnReset').addEventListener('click', e => {
      const b = e.currentTarget;
      if (Date.now() - resetArmed > 4000) {
        resetArmed = Date.now(); b.textContent = 'Toca otra vez para borrar el progreso';
        setTimeout(() => { b.textContent = 'Reiniciar el recorrido'; }, 4000); return;
      }
      b.textContent = 'Reiniciar el recorrido'; resetArmed = 0;
      resetTour();
    });
    window.addEventListener('resize', () => measureCard());
  }

  // ---------- Arranque ----------
  async function boot() {
    load();
    try {
      const res = await fetch(TOUR_URL, { cache: 'no-cache' });
      tour = await res.json();
    } catch (e) {
      $('#introNote').hidden = false; $('#introNote').textContent = 'No se pudo cargar el recorrido. Comprueba la conexión y recarga.'; return;
    }
    prepare(tour);
    if (S.target != null && !tour.stops[S.target]) S.target = 0;
    S.visited = (S.visited || []).filter(i => tour.stops[i]);

    const hours = (Math.round(tour.totalH * 2) / 2).toString().replace('.', ',');
    $('#introTitle').textContent = tour.title;
    $('#introSub').textContent = tour.subtitle + '.';
    $('#introStats').textContent = tour.stops.length + ' paradas · ' + fmtDist(tour.totalM) + ' a pie · unas ' + hours + ' horas';
    $('#sheetTitle').textContent = tour.title;
    $('#sheetSub').textContent = tour.stops.length + ' paradas · ' + fmtDist(tour.totalM) + ' · unas ' + hours + ' h';
    if (S.visited.length && S.target != null) $('#startGps').textContent = 'Continuar el recorrido (' + S.visited.length + '/' + tour.stops.length + ')';
    $('#optRate').value = String(S.rate);
    $('#offlineMsg').textContent = S.mapSaved ? 'Mapa de la zona guardado: funciona sin datos.' : 'El mapa de la zona se guarda solo al empezar, para usarlo sin datos.';

    initMap();
    bind();
    renderCard();
    if (synth) { loadVoices(); if ('onvoiceschanged' in synth) synth.onvoiceschanged = loadVoices; }

    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }
  boot();
})();
