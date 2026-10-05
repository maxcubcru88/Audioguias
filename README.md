# Paseíto · free tours de bolsillo

Paseíto es una web app gratuita (PWA) con audioguías a pie estilo free tour, organizada por ciudades y rutas.

- **París**: «El corazón de París» (9 paradas, del Hôtel de Ville a las Tullerías, unos 2,7 km) y «Los orígenes de París» (9 paradas por el Barrio Latino, de Shakespeare and Company a las Termas de Cluny, unos 3,2 km).
- **Londres** y **Sevilla**: en preparación (WIP).

Pantallas: Inicio (ciudades) → Ciudad (rutas) → Ruta (mapa + tarjeta). Cada ruta tiene su enlace directo,
por ejemplo `.../Audioguias/#paris/centro`, y guarda su propio progreso.

## Qué hace

- Mapa con la ruta, las paradas numeradas como placas de calle y tu posición GPS.
- Te avisa (sonido y vibración en Android) al entrar en el radio de cada parada y empieza a leer el guion.
- Indica la distancia a la siguiente parada y cómo llegar.
- Voz del propio móvil, con selector de voz y velocidad.
- **GPS opcional**: con el GPS apagado avanzas tú, parada a parada («Ya estoy aquí» o tocando la parada). Sirve también para escuchar el tour desde casa.
- Funciona sin conexión: la app se guarda al abrirla y el mapa de la zona se guarda solo al empezar una ruta.
- Preguntas para adivinar en cada parada (se pueden desactivar), con marcador al final.
- Recuerda qué paradas has visitado.

Limitación: en iPhone, una web app solo usa el GPS y la voz con la pantalla encendida y la app abierta.
Los avisos con la pantalla apagada llegarán con la versión nativa (fase 2), que reutilizará los mismos archivos de `data/`.

## Estructura

```
index.html                 la app
css/app.css                estilos
js/app.js                  lógica (mapa, GPS, avisos, voz)
data/catalogo.json         ciudades y rutas (nombre de la app, textos de portada, estado WIP/listo)
data/paris/centro.json     EL CONTENIDO de una ruta: paradas, textos, coordenadas y trazado
sw.js                      service worker (uso sin conexión)
manifest.webmanifest       nombre e icono al instalarla
vendor/maplibre/           librería de mapas (MapLibre GL 4.7.1)
icons/                     iconos
```

## Editar el contenido

### Añadir una ciudad o una ruta

1. En `data/catalogo.json`, añade la ciudad (o la ruta dentro de su ciudad). Mientras no esté lista,
   déjala con `"status": "wip"` y sin `file`: aparecerá como «En preparación».
2. Crea el archivo de la ruta, por ejemplo `data/londres/westminster.json`, copiando la estructura de
   `data/paris/centro.json`.
3. Cuando esté lista, pon `"status": "ready"` y `"file": "data/londres/westminster.json"` en el catálogo.
4. Añade el archivo nuevo a la lista `FILES` de `sw.js` para que funcione sin conexión.

El aspecto de la placa de cada ciudad se elige con `"sign"` (`paris`, `london`, `sevilla`) y el texto con
`"signText"` / `"signSmall"`.

### Editar una ruta

Cada archivo de ruta, como `data/paris/centro.json`, contiene:

- `meeting`: el punto de encuentro (`name`, `address`, `note`). La dirección se puede copiar y abrir en Google Maps
  desde la portada de la ruta. Si falta, se usa la primera parada.
- `stops`: cada parada tiene `title`, `subtitle`, `lat`, `lng`, `radius` (metros para el aviso),
  `where` (dónde ponerse), `paras` (párrafos del guion) y `toNext` (cómo llegar a la siguiente).
- `quiz` (opcional, uno por parada): pregunta para adivinar, como en un free tour: `before` (antes de qué párrafo,
  empezando en 0), `q` (la pregunta), `options` (tres respuestas) y `answer` (posición de la correcta, empezando en 0).
  El párrafo siguiente debería contar la respuesta.
- `images` (opcional, una o varias por parada): lista de imágenes, cada una con `src` (por ejemplo
  `img/paris/centro/louvre.webp`), `w` y `h` (tamaño en píxeles), `para` (antes de qué párrafo aparece, empezando en 0),
  `caption` (pie de foto), `credit` (autor · museo · licencia) y `source` (enlace a la ficha original).
  Salen en el texto; junto al título hay una miniatura que cambia a la imagen de la que se está hablando y se ilumina
  en ese momento; al tocarlas se ven a pantalla completa y se pasa de una a otra con las flechas o deslizando.
  Usa solo imágenes de dominio público o con licencia libre (Wikimedia Commons) y pon siempre el crédito.
  Formato WebP, unos 1.100 px por el lado largo y menos de 150 KB. Se guardan solas para usarlas sin conexión;
  si cambias una imagen, cámbiale también el nombre de archivo.
