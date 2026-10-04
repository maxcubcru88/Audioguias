# Audioguía de París · El corazón de París

Web app gratuita (PWA) para recorrer a pie el centro de París con una audioguía estilo free tour.
9 paradas, del Hôtel de Ville al jardín de las Tullerías, unos 2,7 km.

## Qué hace

- Mapa con la ruta, las paradas numeradas como placas de calle y tu posición GPS.
- Te avisa (sonido y vibración en Android) al entrar en el radio de cada parada y empieza a leer el guion.
- Indica la distancia a la siguiente parada y cómo llegar.
- Voz del propio móvil, con selector de voz y velocidad.
- **Modo prueba**: te mueves tocando el mapa, para escuchar el tour desde casa.
- Funciona sin conexión: la app se guarda al abrirla y el mapa se descarga desde Ajustes.
- Recuerda qué paradas has visitado.

Limitación: en iPhone, una web app solo usa el GPS y la voz con la pantalla encendida y la app abierta.
Los avisos con la pantalla apagada llegarán con la versión nativa (fase 2), que reutilizará el mismo `data/paris-centro.json`.

## Estructura

```
index.html                 la app
css/app.css                estilos
js/app.js                  lógica (mapa, GPS, avisos, voz)
data/paris-centro.json     EL CONTENIDO: paradas, textos, coordenadas y ruta
sw.js                      service worker (uso sin conexión)
manifest.webmanifest       nombre e icono al instalarla
vendor/maplibre/           librería de mapas (MapLibre GL 4.7.1)
icons/                     iconos
```

## Editar el contenido

Todo está en `data/paris-centro.json`:

- `stops`: cada parada tiene `title`, `subtitle`, `lat`, `lng`, `radius` (metros para el aviso),
  `where` (dónde ponerse), `paras` (párrafos del guion) y `toNext` (cómo llegar a la siguiente).
- `legs`: la línea del recorrido entre paradas, como listas de puntos `[lat, lng]`.
  El tramo 0 va de la parada 1 a la 2, y así sucesivamente.

Las coordenadas son aproximadas: conviene revisarlas sobre el terreno o en Google Maps
(clic derecho sobre el punto → copiar coordenadas).

Cada vez que publiques cambios, sube la versión en `sw.js` (`const VERSION = 'v2'`) para que los móviles
descarguen la nueva versión.

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
