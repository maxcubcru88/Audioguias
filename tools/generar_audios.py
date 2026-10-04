#!/usr/bin/env python3
"""
Paseíto · generador de audios con ElevenLabs

Lee el guion de una ruta (por ejemplo data/paris/centro.json) y crea un MP3 por párrafo,
uno por pregunta y tres respuestas por parada («¡Correcto!», «¡Casi!…», «Te lo digo yo…»).
Después anota los archivos en el propio JSON (bloque "audio") para que la app los use.

Solo regenera lo que ha cambiado: si editas un párrafo, al volver a ejecutarlo
solo se gasta ese párrafo.

USO (desde la carpeta del proyecto, en la ventana negra de Windows):

    set ELEVENLABS_API_KEY=sk_...tu clave...
    python tools\\generar_audios.py data\\paris\\centro.json --voz VOICE_ID --parada hotel-de-ville

    (sin --parada genera la ruta entera)

Dónde encontrar cada cosa en elevenlabs.io:
    · La clave: tu perfil (abajo a la izquierda) › API Keys › Create API key.
      Permisos necesarios: «Text to Speech» (acceso) y, si te lo pide, «Voices» (lectura).
    · El VOICE_ID: abre la voz en «Voices», menú «⋯» › «Copy voice ID».
      La voz tiene que estar añadida a «My Voices».

Opciones:
    --voz ID              Voice ID de ElevenLabs (obligatorio)
    --parada ID           solo esa parada (para probar), por ejemplo hotel-de-ville
    --modelo ID           eleven_v4 (por defecto, el más nuevo y expresivo), eleven_v3 o eleven_multilingual_v2
    --estabilidad 0.45    0 = más expresiva, 1 = más monótona
    --similitud 0.75      parecido a la voz original
    --velocidad 1.0       entre 0.7 y 1.2
    --forzar              regenera aunque no haya cambios

No necesita instalar nada: solo Python 3.
"""
import argparse, hashlib, json, os, sys, time, urllib.request, urllib.error

API = "https://api.elevenlabs.io/v1/text-to-speech/{voz}?output_format=mp3_44100_128"


def tts(texto, a, clave, anterior=None, siguiente=None):
    cuerpo = {
        "text": texto,
        "model_id": a.modelo,
        "voice_settings": {
            "stability": a.estabilidad,
            "similarity_boost": a.similitud,
            "style": 0.0,
            "use_speaker_boost": True,
            "speed": a.velocidad,
        },
    }
    # Contexto del párrafo anterior y siguiente (solo lo admiten los modelos v2/flash):
    # la entonación enlaza mejor entre archivos
    if a.modelo.startswith(("eleven_multilingual", "eleven_flash", "eleven_turbo")):
        if anterior: cuerpo["previous_text"] = anterior[-500:]
        if siguiente: cuerpo["next_text"] = siguiente[:500]
    pet = urllib.request.Request(
        API.format(voz=a.voz), data=json.dumps(cuerpo).encode("utf-8"), method="POST",
        headers={"xi-api-key": clave, "Content-Type": "application/json", "Accept": "audio/mpeg"},
    )
    for intento in range(4):
        try:
            with urllib.request.urlopen(pet, timeout=180) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            detalle = e.read().decode("utf-8", "ignore")[:400]
            if e.code in (429, 500, 502, 503) and intento < 3:
                time.sleep(6 * (intento + 1)); continue
            if e.code == 401:
                sys.exit("\nLa clave no es válida o no tiene permiso de «Text to Speech». Revisa ELEVENLABS_API_KEY.\n" + detalle)
            if "quota" in detalle.lower() or "credits" in detalle.lower():
                sys.exit("\nSe han acabado los créditos del mes en ElevenLabs. Lo generado hasta aquí está guardado.\n" + detalle)
            sys.exit(f"\nError de ElevenLabs ({e.code}): {detalle}")
        except urllib.error.URLError as e:
            if intento < 3:
                time.sleep(5); continue
            sys.exit(f"\nSin conexión con ElevenLabs: {e}")


def huella(texto, a):
    clave = "|".join(map(str, [a.modelo, a.voz, a.estabilidad, a.similitud, a.velocidad, texto]))
    return hashlib.sha1(clave.encode("utf-8")).hexdigest()[:16]


