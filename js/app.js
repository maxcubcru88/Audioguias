/* Audioguía de París · zona Centro
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

  const ICON = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15L19.5 12z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 4.5h4v15H6zM14 4.5h4v15h-4z"/></svg>'
  };

  // ---------- Estado ----------
  const S = { mode: null, target: 0, open: 0, visited: [], autoplay: true, showText: false, rate: 1, voiceName: '', pos: null, acc: null, arrived: null };
  const P = { playing: false, stop: -1, c: 0, session: 0 };
  let tour, map, userDot, markers = [];
  let speechReady = false, audioCtx = null, wake = null, watchId = null, voice = null;
  const synth = window.speechSynthesis || null;

  function load() {
    try { Object.assign(S, JSON.parse(localStorage.getItem(STORE) || '{}')); } catch (e) {}
    S.pos = null; S.acc = null; S.arrived = null;
  }
  function save() {
    try {
      const { mode, target, open, visited, autoplay, showText, rate, voiceName } = S;
      localStorage.setItem(STORE, JSON.stringify({ mode, target, open, visited, autoplay, showText, rate, voiceName }));
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
      st.nParts = parts.length;
      st.chunks = [];
      parts.forEach((p, pi) => {
        p.replace(/([.!?…])\s+(?=[A-ZÁÉÍÓÚÑ¿¡«"])/g, '$1\u0001').split('\u0001').forEach(s => {
          s = s.trim(); if (s) st.chunks.push({ pi, s });
        });
      });
      st.words = parts.join(' ').split(/\s+/).length;
      st.min = Math.max(1, Math.round(st.words / WPM));
      st.legNext = t.legs[i] ? pathLen(t.legs[i]) : 0;
    });
    t.totalM = t.legs.reduce((s, l) => s + pathLen(l), 0);
    t.audioMin = Math.round(t.stops.reduce((s, st) => s + st.words, 0) / WPM);
    const walkMin = Math.round(t.totalM / 75); // ~4,5 km/h
    t.totalH = (t.audioMin + walkMin + t.stops.length * 3) / 60;
  }

  // ---------- Mapa (MapLibre + OpenFreeMap) ----------
  const ll = p => [p[1], p[0]]; // [lat,lng] -> [lng,lat]
  function routeBounds() {
    const b = new maplibregl.LngLatBounds();
    tour.legs.flat().forEach(p => b.extend(ll(p)));
    return b;
  }
  const fitPad = () => ({ top: 70, bottom: 40, left: 36, right: 44 });
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
  let lastMarkerTap = 0;
  function initMap() {
    map = new maplibregl.Map({
      container: 'map', style: STYLE_URL,
      bounds: routeBounds(), fitBoundsOptions: { padding: fitPad() },
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
        else openStop(i, true);
      });
      markers.push({ el, m: new maplibregl.Marker({ element: el }).setLngLat([st.lng, st.lat]).addTo(map) });
    });
    map.on('click', e => {
      if (Date.now() - lastMarkerTap < 400) return;
      if (S.mode === 'sim') setPos(e.lngLat.lat, e.lngLat.lng, 5);
    });
  }
  function fitRoute() { map.fitBounds(routeBounds(), { padding: fitPad(), duration: 600 }); }
  function refreshMap() {
    markers.forEach(({ el }, i) => {
      el.classList.toggle('is-done', S.visited.includes(i));
      el.classList.toggle('is-next', i === S.target);
      el.classList.toggle('is-here', i === S.arrived);
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
    checkArrival();
    renderStatus(); renderList(); refreshMap();
  }
  function nextUnvisited(from) {
    const n = tour.stops.length;
    for (let k = from + 1; k < n; k++) if (!S.visited.includes(k)) return k;
    for (let k = 0; k < n; k++) if (!S.visited.includes(k)) return k;
    return null;
  }
  function checkArrival() {
    if (!S.pos) return;
    const tol = Math.min(S.acc || 0, 25);
    const order = [S.target].concat(tour.stops.map((_, i) => i).filter(i => i !== S.target));
    for (const i of order) {
      if (i == null || S.visited.includes(i)) continue;
      const st = tour.stops[i];
      if (dist(S.pos[0], S.pos[1], st.lat, st.lng) <= st.radius + tol) { arrive(i); return; }
    }
  }
  function arrive(i) {
    S.visited.push(i); S.arrived = i; S.open = i; S.target = nextUnvisited(i); save();
    buzz();
    renderAll();
    $('#panel').scrollTo({ top: 0, behavior: 'smooth' });
    if (S.autoplay && speechReady) playStop(i);
    else if (S.autoplay && !speechReady) toast('Has llegado. Pulsa ▶ para escuchar.');
  }
  function hereStop() {
    if (S.arrived == null) return null;
    if (!S.pos) return S.arrived;
    const st = tour.stops[S.arrived];
    return dist(S.pos[0], S.pos[1], st.lat, st.lng) <= Math.max(st.radius * 2.5, 90) ? S.arrived : null;
  }

  function startGps() {
    if (!('geolocation' in navigator)) { toast('Este navegador no da acceso al GPS. Usa el modo prueba.'); return; }
    stopGps();
    watchId = navigator.geolocation.watchPosition(
      p => setPos(p.coords.latitude, p.coords.longitude, p.coords.accuracy),
      err => {
        if (err.code === 1) {
          gpsError = 'Sin permiso de ubicación. En iPhone: Ajustes › Privacidad › Localización › Safari › «Al usar la app». Mientras tanto puedes usar el modo prueba.';
        } else gpsError = 'No consigo tu posición. Sal a un sitio despejado o usa el modo prueba.';
        renderStatus();
      },
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 }
    );
  }
  let gpsError = '';
  function stopGps() { if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; } }

  function setMode(mode) {
    S.mode = mode; gpsError = ''; save();
    if (mode === 'gps') { S.pos = null; startGps(); }
    else { stopGps(); if (!S.pos) { const st = tour.stops[S.target != null ? S.target : 0]; setPos(st.lat + 0.0011, st.lng - 0.0004, 5); } }
    $('#modeBadge').hidden = mode !== 'sim';
    $('#simHint').hidden = mode !== 'sim';
    $('#modeGps').setAttribute('aria-pressed', String(mode === 'gps'));
    $('#modeSim').setAttribute('aria-pressed', String(mode === 'sim'));
    renderAll();
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
    const all = synth.getVoices();
    const es = all.filter(v => /^es([-_]|$)/i.test(v.lang));
    const score = v => (/(premium|mejorad|enhanced|natural|neural)/i.test(v.name) ? 4 : 0) + (v.lang.replace('_', '-') === 'es-ES' ? 2 : 0) + (v.localService ? 1 : 0);
    es.sort((a, b) => score(b) - score(a));
    const sel = $('#optVoice');
    sel.innerHTML = '<option value="">Voz del sistema</option>' + es.map(v => '<option value="' + esc(v.name) + '">' + esc(v.name) + ' (' + esc(v.lang) + ')</option>').join('');
    voice = es.find(v => v.name === S.voiceName) || es[0] || null;
    sel.value = voice ? voice.name : '';
  }
  function playStop(i, fromPart) {
    if (!synth) { toast('Este navegador no puede leer en voz alta. Puedes leer el texto.'); return; }
    unlockAudio();
    const st = tour.stops[i];
    if (P.stop !== i) { P.stop = i; P.c = 0; }
    if (fromPart != null) P.c = Math.max(0, st.chunks.findIndex(c => c.pi === fromPart));
    if (P.c >= st.chunks.length) P.c = 0;
    P.playing = true;
    if (S.open !== i) { S.open = i; save(); renderDetail(); renderList(); }
    restartSpeech();
    requestWake();
  }
  function restartSpeech() { P.session++; synth.cancel(); setTimeout(speakNext, 60); }
  function pauseSpeech() { P.playing = false; P.session++; if (synth) synth.cancel(); renderPlayer(); renderStatus(); }
  function speakNext() {
    const st = tour.stops[P.stop];
    const id = ++P.session;
    if (!P.playing) return;
    if (P.c >= st.chunks.length) { P.playing = false; P.c = 0; renderPlayer(); renderStatus(); return; }
    const u = new SpeechSynthesisUtterance(st.chunks[P.c].s);
    u.lang = voice ? voice.lang : tour.lang;
    if (voice) u.voice = voice;
    u.rate = S.rate;
    u.onend = () => { if (id !== P.session || !P.playing) return; P.c++; speakNext(); };
    u.onerror = e => {
      if (id !== P.session) return;
      if (e.error === 'interrupted' || e.error === 'canceled') return;
      P.playing = false; renderPlayer(); renderStatus();
      toast('No se pudo reproducir (' + e.error + '). Prueba otra voz en Ajustes.');
    };
    renderPlayer(true);
    try { synth.resume(); } catch (e) {}
    synth.speak(u);
  }

  // ---------- Pintado ----------
  function renderAll() { renderStatus(); renderDetail(); renderList(); refreshMap(); }

  function renderStatus() {
    const el = $('#status');
    const n = tour.stops.length;
    const here = hereStop();
    let h = '';
    if (here != null) {
      const st = tour.stops[here];
      const playingHere = P.playing && P.stop === here;
      h += '<p class="eyebrow ok">Has llegado</p>' +
        '<div class="st-row"><span class="plaque">' + pad(here + 1) + '</span><div class="st-main"><h2 class="st-title">' + esc(st.title) + '</h2></div></div>' +
        '<p class="st-text">' + esc(st.where) + '</p>' +
        '<button class="btn btn-primary btn-big" type="button" data-act="play-here">' + (playingHere ? ICON.pause + ' Pausar' : ICON.play + ' Escuchar esta parada · ' + st.min + ' min') + '</button>';
      if (S.target != null) h += '<p class="st-text muted">Después: ' + pad(S.target + 1) + ' · ' + esc(tour.stops[S.target].title) + '</p>';
      else h += '<p class="st-text muted">Es la última parada del recorrido.</p>';
    } else if (S.target == null) {
      h += '<p class="eyebrow ok">Recorrido completado</p><h2 class="st-title">¡Bravo!</h2><p class="st-text">Has visitado las ' + n + ' paradas. Puedes volver a escuchar cualquiera desde la lista.</p>';
    } else {
      const t = tour.stops[S.target];
      const d = S.pos ? dist(S.pos[0], S.pos[1], t.lat, t.lng) : null;
      const prev = S.target > 0 ? tour.stops[S.target - 1] : null;
      const how = (prev && S.visited.includes(S.target - 1) && prev.toNext) ? prev.toNext
        : (S.target === 0 ? 'El recorrido empieza aquí. ' + t.where : t.where);
      h += '<p class="eyebrow">' + (S.visited.length ? 'Siguiente parada' : 'Punto de partida') + '</p>' +
        '<div class="st-row"><span class="plaque">' + pad(S.target + 1) + '</span><div class="st-main"><h2 class="st-title">' + esc(t.title) + '</h2></div>' +
        (d != null ? '<span class="st-dist">' + fmtDist(d) + '</span>' : '') + '</div>' +
        '<p class="st-text">' + esc(how) + '</p>';
      if (S.mode === 'gps' && !S.pos) h += '<p class="st-text muted">' + esc(gpsError || 'Buscando tu posición…') + '</p>';
      if (S.mode === 'sim') h += '<div class="st-actions"><button class="btn btn-ghost" type="button" data-act="sim-go">Simular llegada</button></div>';
    }
    el.innerHTML = h;
  }

  function renderDetail() {
    const i = S.open, st = tour.stops[i];
    const isLast = i === tour.stops.length - 1;
    $('#detail').innerHTML =
      '<div class="d-head"><span class="plaque">' + pad(i + 1) + '</span><div><h2 class="d-title">' + esc(st.title) + '</h2><p class="d-sub">' + esc(st.subtitle) + ' · ' + st.min + ' min</p></div></div>' +
      '<p class="where"><b>Dónde ponerte</b>' + esc(st.where) + '</p>' +
      '<div class="player"><button class="pbtn" id="pbtn" type="button" aria-label="Reproducir">' + ICON.play + '</button>' +
      '<div class="pbar"><div class="ptrack"><span id="pfill"></span></div><span class="pinfo" id="pinfo"></span></div></div>' +
      '<button class="txt-toggle" id="txtToggle" type="button" aria-expanded="' + S.showText + '" aria-controls="dBody">' +
        '<span id="txtLabel">' + (S.showText ? 'Ocultar texto' : 'Ver texto') + '</span>' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 9l6 6 6-6"/></svg></button>' +
      '<div class="d-body" id="dBody"' + (S.showText ? '' : ' hidden') + '>' + st.paras.map((p, pi) => '<p class="para" data-p="' + pi + '">' + esc(p) + '</p>').join('') + '</div>' +
      (isLast || !st.toNext ? '' : '<p class="next-box" data-p="' + st.paras.length + '"><b>Camino a la siguiente · ' + fmtDist(st.legNext) + '</b>' + esc(st.toNext) + '</p>');
    renderPlayer();
  }

  function renderPlayer(scroll) {
    const i = S.open, st = tour.stops[i];
    const active = P.stop === i;
    const playing = active && P.playing;
    const btn = $('#pbtn');
    if (btn) { btn.innerHTML = playing ? ICON.pause : ICON.play; btn.setAttribute('aria-label', playing ? 'Pausar' : 'Reproducir'); }
    const c = active ? P.c : 0;
    const fill = $('#pfill'); if (fill) fill.style.width = (100 * Math.min(c, st.chunks.length) / st.chunks.length) + '%';
    const info = $('#pinfo');
    if (info) info.textContent = playing ? 'Escuchando…' : (active && P.c > 0 ? 'En pausa' : 'Toca ▶ para escuchar');
    const pi = active && (P.playing || P.c > 0) ? st.chunks[Math.min(c, st.chunks.length - 1)].pi : -1;
    document.querySelectorAll('#detail [data-p]').forEach(p => p.classList.toggle('is-reading', +p.dataset.p === pi));
    if (scroll && playing && S.showText) {
      const cur = document.querySelector('#detail [data-p="' + pi + '"]');
      if (cur && cur.dataset.lastScrolled !== '1') {
        document.querySelectorAll('#detail [data-p]').forEach(p => { p.dataset.lastScrolled = ''; });
        cur.dataset.lastScrolled = '1';
        cur.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      }
    }
  }

  function renderList() {
    $('#stopList').innerHTML = tour.stops.map((st, i) => {
      const v = S.visited.includes(i), nx = i === S.target;
      const d = S.pos ? fmtDist(dist(S.pos[0], S.pos[1], st.lat, st.lng)) : st.min + ' min';
      const label = v ? 'Visitada' : nx ? 'Siguiente' : '';
      return '<li><button type="button" class="si' + (v ? ' is-done' : '') + (nx ? ' is-next' : '') + (i === S.open ? ' is-open' : '') + '" data-i="' + i + '">' +
        '<span class="plaque">' + pad(i + 1) + '</span>' +
        '<span><span class="si-title">' + esc(st.title) + '</span><span class="si-sub">' + esc(st.subtitle) + '</span></span>' +
        '<span class="si-meta">' + (label ? '<b>' + label + '</b>' : '') + d + '</span></button></li>';
    }).join('');
  }

  function openStop(i, scrollTo) {
    S.open = i; save();
    renderDetail(); renderList();
    if (scrollTo) $('#detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---------- Sin conexión ----------
  function lon2x(lon, z) { return Math.floor((lon + 180) / 360 * 2 ** z); }
  function lat2y(lat, z) { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z); }
  async function saveOffline() {
    const msg = $('#offlineMsg'), btn = $('#btnOffline');
    if (!('caches' in window)) { msg.textContent = 'Este navegador no permite guardar el mapa.'; return; }
    btn.disabled = true; msg.textContent = 'Preparando…';
    try {
      const cache = await caches.open(MAP_CACHE);
      const getJson = async u => { const r = await fetch(u); await cache.put(u, r.clone()); return r.json(); };
      const style = await getJson(STYLE_URL);
      const urls = [];
      // Teselas vectoriales de la zona
      const bb = routeBounds();
      const w = bb.getWest() - 0.01, e = bb.getEast() + 0.01, n = bb.getNorth() + 0.006, s = bb.getSouth() - 0.006;
      for (const src of Object.values(style.sources || {})) {
        if (src.type !== 'vector') continue;
        const tj = src.url ? await getJson(src.url) : src;
        const tpl = (tj.tiles || [])[0]; if (!tpl) continue;
        const zmax = Math.min(tj.maxzoom || 14, 14);
        for (let z = 10; z <= zmax; z++) {
          for (let x = lon2x(w, z); x <= lon2x(e, z); x++)
            for (let y = lat2y(n, z); y <= lat2y(s, z); y++)
              urls.push(tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y));
        }
      }
      // Tipografías del mapa (latín básico y extendido)
      const stacks = new Set();
      (style.layers || []).forEach(l => { const f = l.layout && l.layout['text-font']; if (Array.isArray(f) && f.every(x => typeof x === 'string')) stacks.add(f.join(',')); });
      if (style.glyphs) stacks.forEach(st => ['0-255', '256-511', '8192-8447'].forEach(r => urls.push(style.glyphs.replace('{fontstack}', encodeURIComponent(st)).replace('{range}', r))));
      // Iconos del mapa
      const sprites = Array.isArray(style.sprite) ? style.sprite.map(x => x.url) : (style.sprite ? [style.sprite] : []);
      sprites.forEach(sp => ['.json', '.png', '@2x.json', '@2x.png'].forEach(ext => urls.push(sp + ext)));

      let done = 0, fails = 0, k = 0;
      async function worker() {
        while (k < urls.length) {
          const u = urls[k++];
          try { if (!(await cache.match(u))) { const r = await fetch(u); if (r.ok) await cache.put(u, r); else fails++; } } catch (err) { fails++; }
          done++;
          if (done % 5 === 0 || done === urls.length) msg.textContent = 'Guardando mapa… ' + Math.round(100 * done / urls.length) + ' %';
        }
      }
      await Promise.all(Array.from({ length: 6 }, worker));
      msg.textContent = fails ? 'Mapa guardado con ' + fails + ' huecos. Vuelve a intentarlo con buena conexión.' : 'Mapa guardado. Ya puedes usar el recorrido sin datos.';
    } catch (err) {
      msg.textContent = 'No se pudo guardar el mapa. Comprueba la conexión e inténtalo de nuevo.';
    }
    btn.disabled = false;
  }

  // ---------- Eventos ----------
  function bind() {
    $('#startGps').addEventListener('click', () => { unlockAudio(); requestWake(); $('#intro').hidden = true; map.resize(); setMode('gps'); });
    $('#startSim').addEventListener('click', () => { unlockAudio(); requestWake(); $('#intro').hidden = true; map.resize(); setMode('sim'); toast('Modo prueba: toca el mapa o un número para moverte.'); });

    $('#status').addEventListener('click', e => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      if (b.dataset.act === 'play-here') {
        const h = hereStop();
        if (P.playing && P.stop === h) pauseSpeech(); else playStop(h);
        renderStatus();
      }
      if (b.dataset.act === 'sim-go' && S.target != null) { const t = tour.stops[S.target]; setPos(t.lat, t.lng, 5); }
    });

    $('#detail').addEventListener('click', e => {
      if (e.target.closest('#pbtn')) {
        if (P.playing && P.stop === S.open) pauseSpeech(); else playStop(S.open);
        renderStatus(); return;
      }
      if (e.target.closest('#txtToggle')) {
        S.showText = !S.showText; save();
        $('#dBody').hidden = !S.showText;
        $('#txtLabel').textContent = S.showText ? 'Ocultar texto' : 'Ver texto';
        $('#txtToggle').setAttribute('aria-expanded', String(S.showText));
        if (S.showText) renderPlayer(true);
        return;
      }
      const p = e.target.closest('[data-p]');
      if (p) { playStop(S.open, +p.dataset.p); renderStatus(); }
    });

    $('#stopList').addEventListener('click', e => {
      const b = e.target.closest('.si'); if (!b) return;
      const i = +b.dataset.i;
      openStop(i, true);
      map.easeTo({ center: [tour.stops[i].lng, tour.stops[i].lat], zoom: Math.max(map.getZoom(), 16) });
    });

    $('#btnLocate').addEventListener('click', () => { if (S.pos) map.easeTo({ center: ll(S.pos), zoom: 17 }); else fitRoute(); });
    $('#btnMenu').addEventListener('click', () => { $('#menu').hidden = false; });
    $('#menuClose').addEventListener('click', () => { $('#menu').hidden = true; });
    $('#menu').addEventListener('click', e => { if (e.target.id === 'menu') $('#menu').hidden = true; });
    $('#modeGps').addEventListener('click', () => { setMode('gps'); });
    $('#modeSim').addEventListener('click', () => { setMode('sim'); });
    $('#optAuto').addEventListener('change', e => { S.autoplay = e.target.checked; save(); });
    $('#optRate').addEventListener('change', e => { S.rate = parseFloat(e.target.value) || 1; save(); if (P.playing) restartSpeech(); });
    $('#optVoice').addEventListener('change', e => {
      voice = synth ? synth.getVoices().find(v => v.name === e.target.value) || null : null;
      S.voiceName = voice ? voice.name : ''; save(); if (P.playing) restartSpeech();
    });
    $('#btnOffline').addEventListener('click', saveOffline);

    let resetArmed = 0;
    $('#btnReset').addEventListener('click', e => {
      const b = e.currentTarget;
      if (Date.now() - resetArmed > 4000) { resetArmed = Date.now(); b.textContent = 'Toca otra vez para borrar el progreso'; setTimeout(() => { b.textContent = 'Reiniciar el recorrido'; }, 4000); return; }
      pauseSpeech(); S.visited = []; S.target = 0; S.open = 0; S.arrived = null; P.stop = -1; P.c = 0; save();
      b.textContent = 'Reiniciar el recorrido'; resetArmed = 0;
      $('#menu').hidden = true; renderAll(); fitRoute(); toast('Recorrido reiniciado.');
    });
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
    if (!tour.stops[S.open]) S.open = 0;
    S.visited = (S.visited || []).filter(i => tour.stops[i]);

    $('#tourTitle').textContent = tour.title;
    $('#introSub').textContent = tour.subtitle + '.';
    $('#introStats').textContent = tour.stops.length + ' paradas · ' + fmtDist(tour.totalM) + ' a pie · unas ' + (Math.round(tour.totalH * 2) / 2).toString().replace('.', ',') + ' horas';
    if (S.visited.length) $('#startGps').textContent = 'Continuar el recorrido (' + S.visited.length + '/' + tour.stops.length + ')';
    $('#optAuto').checked = S.autoplay;
    $('#optRate').value = String(S.rate);

    initMap();
    bind();
    renderAll();
    if (synth) { loadVoices(); if ('onvoiceschanged' in synth) synth.onvoiceschanged = loadVoices; }

    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }
  boot();
})();