- `legs`: la línea del recorrido entre paradas, como listas de puntos `[lat, lng]`.
  El tramo 0 va de la parada 1 a la 2, y así sucesivamente.

Las coordenadas son aproximadas: conviene revisarlas sobre el terreno o en Google Maps
(clic derecho sobre el punto → copiar coordenadas).

Cada vez que publiques cambios de diseño o de código, sube la versión en dos sitios para que los móviles
descarguen la nueva: `const VERSION` en `sw.js` y el `?v=` de `css/app.css` y `js/app.js`
(en `index.html` y en la lista `FILES` de `sw.js`). Los cambios solo de texto en el JSON no lo necesitan.

## Voz grabada con IA (ElevenLabs)

Si una ruta tiene audios, la app los usa; si no, lee el texto con la voz del móvil.
Para generarlos (solo hace falta Python 3 y una cuenta de ElevenLabs):

```
set ELEVENLABS_API_KEY=sk_...
python tools\generar_audios.py data\paris\centro.json --voz VOICE_ID --parada hotel-de-ville   (una parada)
python tools\generar_audios.py data\paris\centro.json --voz VOICE_ID                          (la ruta entera)
```

- **Clave**: elevenlabs.io › perfil › API Keys › Create API key (permiso «Text to Speech»).
- **VOICE_ID**: en «Voices», menú «⋯» de la voz › «Copy voice ID» (la voz debe estar en «My Voices»).
- Crea `audio/<ciudad>/<ruta>/` con un MP3 por párrafo, la pregunta y las respuestas, y anota los archivos
  en el bloque `audio` del JSON de la ruta.
- Solo regenera lo que cambia (texto, voz o ajustes): editar un párrafo solo gasta ese párrafo.
- Opciones: `--modelo` (por defecto `eleven_v4`; también `eleven_v3` o `eleven_multilingual_v2`), `--estabilidad 0.45`,
  `--similitud 0.75`, `--velocidad 1.0`, `--forzar`.
- Consumo: la parada 1 son unos 2.500 caracteres y la ruta de París unos 20.000.
  El plan gratuito (10.000/mes) sirve para probar, pero no permite uso comercial; el Starter (30.000/mes) da para la ruta entera.
- La app indica en la portada de la ruta que la voz está generada con IA.
- **Sin conexión**: en la portada de la ruta (y en el menú ☰) está «Audios sin conexión · Descargar». Guarda todos los
  audios en el móvil; si alguno cambia (se ha regenerado), aparece «Actualizar» y solo baja los nuevos.
  Si no se han descargado y no hay conexión, esa parte la lee la voz del móvil y el recorrido sigue.
- El generador anota en el bloque `audio.files` la versión (`v`) y el tamaño (`b`) de cada archivo; la app los usa
  para descargar y para no reproducir copias antiguas.

## Probarla en el ordenador

Desde la carpeta del proyecto:

```
python -m http.server 8000
```

y abre http://localhost:8000. Usa «Probar desde casa».
El GPS real solo funciona con https (o en localhost).

## Publicarla gratis con GitHub Pages

1. En GitHub Desktop: **File › Add local repository** y elige esta carpeta
   (si te dice que no es un repositorio, pulsa «create a repository»).
2. Haz el primer commit y pulsa **Publish repository**. Desmarca «Keep this code private»
   (GitHub Pages gratuito necesita que el repositorio sea público).
3. En github.com, en el repositorio: **Settings › Pages › Build and deployment** →
   Source: *Deploy from a branch*, Branch: `main` y carpeta `/ (root)` → **Save**.
4. En un par de minutos estará en `https://TU-USUARIO.github.io/NOMBRE-DEL-REPO/`.
5. En el iPhone: abre ese enlace en Safari → Compartir → **Añadir a pantalla de inicio**.

## Mapa

El mapa es de OpenFreeMap (https://openfreemap.org), con datos de OpenStreetMap: gratuito, sin clave,
sin límite de visitas y apto para uso comercial. El estilo se cambia en `STYLE_URL` (`js/app.js`):
`positron` (claro, el actual), `bright` o `liberty`. Si algún día hace falta otro proveedor
(MapTiler, Stadia…), basta con cambiar esa URL y la regla correspondiente de `sw.js`.