def main():
    ap = argparse.ArgumentParser(description="Genera los audios de una ruta de Paseíto con ElevenLabs.")
    ap.add_argument("ruta", help="archivo de la ruta, por ejemplo data/paris/centro.json")
    ap.add_argument("--voz", required=True, help="Voice ID de ElevenLabs")
    ap.add_argument("--parada", help="solo esta parada (id), para probar")
    ap.add_argument("--modelo", default="eleven_v4")
    ap.add_argument("--estabilidad", type=float, default=0.45)
    ap.add_argument("--similitud", type=float, default=0.75)
    ap.add_argument("--velocidad", type=float, default=1.0)
    ap.add_argument("--forzar", action="store_true")
    a = ap.parse_args()

    clave = os.environ.get("ELEVENLABS_API_KEY", "").strip()
    if not clave:
        sys.exit("Falta la clave. En la ventana negra escribe primero:  set ELEVENLABS_API_KEY=sk_...")

    ruta_json = os.path.abspath(a.ruta)
    raiz = os.path.dirname(os.path.dirname(os.path.dirname(ruta_json)))  # carpeta del proyecto
    with open(ruta_json, encoding="utf-8") as f:
        tour = json.load(f)
    base_rel = f"audio/{tour.get('city', 'ciudad')}/{tour.get('id', 'ruta')}/"
    carpeta = os.path.join(raiz, *base_rel.strip("/").split("/"))
    os.makedirs(carpeta, exist_ok=True)

    manifiesto_path = os.path.join(carpeta, "manifest.json")
    manifiesto = {}
    if os.path.exists(manifiesto_path):
        with open(manifiesto_path, encoding="utf-8") as f:
            manifiesto = json.load(f)

    audio = tour.get("audio") or {}
    audio["base"] = base_rel
    audio["credit"] = "Voz generada con IA (ElevenLabs)"
    audio.setdefault("stops", {})

    paradas = [s for s in tour["stops"] if not a.parada or s["id"] == a.parada]
    if not paradas:
        sys.exit(f"No encuentro la parada «{a.parada}». Ids disponibles: " + ", ".join(s["id"] for s in tour["stops"]))

    total_chars = 0; generados = 0
    for st in paradas:
        sid = st["id"]
        partes = list(st["paras"])
        if st.get("toNext"):
            partes.append("Para ir a la siguiente parada: " + st["toNext"])
        textos = []  # (archivo, texto, anterior, siguiente)
        q = st.get("quiz")
        for i, p in enumerate(partes):
            if q and q["before"] == i:
                opciones = " ".join("¿" + o + "?" for o in q["options"])
                textos.append((f"{sid}-q.mp3", q["q"] + " " + opciones, partes[i - 1] if i else None, None))
            textos.append((f"{sid}-p{i}.mp3", p, partes[i - 1] if i else None, partes[i + 1] if i + 1 < len(partes) else None))
        if q:
            correcta = q["options"][q["answer"]]
            textos += [
                (f"{sid}-ok.mp3", "¡Correcto!", None, None),
                (f"{sid}-ko.mp3", "¡Casi! La respuesta es: " + correcta + ".", None, None),
                (f"{sid}-skip.mp3", "Te lo digo yo: la respuesta es: " + correcta + ".", None, None),
            ]

        print(f"\n· {st['title']}")
        for nombre, texto, ant, sig in textos:
            h = huella(texto, a)
            destino = os.path.join(carpeta, nombre)
            if not a.forzar and manifiesto.get(nombre) == h and os.path.exists(destino):
                print(f"   {nombre}: sin cambios")
                continue
            print(f"   {nombre}: generando ({len(texto)} caracteres)…", end="", flush=True)
            mp3 = tts(texto, a, clave, ant, sig)
            with open(destino, "wb") as f:
                f.write(mp3)
            manifiesto[nombre] = h
            total_chars += len(texto); generados += 1
            print(" ok")
            # guardar el manifiesto tras cada archivo, por si se corta a medias
            with open(manifiesto_path, "w", encoding="utf-8") as f:
                json.dump(manifiesto, f, ensure_ascii=False, indent=2)

        entrada = {"paras": [f"{sid}-p{i}.mp3" for i in range(len(partes))]}
        if q:
            entrada.update({"quiz": f"{sid}-q.mp3", "ok": f"{sid}-ok.mp3", "ko": f"{sid}-ko.mp3", "skip": f"{sid}-skip.mp3"})
        audio["stops"][sid] = entrada
        tour["audio"] = audio
        with open(ruta_json, "w", encoding="utf-8") as f:
            json.dump(tour, f, ensure_ascii=False, indent=2)

    print(f"\nListo: {generados} audios nuevos, {total_chars} caracteres gastados de tu cuota de ElevenLabs.")
    print(f"Archivos en {base_rel}  ·  Haz Commit + Push en GitHub Desktop para publicarlos.")


if __name__ == "__main__":
    main()
