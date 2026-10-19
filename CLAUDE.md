# Paseíto: free tours de bolsillo

Web app gratuita (PWA, sin build) con audioguías a pie estilo free tour, organizadas por
ciudad y ruta. Está publicada con GitHub Pages desde el repo **público**
`maxcubcru88/Audioguias` (rama `main`, carpeta raíz).

**El `README.md` es la documentación completa**: estructura, formato JSON de las rutas,
imágenes, audios con ElevenLabs, cómo probarla y cómo publicarla. Léelo antes de tocar
nada.

## Contenido actual (oct 2026)

- **París**, lista: `centro`, `latino`, `montmartre`, `torre-eiffel`, `marais`,
  `notre-dame`, `arco-triunfo`.
- **Londres**, lista: `westminster`, `city`.
- **Sevilla**, en preparación (WIP): `centro`, `triana`…
- La fuente de verdad es `data/catalogo.json`. La lista de rutas del README se ha
  quedado atrás: conviene actualizarla.
- `data/paris-centro.json`, en la raíz de `data/`, parece un resto antiguo de
  `data/paris/centro.json`. Comprobar si se usa antes de borrarlo.

## Reglas

- **Guiones:** usar la skill `guion-free-tour`, que recoge el tono de guía cercano, la
  estructura por parada, las preguntas, las historias para curiosos, el rigor de datos y
  el formato JSON.
- **Versión:** cada cambio de diseño o de código obliga a subir `const VERSION` en
  `sw.js` (ahora `v52`) y el `?v=` de `css/app.css` y `js/app.js`, tanto en `index.html`
  como en `FILES` de `sw.js`. Los cambios solo de texto en el JSON no lo necesitan.
- **Rutas nuevas:** añadir su JSON a `FILES` en `sw.js`, para que funcionen sin conexión.
- **Imágenes:**
  - Solo de dominio público o con licencia libre (Wikimedia Commons), siempre con
    `credit` y `source`.
  - En WebP, de unos 1.100 px por el lado largo y **menos de 150 KB**.
  - Si cambia una imagen, se le cambia también el nombre de archivo.
- **Audios:** con `tools/generar_audios.py` (ElevenLabs), que regenera solo lo que
  cambia. La clave va en la variable de entorno `ELEVENLABS_API_KEY` y **nunca en el
  repo**. Los MP3 se guardan en `audio/<ciudad>/<ruta>/`.
- **Mapa:** OpenFreeMap (estilo en `STYLE_URL`, en `js/app.js`) y MapLibre GL 4.7.1 en
  `vendor/`.
- **Para probarla:** `python -m http.server 8000` y usar «Probar desde casa».

## Git en esta carpeta

- `git` no está en el PATH: se usa el de GitHub Desktop
  (`%LOCALAPPDATA%\GitHubDesktop\app-*\resources\app\git\cmd\git.exe`).
- Al estar en Dropbox, `git commit` puede fallar con *"unable to append to
  .git/logs/HEAD"*. Se arregla añadiendo `-c windows.appendAtomically=false` al comando.
- El repo pesa: unos 290 MB de historial y 265 MB de audios.

## Historial y contexto

- 4 oct 2026: se crea el proyecto. Los chats originales se perdieron con el XPS.
- 19 oct 2026: se mueve de `01_Documentos\30_Audioguías\Audioguías` a
  `32_Claude\Projects - Max\20261004-Paseito-Audioguias`. Se hace commit de las fotos
  `*-sitio.webp` de Montmartre, que estaban pendientes.

## Estado / pendiente

- Las 9 fotos `*-sitio.webp` de Montmartre pesan entre 135 y 320 KB, por encima de los
  150 KB recomendados. Valorar recomprimirlas, cambiándoles el nombre.
- Actualizar la lista de rutas del README.
- Fase 2 (futuro): versión nativa, para tener avisos con la pantalla apagada en iPhone,
  reutilizando `data/`.
- Actualizar esta sección al terminar cada sesión de trabajo.
