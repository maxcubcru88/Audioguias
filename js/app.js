/* Paseíto · free tours de bolsillo
   Pantallas: Inicio (ciudades) → Ciudad (rutas) → Ruta (mapa + tarjeta).
   Enlaces: #paris  ·  #paris/centro
   Todo el contenido sale de data/catalogo.json y de un archivo JSON por ruta. */
(function () {
  'use strict';

  const CATALOG_URL = 'data/catalogo.json';
  const PREFS = 'audioguias-prefs-v1';     // voz y velocidad: comunes a todas las rutas
  let STORE = '';                          // progreso: uno por ruta (audioguia-<ciudad>-<ruta>-v1)
  // Mapa gratuito, sin clave y sin límites: https://openfreemap.org
  const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';
  const MAP_CACHE = 'map-v1';
  const MEDIA_CACHE = 'media-v1';          // imágenes de las rutas (sw.js usa el mismo nombre)
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
  const fresh = () => ({ mode: null, target: 0, visited: [], showText: false, rate: 1, voiceName: '', mapSaved: false, pos: null, acc: null, arrived: null, view: null, score: {}, askQuiz: true });
  let S = fresh();
  let catalog = null, city = null, routeMeta = null;
  const tourCache = {};
  const P = { playing: false, stop: -1, c: 0, off: 0, session: 0 };
  let tour, map, userDot, markers = [], lastMarkerTap = 0, cardH = 0;
  let speechReady = false, audioCtx = null, wake = null, watchId = null, voice = null, gpsError = '';
  const synth = window.speechSynthesis || null;

  function readJSON(key) { try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch (e) { return {}; } }
  function load() {
    const d = STORE ? readJSON(STORE) : {};
    ['mode', 'target', 'visited', 'mapSaved', 'score'].forEach(k => { if (k in d) S[k] = d[k]; });
    const pr = readJSON(PREFS);
    if ('askQuiz' in pr) S.askQuiz = pr.askQuiz;
    if ('rate' in pr) S.rate = pr.rate; else if ('rate' in d) S.rate = d.rate;
    if ('voiceName' in pr) S.voiceName = pr.voiceName; else if ('voiceName' in d) S.voiceName = d.voiceName;
  }
  function save() {
    try {
      const { mode, target, visited, mapSaved, score, rate, voiceName, askQuiz } = S;
      if (STORE) localStorage.setItem(STORE, JSON.stringify({ mode, target, visited, mapSaved, score }));
      localStorage.setItem(PREFS, JSON.stringify({ rate, voiceName, askQuiz }));
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
        if (st.quiz && st.quiz.before === pi) {
          const q = st.quiz;
          st.chunks.push({ pi, quiz: true, s: q.q + ' ' + q.options.map((o, k) => '¿' + o + '?').join(' ') });
        }
        p.replace(/([.!?…])\s+(?=[A-ZÁÉÍÓÚÑ¿¡«"])/g, '$1\u0001').split('\u0001').forEach(s => {
          s = s.trim(); if (s) st.chunks.push({ pi, s });
        });
      });
      st.words = parts.join(' ').split(/\s+/).length;
      const au = t.audio && t.audio.stops && t.audio.stops[st.id];
      if (au && au.paras && au.paras.length === parts.length) {
        // Audio grabado: un archivo por párrafo y otro para la pregunta
        const base = t.audio.base || '';
        st.isAudio = true;
        st.audio = { ok: au.ok && base + au.ok, ko: au.ko && base + au.ko, skip: au.skip && base + au.skip };
        const text = {}; st.chunks.forEach(c => { text[c.quiz ? 'q' : c.pi] = (text[c.quiz ? 'q' : c.pi] || '') + ' ' + c.s; });
        st.chunks = [];
        parts.forEach((p, pi) => {
          if (st.quiz && st.quiz.before === pi && au.quiz) st.chunks.push({ pi, quiz: true, src: base + au.quiz, s: text.q || '' });
          st.chunks.push({ pi, src: base + au.paras[pi], s: p });
        });
        st.chunks.forEach(c => { c.dur = c.s.split(/\s+/).length / WPM * 60; });
      }
      recalcTimes(st);
      st.min = Math.max(1, Math.round(st.words / WPM));
      st.legNext = t.legs[i] ? pathLen(t.legs[i]) : 0;
    });
    t.totalM = t.legs.reduce((s, l) => s + pathLen(l), 0);
    const audioMin = t.stops.reduce((s, st) => s + st.words, 0) / WPM;
    t.totalH = (audioMin + t.totalM / 75 + t.stops.length * 3) / 60; // ~4,5 km/h y 3 min de margen por parada
  }

  function recalcTimes(st) {
    st.cum = []; let acc = 0;
    st.chunks.forEach(c => { st.cum.push(acc); acc += c.dur != null ? c.dur : c.s.split(/\s+/).length / WPM * 60; });
    st.secs = acc;
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
  let mapReady = null;
  function ensureMap() {
    if (map) return mapReady;
    map = new maplibregl.Map({
      container: 'map', style: STYLE_URL,
      bounds: routeBounds(), fitBoundsOptions: { padding: { top: 64, bottom: 220, left: 36, right: 64 } },
      attributionControl: { compact: true },
      dragRotate: false, pitchWithRotate: false, touchPitch: false, maxZoom: 19
    });
    map.touchZoomRotate.disableRotation();
    mapReady = new Promise(res => map.on('load', () => {
      map.addSource('legs', { type: 'geojson', data: legsData() });
      map.addLayer({ id: 'legs-casing', type: 'line', source: 'legs', filter: ['!=', ['get', 'state'], 'done'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#FFFFFF', 'line-width': ['match', ['get', 'state'], 'next', 10, 8], 'line-opacity': .9 } });
      map.addLayer({ id: 'legs-done', type: 'line', source: 'legs', filter: ['==', ['get', 'state'], 'done'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#8A97A1', 'line-width': 4, 'line-dasharray': [0.5, 2] } });
      map.addLayer({ id: 'legs-main', type: 'line', source: 'legs', filter: ['!=', ['get', 'state'], 'done'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': routeColor(), 'line-width': ['match', ['get', 'state'], 'next', 6, 4], 'line-opacity': ['match', ['get', 'state'], 'next', 1, .55] } });
      res();
    }));
    return mapReady;
  }
  function drawRoute() {
    markers.forEach(m => m.m.remove()); markers = [];
    tour.stops.forEach((st, i) => {
      const el = document.createElement('button');
      el.type = 'button'; el.className = 'mk';
      el.setAttribute('aria-label', (i + 1) + '. ' + st.title);
      el.innerHTML = '<span class="plaque">' + (i + 1) + '</span>';
      el.addEventListener('click', e => {
        e.stopPropagation(); lastMarkerTap = Date.now();
        // Sin GPS, tocar una parada que aún no has visitado cuenta como llegar a ella
        if (S.mode === 'sim' && !S.visited.includes(i)) arrive(i);
        else if (S.view !== i) openView(i);
      });
      markers.push({ el, m: new maplibregl.Marker({ element: el }).setLngLat([st.lng, st.lat]).addTo(map) });
    });
    map.resize();
    map.fitBounds(routeBounds(), { padding: { top: 64, bottom: 220, left: 36, right: 64 }, duration: 0 });
    mapReady.then(() => { map.setPaintProperty('legs-main', 'line-color', routeColor()); refreshMap(); });
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
      // Tu posición: el guía de la ciudad (los pies marcan el punto exacto); si no hay dibujo, un punto azul
      const el = document.createElement('div');
      const fig = city && city.figure;
      if (fig) { el.className = 'me-fig'; el.innerHTML = '<img src="' + esc(fig) + '" alt="Tu posición" width="46" height="50">'; }
      else el.className = 'me';
      userDot = new maplibregl.Marker({ element: el, anchor: fig ? 'bottom' : 'center' }).setLngLat(ll(S.pos)).addTo(map);
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
    $('#gpsIntro').checked = mode === 'gps';
    S.pos = null;
    if (userDot) { userDot.remove(); userDot = null; }
    if (mode === 'gps') startGps(); else stopGps();
    if (S.view == null) renderCard();
  }

  // ---------- Avisos ----------
  function unlockAudio() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) {}
    if (synth && !speechReady) {
      try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; synth.speak(u); } catch (e) {}
    }
    if (!speechReady) {
      try { player.src = silentWav(); const pr = player.play(); if (pr) pr.catch(() => {}); } catch (e) {}
    }
    speechReady = true;
  }

  // ---------- Audio grabado (MP3) ----------
  const player = new Audio(); player.preload = 'auto';
  let silentUrl = null;
  function silentWav() {
    if (silentUrl) return silentUrl;
    const n = 800, b = new ArrayBuffer(44 + n * 2), v = new DataView(b);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 16000, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
    silentUrl = URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
    return silentUrl;
  }
  const isAudioStop = i => !!(tour && tour.stops[i] && tour.stops[i].isAudio);
  function loadDurations(st) {
    if (!st.isAudio || st.durLoaded) return;
    st.durLoaded = true;
    st.chunks.forEach(ch => {
      const a = new Audio(); a.preload = 'metadata';
      a.addEventListener('loadedmetadata', () => {
        if (!isFinite(a.duration)) return;
        ch.dur = a.duration; recalcTimes(st);
        if (S.view != null && tour.stops[S.view] === st) {
          const sk = $('#seek'); if (sk) sk.max = Math.ceil(st.secs);
          const tt = $('#tTot'); if (tt) tt.textContent = fmtTime(st.secs / S.rate);
          renderPlayer();
        }
      }, { once: true });
      a.src = ch.src;
    });
  }
  // Posición global (segundos) dentro de la parada, en modo audio
  function audioTime() {
    const st = tour.stops[P.stop]; if (!st) return 0;
    const inItem = P.playing ? (player.currentTime || 0) : (P.off || 0);
    return (st.cum[Math.min(P.c, st.chunks.length - 1)] || 0) + inItem;
  }
  function finishStop() {
    // Fin de la parada: la tarjeta vuelve a «caminando» hacia la siguiente.
    P.playing = false; P.c = 0; P.off = 0; P.stop = -1;
    S.view = null; renderCard(); refreshMap();
  }
  function playItem(offset) {
    const st = tour.stops[P.stop];
    const id = ++P.session;
    if (!P.playing) return;
    if (P.c >= st.chunks.length) { finishStop(); return; }
    while (P.c < st.chunks.length - 1 && st.chunks[P.c].quiz && !S.askQuiz) P.c++;
    const ch = st.chunks[P.c];
    if (ch.quiz && S.askQuiz) showQuiz(false);
    player.onended = () => {
      if (id !== P.session || !P.playing) return;
      if (ch.quiz && S.askQuiz) { waitQuiz(); return; }
      P.c++; P.off = 0; playItem(0);
    };
    player.onerror = () => {
      if (id !== P.session) return;
      P.playing = false; renderPlayer();
      toast('No se pudo cargar el audio. Comprueba la conexión.');
    };
    let last = 0;
    player.ontimeupdate = () => { if (id === P.session && Date.now() - last > 400) { last = Date.now(); renderPlayer(); } };
    player.src = ch.src;
    player.playbackRate = S.rate;
    if (offset > 0.3) player.addEventListener('loadedmetadata', () => { if (id === P.session) { try { player.currentTime = offset; } catch (e) {} } }, { once: true });
    const pr = player.play();
    if (pr) pr.catch(() => { if (id !== P.session) return; P.playing = false; renderPlayer(); toast('Pulsa ▶ para escuchar.'); });
    renderPlayer(true);
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
    const st = tour.stops[i];
    if (!st.isAudio && !synth) { toast('Este navegador no puede leer en voz alta.'); return; }
    unlockAudio();
    if (P.stop !== i) { P.stop = i; P.c = 0; P.off = 0; }
    if (fromPart != null) { P.c = Math.max(0, st.chunks.findIndex(c => c.pi === fromPart)); P.off = 0; }
    if (P.c >= st.chunks.length) { P.c = 0; P.off = 0; }
    P.playing = true;
    restartSpeech();
    requestWake();
    renderPlayer();
  }
  function restartSpeech() {
    P.session++;
    if (isAudioStop(P.stop)) { player.pause(); const off = P.off || 0; P.off = 0; playItem(off); return; }
    synth.cancel(); setTimeout(speakNext, 60);
  }
  function pauseSpeech() {
    const wasAudio = isAudioStop(P.stop) && P.playing;
    P.playing = false; P.session++;
    if (synth) synth.cancel();
    if (wasAudio) { P.off = player.currentTime || 0; }
    try { player.pause(); } catch (e) {}
    cancelQuiz(); renderPlayer();
  }

  // ---------- Preguntas (como en un free tour: la guía pregunta y espera) ----------
  const QUIZ_WAIT = 20000;
  let Q = null, quizTimer = null;
  function showQuiz(waiting) {
    const box = $('#quiz'); if (!box || S.view == null) return;
    const q = tour.stops[S.view].quiz;
    box.innerHTML = '<p class="quiz-q">' + esc(q.q) + '</p>' +
      '<div class="quiz-opts">' + q.options.map((o, k) => '<button type="button" class="quiz-opt" data-act="quiz" data-i="' + k + '"><b>' + 'ABC'[k] + '</b><span>' + esc(o) + '</span></button>').join('') + '</div>' +
      '<div class="quiz-foot"><span class="quiz-timer"><span id="quizBar"></span></span><button type="button" class="link" data-act="quiz-skip">Saltar</button></div>';
    box.hidden = false;
    if (waiting) { const bar = $('#quizBar'); bar.style.animationDuration = (QUIZ_WAIT / 1000) + 's'; bar.classList.add('run'); }
    measureCard();
  }
  function waitQuiz() {
    Q = { stop: P.stop, c: P.c };
    showQuiz(true);
    clearTimeout(quizTimer);
    quizTimer = setTimeout(() => answerQuiz(null), QUIZ_WAIT);
  }
  function cancelQuiz() {
    clearTimeout(quizTimer); Q = null;
    const box = $('#quiz'); if (box && !box.hidden) { box.hidden = true; box.innerHTML = ''; measureCard(); }
  }
  function answerQuiz(i) {
    if (!Q || Q.stop !== P.stop) return;
    clearTimeout(quizTimer);
    const stopI = Q.stop, q = tour.stops[stopI].quiz, ok = i === q.answer;
    Q = null;
    if (i != null) { S.score[stopI] = ok; save(); }
    document.querySelectorAll('#quiz .quiz-opt').forEach((b, k) => {
      b.disabled = true;
      if (k === q.answer) b.classList.add('is-right');
      else if (k === i) b.classList.add('is-wrong');
    });
    const bar = $('#quizBar'); if (bar) bar.classList.remove('run');
    const say = ok ? '¡Correcto!' : (i == null ? 'Te lo digo yo: ' : '¡Casi! ') + 'La respuesta es: ' + q.options[q.answer] + '.';
    const id = ++P.session;
    const next = () => {
      if (id !== P.session) return;
      setTimeout(() => { if (id !== P.session) return; cancelQuiz(); P.c++; P.off = 0; speakNext(); }, 900);
    };
    const st = tour.stops[stopI];
    const src = st.isAudio && st.audio && (ok ? st.audio.ok : (i == null ? st.audio.skip : st.audio.ko));
    if (src) {
      player.onended = next; player.onerror = next; player.ontimeupdate = null;
      player.src = src; player.playbackRate = S.rate;
      const pr = player.play(); if (pr) pr.catch(next);
      return;
    }
    if (!synth) { next(); return; }
    const u = new SpeechSynthesisUtterance(say);
    u.lang = voice ? voice.lang : tour.lang; if (voice) u.voice = voice; u.rate = S.rate;
    u.onend = next; u.onerror = next;
    synth.speak(u);
  }
  function speakNext() {
    if (isAudioStop(P.stop)) { playItem(P.off || 0); P.off = 0; return; }
    const st = tour.stops[P.stop];
    const id = ++P.session;
    if (!P.playing) return;
    if (P.c >= st.chunks.length) { finishStop(); return; }
    while (P.c < st.chunks.length - 1 && st.chunks[P.c].quiz && !S.askQuiz) P.c++;
    const ch = st.chunks[P.c];
    const u = new SpeechSynthesisUtterance(ch.s);
    u.lang = voice ? voice.lang : tour.lang;
    if (voice) u.voice = voice;
    u.rate = S.rate;
    if (ch.quiz && S.askQuiz) showQuiz(false);
    u.onend = () => {
      if (id !== P.session || !P.playing) return;
      if (ch.quiz && S.askQuiz) { waitQuiz(); return; }
      P.c++; speakNext();
    };
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
    S.view = i; S.showText = false; lastFollowPi = -1;
    loadDurations(tour.stops[i]);
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
      h += '<button class="grab" id="grab" type="button" data-act="text" aria-label="' + (S.showText ? 'Ocultar texto' : 'Ver texto') + '"><span></span></button>' +
        '<div class="c-head"><span class="plaque">' + pad(i + 1) + '</span><div class="c-main">' +
        '<p class="eyebrow' + (isArrival ? ' ok' : '') + '">' + (isArrival ? 'Has llegado' : 'Parada ' + (i + 1) + ' de ' + tour.stops.length) + '</p>' +
        '<h2 class="c-title">' + esc(st.title) + '</h2></div>' +
        (st.image ? '<button class="c-thumb" type="button" data-act="img" aria-label="Ver imagen: ' + esc(st.image.caption) + '"><img src="' + esc(st.image.src) + '" alt=""></button>' : '') +
        '<button class="x" type="button" data-act="close" aria-label="Cerrar parada">' + ICON.close + '</button></div>' +
        '<div class="quiz" id="quiz" hidden></div>' +
        '<div class="ctrl">' +
          '<button class="skip" type="button" data-act="back" aria-label="' + (st.isAudio ? 'Retroceder 10 segundos' : 'Retroceder una frase') + '">' + ICON.back + '</button>' +
          '<button class="pbtn" id="btnPlay" type="button" data-act="play"></button>' +
          '<button class="skip" type="button" data-act="fwd" aria-label="' + (st.isAudio ? 'Avanzar 10 segundos' : 'Avanzar una frase') + '">' + ICON.fwd + '</button>' +
          '<div class="seek"><input type="range" id="seek" min="0" max="' + (st.isAudio ? Math.ceil(st.secs) : st.chunks.length - 1) + '" step="1" value="0" aria-label="Posición en la explicación">' +
            '<div class="times"><span id="tNow">0:00</span><span id="tTot">' + fmtTime(st.secs / (st.isAudio ? S.rate : 1)) + '</span></div></div>' +
        '</div>' +
        '<div class="c-body" id="cBody"' + (S.showText ? '' : ' hidden') + '>' +
          '<p class="where"><b>Dónde ponerte</b>' + esc(st.where) + '</p>' +
          st.paras.map((p, pi) => (st.image && st.image.para === pi ? figureHTML(st.image) : '') + '<p class="para" data-p="' + pi + '">' + esc(p) + '</p>').join('') +
          (st.toNext ? '<p class="next-box" data-p="' + st.paras.length + '"><b>Camino a la siguiente · ' + fmtDist(st.legNext) + '</b>' + esc(st.toNext) + '</p>' : '') +
        '</div>';
    } else if (S.target == null) {
      h += '<div class="c-head"><span class="plaque">✓</span><div class="c-main"><p class="eyebrow ok">Recorrido completado</p><h2 class="c-title">¡Bravo!</h2></div></div>' +
        '<p class="c-text">Has visitado las ' + tour.stops.length + ' paradas. Puedes volver a escuchar cualquiera tocando su número en el mapa.</p>' +
        (Object.keys(S.score).length ? '<p class="score">Has acertado <b>' + Object.values(S.score).filter(Boolean).length + ' de ' + Object.keys(S.score).length + '</b> preguntas</p>' : '') +
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
      if (!S.visited.length && S.target === 0) h += '<a class="link" href="' + esc(mapsUrl(meeting())) + '" target="_blank" rel="noopener">Cómo llegar con Google Maps</a>';
      if (S.mode === 'gps' && !S.pos) h += '<p class="c-text muted">' + esc(gpsError || 'Buscando tu posición…') + '</p>';
      if (S.mode === 'sim') h += '<button class="btn btn-ghost btn-big" type="button" data-act="sim-go">Ya estoy aquí</button>';
    }
    card.innerHTML = h;
    card.classList.toggle('is-open', S.view != null && S.showText);
    if (S.view != null) renderPlayer();
    measureCard();
  }

  // ---------- Imágenes: una por parada, en el texto, en miniatura y a pantalla completa ----------
  function figureHTML(im) {
    return '<figure class="fig" data-act="img"><img src="' + esc(im.src) + '" alt="' + esc(im.caption) + '" loading="lazy"' +
      (im.w ? ' width="' + im.w + '" height="' + im.h + '"' : '') + '>' +
      '<figcaption>' + esc(im.caption) + (im.credit ? '<span class="credit">' + esc(im.credit) + '</span>' : '') + '</figcaption></figure>';
  }
  function openImage(i) {
    const im = tour.stops[i] && tour.stops[i].image; if (!im) return;
    $('#lbImg').src = im.src; $('#lbImg').alt = im.caption;
    $('#lbCaption').textContent = im.caption;
    $('#lbCredit').textContent = im.credit || '';
    const a = $('#lbLink');
    a.hidden = !im.source; a.href = im.source || '#';
    a.textContent = /wikimedia\.org/.test(im.source || '') ? 'Ver en Wikimedia Commons' : 'Ver la fuente';
    $('#lightbox').hidden = false;
  }
  function closeImage() { $('#lightbox').hidden = true; }
  // Guarda las imágenes de la ruta para verlas sin conexión
  async function cacheImages() {
    if (!('caches' in window) || !navigator.onLine) return;
    try {
      const c = await caches.open(MEDIA_CACHE);
      for (const st of tour.stops) {
        if (st.image && !(await c.match(st.image.src))) { try { await c.add(st.image.src); } catch (e) {} }
      }
    } catch (e) {}
  }

  function measureCard() {
    const h = $('#card').offsetHeight;
    if (Math.abs(h - cardH) > 2) { cardH = h; document.documentElement.style.setProperty('--card-h', h + 'px'); }
  }

  let seeking = false;
  function paintSeek(v) {
    const st = tour.stops[S.view], el = $('#seek'); if (!el) return;
    if (st.isAudio) {
      el.style.setProperty('--pct', (st.secs ? 100 * Math.min(v, st.secs) / st.secs : 0) + '%');
      $('#tNow').textContent = fmtTime(v / S.rate);
      return;
    }
    const max = st.chunks.length - 1;
    el.style.setProperty('--pct', (max ? 100 * v / max : 0) + '%');
    $('#tNow').textContent = fmtTime(st.cum[v] / S.rate);
  }
  function seekTo(c) {
    if (S.view == null) return;
    const st = tour.stops[S.view];
    if (P.stop !== S.view) { if (P.playing) pauseSpeech(); P.stop = S.view; }
    cancelQuiz();
    P.c = Math.max(0, Math.min(c, st.chunks.length - 1)); P.off = 0;
    if (P.playing) restartSpeech();
    renderPlayer(true);
  }
  // Con audio grabado: saltar a un segundo concreto de la parada
  function seekTime(t) {
    if (S.view == null) return;
    const st = tour.stops[S.view];
    if (P.stop !== S.view) { if (P.playing) pauseSpeech(); P.stop = S.view; P.c = 0; P.off = 0; }
    cancelQuiz();
    t = Math.max(0, Math.min(t, st.secs - 0.5));
    let c = 0;
    while (c < st.chunks.length - 1 && st.cum[c + 1] <= t) c++;
    P.c = c; P.off = t - st.cum[c];
    if (P.playing) restartSpeech();
    renderPlayer(true);
  }
  function renderPlayer(scroll) {
    const btn = $('#btnPlay'); if (!btn || S.view == null) return;
    const st = tour.stops[S.view];
    const active = P.stop === S.view;
    const playing = active && P.playing;
    const started = active && (P.playing || P.c > 0 || P.off > 0);
    const bState = playing ? 'p' : (started ? 'c' : 'e');
    if (btn.dataset.state !== bState) {
      btn.dataset.state = bState;
      btn.innerHTML = playing ? ICON.pause : ICON.play;
      btn.setAttribute('aria-label', playing ? 'Pausar' : (started ? 'Continuar' : 'Escuchar'));
    }
    const c = active ? Math.min(P.c, st.chunks.length - 1) : 0;
    const v = st.isAudio ? (active ? audioTime() : 0) : c;
    if (!seeking) { $('#seek').value = v; paintSeek(v); }
    const pi = started ? st.chunks[Math.min(P.c, st.chunks.length - 1)].pi : -1;
    document.querySelectorAll('#cBody [data-p]').forEach(p => p.classList.toggle('is-reading', +p.dataset.p === pi));
    // La miniatura se ilumina mientras la guía habla de lo que muestra
    const th = $('#card .c-thumb'); if (th) th.classList.toggle('is-now', !!(playing && st.image && st.image.para === pi));
    if (scroll && started && S.showText && pi !== lastFollowPi) { lastFollowPi = pi; followReading(); }
  }

  // Seguir la lectura con el texto abierto, salvo si la persona se está moviendo por el texto:
  // entonces se deja quieto y se retoma a los 8 s sin tocar la pantalla.
  let userScrollUntil = 0, followTimer = null, lastFollowPi = -1;
  function followReading(force) {
    if (S.view == null || !S.showText || P.stop !== S.view || animating) return;
    if (!force && Date.now() < userScrollUntil) return;
    const st = tour.stops[S.view];
    const pi = st.chunks[Math.min(P.c, st.chunks.length - 1)].pi;
    const el = document.querySelector('#cBody [data-p="' + pi + '"]'), body = $('#cBody');
    if (!el || !body) return;
    const top = body.scrollTop, bottom = top + body.clientHeight;
    if (el.offsetTop >= top + 8 && el.offsetTop + Math.min(el.offsetHeight, body.clientHeight * .5) <= bottom - 8) return;
    body.scrollTo({ top: Math.max(0, el.offsetTop - 12), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
  function userScrolled() {
    if (!S.showText) return;
    userScrollUntil = Date.now() + 8000;
    clearTimeout(followTimer);
    followTimer = setTimeout(() => { if (P.playing) followReading(true); }, 8100);
  }

  // Texto: se despliega deslizando la tarjeta hacia arriba y se recoge deslizando hacia abajo.
  // La tarjeta sigue al dedo y, al soltar, termina el movimiento con una animación suave.
  let collapsedH = 0, animating = false, swipedAt = 0;
  const maxOpenH = () => Math.round(window.innerHeight * 0.82);
  function applyText(on) {
    S.showText = on;
    const card = $('#card');
    $('#cBody').hidden = !on;
    $('#grab').setAttribute('aria-label', on ? 'Ocultar texto' : 'Ver texto');
    card.classList.toggle('is-open', on);
    if (!on) { card.scrollTop = 0; $('#cBody').scrollTop = 0; }
    measureCard();
    if (on) { renderPlayer(); userScrollUntil = 0; followReading(true); }
  }
  function animateText(on, fromH) {
    if (S.view == null) return;
    if (fromH == null && on === S.showText) return;
    const card = $('#card');
    if (fromH == null && !S.showText) collapsedH = card.offsetHeight;
    const start = fromH != null ? fromH : card.offsetHeight;
    let target;
    if (on) {
      $('#cBody').hidden = false; card.classList.add('is-open');
      card.style.height = 'auto';
      target = Math.min(card.scrollHeight, maxOpenH());
    } else target = collapsedH || 160;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { card.style.height = ''; applyText(on); return; }
    card.style.transition = 'none';
    card.style.overflowY = 'hidden';
    card.style.height = start + 'px';
    void card.offsetHeight;
    card.style.transition = 'height .34s cubic-bezier(.22,.9,.25,1)';
    card.style.height = target + 'px';
    animating = true;
    let t;
    const done = () => {
      card.removeEventListener('transitionend', done); clearTimeout(t);
      animating = false;
      card.style.transition = ''; card.style.height = ''; card.style.overflowY = '';
      applyText(on);
    };
    card.addEventListener('transitionend', done);
    t = setTimeout(done, 500);
  }
  function setText(on) { animateText(on); }

  function bindSwipe() {
    const card = $('#card');
    let y0 = null, h0 = 0, top0 = 0, dragging = false, lastY = 0, lastT = 0, vel = 0;
    const start = (y, target) => {
      if (S.view == null || animating || (target && target.closest('input'))) { y0 = null; return; }
      const body = $('#cBody');
      y0 = y; h0 = card.offsetHeight; dragging = false;
      top0 = (body && target && target.closest('#cBody')) ? body.scrollTop : 0;
      lastY = y; lastT = performance.now(); vel = 0;
    };
    const move = (y, e) => {
      if (y0 == null) return;
      const dy = y - y0;
      if (!dragging) {
        if (Math.abs(dy) < 8) return;
        if (dy < 0 && !S.showText) {
          dragging = true; collapsedH = h0;
          $('#cBody').hidden = false; card.classList.add('is-open');
        } else if (dy > 0 && S.showText && top0 <= 0) {
          dragging = true;
        } else { y0 = null; return; }
        card.style.transition = 'none'; card.style.overflowY = 'hidden';
      }
      if (e && e.cancelable) e.preventDefault();
      const minH = collapsedH || 120;
      card.style.height = Math.max(minH, Math.min(maxOpenH(), h0 - dy)) + 'px';
      const now = performance.now();
      vel = (y - lastY) / Math.max(1, now - lastT); lastY = y; lastT = now;
    };
    const end = y => {
      if (y0 == null) return;
      const dy = y - y0; y0 = null;
      if (!dragging) return;
      dragging = false; swipedAt = Date.now();
      const wasOpen = S.showText;
      const open = wasOpen ? !(dy > 80 || vel > 0.4) : (dy < -50 || vel < -0.4);
      animateText(open, card.offsetHeight);
    };
    card.addEventListener('touchstart', e => start(e.touches[0].clientY, e.target), { passive: true });
    card.addEventListener('touchmove', e => move(e.touches[0].clientY, e), { passive: false });
    card.addEventListener('touchend', e => end(e.changedTouches[0].clientY), { passive: true });
    card.addEventListener('touchcancel', e => end(e.changedTouches[0].clientY), { passive: true });
    card.addEventListener('touchmove', () => { if (!dragging) userScrolled(); }, { passive: true });
    card.addEventListener('wheel', userScrolled, { passive: true });
    card.addEventListener('mousedown', e => start(e.clientY, e.target));
    window.addEventListener('mousemove', e => { if (y0 != null) move(e.clientY, e); });
    window.addEventListener('mouseup', e => end(e.clientY));
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
    pauseSpeech(); S.visited = []; S.score = {}; S.target = 0; S.arrived = null; S.view = null; P.stop = -1; P.c = 0; save();
    closeSheet(); renderCard(); refreshMap(); fitRoute(); toast('Recorrido reiniciado.');
  }
  function begin(mode) {
    unlockAudio(); requestWake();
    showScreen('tour');
    map.resize();
    measureCard();
    setMode(mode);
    if (!S.mapSaved) setTimeout(saveOffline, 4000);
    setTimeout(cacheImages, 2500);
  }
  function bind() {
    bindSwipe();
    $('#copyAddr').addEventListener('click', async () => {
      const m = meeting();
      toast(await copyText(m.address) ? 'Dirección copiada' : 'No se pudo copiar. Mantén pulsada la dirección para copiarla.');
    });
    $('#startGps').addEventListener('click', () => begin($('#gpsIntro').checked ? 'gps' : 'sim'));

    $('#card').addEventListener('click', e => {
      const b = e.target.closest('[data-act]');
      const act = b && b.dataset.act;
      if (act === 'close') { closeView(); return; }
      if (act === 'img') { if (Date.now() - swipedAt > 400) openImage(S.view); return; }
      if (act === 'play') { if (P.playing && P.stop === S.view) pauseSpeech(); else playStop(S.view); return; }
      if (act === 'text') { if (Date.now() - swipedAt > 400) setText(!S.showText); return; }
      if (act === 'restart') { resetTour(); return; }
      if (act === 'quiz') { answerQuiz(+b.dataset.i); return; }
      if (act === 'quiz-skip') { if (Q) answerQuiz(null); else { cancelQuiz(); if (P.playing) { P.c++; restartSpeech(); } } return; }
      if (act === 'back' || act === 'fwd') {
        if (isAudioStop(S.view)) { const now = P.stop === S.view ? audioTime() : 0; seekTime(now + (act === 'back' ? -10 : 10)); return; }
        const cur = P.stop === S.view ? P.c : 0;
        seekTo(cur + (act === 'back' ? -1 : 1));
        return;
      }
      if (act === 'sim-go' && S.target != null) { arrive(S.target); return; }
      const p = e.target.closest('[data-p]');
      if (p && S.view != null) playStop(S.view, +p.dataset.p);
    });

    $('#card').addEventListener('input', e => {
      if (e.target.id !== 'seek') return;
      seeking = true; paintSeek(+e.target.value);
    });
    $('#card').addEventListener('change', e => {
      if (e.target.id !== 'seek') return;
      seeking = false;
      if (isAudioStop(S.view)) seekTime(+e.target.value); else seekTo(+e.target.value);
    });
    $('#btnLocate').addEventListener('click', () => { if (S.pos) flyTo(S.pos[0], S.pos[1], 17); else fitRoute(); });
    $('#btnMenu').addEventListener('click', openSheet);
    $('#sheetClose').addEventListener('click', closeSheet);
    $('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });
    $('#stopList').addEventListener('click', e => {
      const b = e.target.closest('.si'); if (!b) return;
      closeSheet(); openView(+b.dataset.i);
    });
    // ‹ en el mapa: pausa y vuelve a la presentación de la ruta (allí se enciende o apaga el GPS)
    $('#btnBack').addEventListener('click', () => {
      pauseSpeech(); stopGps();
      refreshIntro();
      showScreen('intro');
      $('#intro').scrollTop = 0;
    });
    $('#optQuiz').addEventListener('change', e => { S.askQuiz = e.target.checked; save(); if (!S.askQuiz && Q) answerQuiz(null); });
    $('#optRate').addEventListener('change', e => {
      S.rate = parseFloat(e.target.value) || 1; save();
      if (isAudioStop(P.stop)) { player.playbackRate = S.rate; renderPlayer(); }
      else if (P.playing) restartSpeech();
    });
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
    $('#lightbox').addEventListener('click', e => { if (!e.target.closest('a')) closeImage(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#lightbox').hidden) closeImage(); });
    window.addEventListener('resize', () => measureCard());
  }

  // ---------- Pantallas y navegación ----------
  function showScreen(name) {
    $('#home').hidden = name !== 'home';
    $('#city').hidden = name !== 'city';
    $('#intro').hidden = name !== 'intro';
    $('#tourUI').hidden = name !== 'tour';
    closeSheet();
  }
  const THEME_VARS = { accent: '--accent', accent2: '--accent-2', plaque: '--plaque', plaqueFrame: '--plaque-frame', plaqueInk: '--plaque-ink', plaqueLine: '--plaque-line' };
  function applyTheme(c) {
    const st = document.documentElement.style;
    Object.values(THEME_VARS).forEach(v => st.removeProperty(v));
    if (c && c.theme) Object.entries(THEME_VARS).forEach(([k, v]) => { if (c.theme[k]) st.setProperty(v, c.theme[k]); });
    const mc = document.querySelector('meta[name="theme-color"]');
    if (mc) mc.setAttribute('content', (c && c.theme && c.theme.accent) || '#1E3E66');
  }
  const routeColor = () => (city && city.theme && city.theme.accent) || '#1E3E66';
  // Mascota de la ciudad (si no hay dibujo, su placa de calle)
  function mascotHTML(c, cls) {
    return c.icon ? '<img class="' + cls + '" src="' + esc(c.icon) + '" alt="" width="96" height="96">' : signHTML(c);
  }
  function signHTML(c, small) {
    return '<span class="sign sign-' + c.sign + (small ? ' sm' : '') + '">' + esc(c.signText) + (c.signSmall ? ' <small>' + esc(c.signSmall) + '</small>' : '') + '</span>';
  }
  async function getTour(c, r) {
    const key = c.id + '/' + r.id;
    if (!tourCache[key]) {
      const res = await fetch(r.file, { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const t = await res.json(); prepare(t); tourCache[key] = t;
    }
    return tourCache[key];
  }
  const hoursText = t => (Math.round(t.totalH * 2) / 2).toString().replace('.', ',');
  const readyRoutes = c => (c.routes || []).filter(r => r.status === 'ready' && r.file);

  function leaveRoute() {
    if (!tour) return;
    pauseSpeech(); stopGps();
    markers.forEach(m => m.m.remove()); markers = [];
    if (userDot) { userDot.remove(); userDot = null; }
    tour = null; routeMeta = null; STORE = '';
    S = fresh(); load();
    P.stop = -1; P.c = 0;
  }

  function renderHome() {
    leaveRoute();
    applyTheme(null);
    document.title = catalog.app;
    $('#cityList').innerHTML = catalog.cities.map(c => {
      const n = readyRoutes(c).length;
      const wip = c.status !== 'ready' || !n;
      const meta = wip ? 'En preparación · ' + (c.routes || []).length + ' rutas previstas' : n + (n > 1 ? ' rutas disponibles' : ' ruta disponible') + ' · ' + esc(c.country);
      const pic = c.icon ? '<img class="cc-icon" src="' + esc(c.icon) + '" alt="" width="64" height="64">' : signHTML(c, true);
      return '<li><a class="city-card' + (wip ? ' is-wip' : '') + '" href="#' + c.id + '">' + pic +
        '<span><span class="cc-name">' + esc(c.name) + '</span><span class="cc-meta">' + meta + '</span></span>' +
        (wip ? '<span class="badge">WIP</span>' : '<span class="chev" aria-hidden="true">›</span>') + '</a></li>';
    }).join('');
    showScreen('home');
  }

  async function renderCity(cid) {
    leaveRoute();
    city = catalog.cities.find(c => c.id === cid);
    if (!city) { location.hash = ''; return; }
    applyTheme(city);
    document.title = city.name + ' · ' + catalog.app;
    $('#citySign').innerHTML = mascotHTML(city, 'mascot-lg');
    $('#cityName').textContent = city.name;
    $('#cityBlurb').textContent = city.blurb || '';
    const list = $('#routeList');
    if (!(city.routes || []).length) list.innerHTML = '<li><p class="empty">Estamos preparando las rutas de ' + esc(city.name) + '.</p></li>';
    else list.innerHTML = city.routes.map(r => {
      const ready = r.status === 'ready' && r.file;
      const inner = '<span class="eyebrow"><span>' + esc(r.label || '') + '</span>' + (ready ? '' : '<span class="badge">WIP</span>') + '</span>' +
        '<span class="rc-title">' + esc(r.title) + '</span><span class="rc-sub">' + esc(r.subtitle || '') + '</span>' +
        (ready ? '<span class="rc-meta" data-meta="' + r.id + '"></span>' : '<span class="rc-sub">Próximamente</span>');
      return '<li>' + (ready ? '<a class="route-card" href="#' + city.id + '/' + r.id + '">' + inner + '</a>' : '<div class="route-card is-wip">' + inner + '</div>') + '</li>';
    }).join('');
    showScreen('city');
    $('#city').scrollTop = 0;
    for (const r of readyRoutes(city)) {
      try {
        const t = await getTour(city, r);
        const el = list.querySelector('[data-meta="' + r.id + '"]');
        if (el) el.textContent = t.stops.length + ' paradas · ' + fmtDist(t.totalM) + ' · unas ' + hoursText(t) + ' h';
      } catch (e) {}
    }
  }

  async function openRoute(cid, rid) {
    const c = catalog.cities.find(x => x.id === cid);
    const r = c && (c.routes || []).find(x => x.id === rid);
    if (!c || !r || r.status !== 'ready' || !r.file) { location.hash = c ? c.id : ''; return; }
    if (tour && routeMeta === r) { showScreen('intro'); return; }
    leaveRoute();
    city = c; routeMeta = r;
    applyTheme(c);
    try { tour = await getTour(c, r); }
    catch (e) { toast('No se pudo cargar la ruta. Comprueba la conexión.'); location.hash = c.id; return; }
    STORE = 'audioguia-' + c.id + '-' + r.id + '-v1';
    S = fresh(); load();
    if (S.target != null && !tour.stops[S.target]) S.target = 0;
    S.visited = (S.visited || []).filter(i => tour.stops[i]);

    const hours = hoursText(tour);
    document.title = tour.title + ' · ' + catalog.app;
    $('#introBack').href = '#' + c.id; $('#introBack').textContent = '‹ ' + c.name;
    $('#exitRoute').href = '#' + c.id;
    $('#introSign').innerHTML = mascotHTML(c, 'mascot-md');
    $('#introLabel').textContent = r.label || '';
    $('#introTitle').textContent = tour.title;
    $('#introSub').textContent = tour.subtitle + '.';
    $('#introStats').textContent = tour.stops.length + ' paradas · ' + fmtDist(tour.totalM) + ' a pie · unas ' + hours + ' horas';
    $('#sheetTitle').textContent = tour.title;
    $('#sheetSub').textContent = tour.stops.length + ' paradas · ' + fmtDist(tour.totalM) + ' · unas ' + hours + ' h';
    refreshIntro();
    renderMeeting();
    const vc = $('#voiceCredit');
    vc.hidden = !(tour.audio && tour.audio.credit);
    vc.textContent = tour.audio && tour.audio.credit ? tour.audio.credit + '.' : '';
    $('#optRate').value = String(S.rate);
    $('#optQuiz').checked = S.askQuiz;
    $('#offlineMsg').textContent = S.mapSaved ? 'Mapa de la zona guardado: funciona sin datos.' : 'El mapa de la zona se guarda solo al empezar, para usarlo sin datos.';
    if (synth) loadVoices();

    showScreen('intro');
    ensureMap();
    drawRoute();
    renderCard();
  }

  // Punto de encuentro: el de la ruta o, si no hay, la primera parada
  function meeting() {
    const m = tour.meeting || {}, st = tour.stops[0];
    return { name: m.name || st.title, address: m.address || '', note: m.note || st.where, lat: st.lat, lng: st.lng };
  }
  function mapsUrl(m) {
    return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(m.address || (m.lat + ',' + m.lng));
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch (e) {
      try {
        const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', '');
        ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta);
        ta.select(); ta.setSelectionRange(0, text.length);
        const ok = document.execCommand('copy'); ta.remove(); return ok;
      } catch (e2) { return false; }
    }
  }
  function renderMeeting() {
    const m = meeting();
    $('#meet').hidden = false;
    $('#meetName').textContent = m.name;
    $('#meetAddr').textContent = m.address;
    $('#meetAddr').hidden = !m.address;
    $('#meetNote').textContent = m.note || '';
    $('#copyAddr').hidden = !m.address;
    $('#mapsLink').href = mapsUrl(m);
  }

  function refreshIntro() {
    if (!tour) return;
    $('#gpsIntro').checked = S.mode !== 'sim';
    $('#startGps').textContent = (S.visited.length && S.target != null) ? 'Continuar el recorrido (' + S.visited.length + '/' + tour.stops.length + ')' : 'Empezar el recorrido';
  }

  function router() {
    const [cid, rid] = location.hash.replace(/^#\/?/, '').split('/');
    if (!cid) renderHome();
    else if (!rid) renderCity(cid);
    else openRoute(cid, rid);
  }

  // ---------- Arranque ----------
  async function boot() {
    load();
    try {
      const res = await fetch(CATALOG_URL, { cache: 'no-cache' });
      catalog = await res.json();
    } catch (e) {
      $('#homeNote').hidden = false; $('#homeNote').textContent = 'No se pudieron cargar las ciudades. Comprueba la conexión y recarga.'; return;
    }
    $('#appName').textContent = catalog.app;
    $('#appTagline').textContent = catalog.tagline || '';
    bind();
    if (synth) { loadVoices(); if ('onvoiceschanged' in synth) synth.onvoiceschanged = loadVoices; }
    window.addEventListener('hashchange', router);
    router();

    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }
  boot();
})();
