# Avatar Tracker v0.1

Gesicht per Handykamera → 3D-Avatar (VRM). Läuft komplett im Browser, keine Daten verlassen das Gerät.

## Was v0.1 kann
- Kopfdrehung (verteilt auf Rücken, Hals und Kopf)
- Blinzeln links/rechts, Mund (a/i/u/e/o), Lächeln, Brauen → Emotionen
- Augenbewegung
- "Perfect Sync": Hat ein Modell die 52 ARKit-Ausdrücke, werden alle 1:1 übertragen
- One-Euro-Glättung mit Reglern (Glättung / Reaktion)
- Spiegeln, Kamera-Vorschau, Greenscreen, eigenes .vrm laden
- Anzeige: Render-FPS, Tracking-FPS, Erkennungszeit, GPU/CPU

## Auf GitHub Pages stellen
1. github.com → **New repository** → Name z. B. `avatar-tracker`, **Public**
2. **Add file → Upload files** → `index.html`, `style.css`, `README.md` und den Ordner `src` hochladen → Commit
3. **Settings → Pages** → Source: *Deploy from a branch* → Branch `main`, Ordner `/ (root)` → Save
4. Nach ca. 1 Minute: `https://DEIN-NAME.github.io/avatar-tracker/` im Chrome auf dem Handy öffnen

## Testmodell
Standard ist das offizielle pixiv-Beispiel `VRM1_Constraint_Twist_Sample` (Weitergabe und Änderung erlaubt).
Ein anderes Modell: über ⚙ → "Eigenes VRM laden" oder per URL `?vrm=https://…/modell.vrm`.

## Technik
three.js 0.187 · @pixiv/three-vrm 3.5.5 · @mediapipe/tasks-vision 1.2.3 (alles per CDN, kein Build-Schritt)
