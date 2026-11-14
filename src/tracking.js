import { FilesetResolver, FaceLandmarker } from '@mediapipe/tasks-vision';

const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/wasm';
const FACE_MODEL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

/** Erstellt den Face Landmarker. Versucht GPU, fällt sonst auf CPU zurück. */
export async function createFaceTracker({ wasmBase = WASM_BASE, modelPath = FACE_MODEL } = {}) {
  const fileset = await FilesetResolver.forVisionTasks(wasmBase);
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: modelPath, delegate },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  });
  try {
    return { landmarker: await FaceLandmarker.createFromOptions(fileset, options('GPU')), delegate: 'GPU' };
  } catch (err) {
    console.warn('GPU nicht verfügbar, nutze CPU', err);
    return { landmarker: await FaceLandmarker.createFromOptions(fileset, options('CPU')), delegate: 'CPU' };
  }
}

/** Startet die Frontkamera. */
export async function startCamera(video) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
  });
  video.srcObject = stream;
  await video.play();
  return stream;
}

/**
 * Wandelt das MediaPipe-Ergebnis in ein einfaches Objekt:
 * { blend: {name: score}, matrix: number[16] (spaltenweise, three.js-Format) } oder null.
 */
export function parseFaceResult(res, width = 1, height = 1) {
  if (!res || !res.faceBlendshapes || res.faceBlendshapes.length === 0) return null;
  const blend = {};
  for (const c of res.faceBlendshapes[0].categories) blend[c.categoryName] = c.score;

  // Mundöffnung geometrisch messen: Abstand Innenlippe oben (13) / unten (14),
  // relativ zum Augenabstand (33 / 263). Unabhängig von der Kopfneigung,
  // anders als "jawOpen", das beim Hochschauen fälschlich ansteigt.
  const lm = res.faceLandmarks && res.faceLandmarks[0];
  if (lm && lm.length > 263) {
    const d = (a, b) => Math.hypot((a.x - b.x) * width, (a.y - b.y) * height, (a.z - b.z) * width);
    const eyes = d(lm[33], lm[263]);
    if (eyes > 0) {
      blend.mouthGap = d(lm[13], lm[14]) / eyes;

      // Augen einzeln: Lidabstand / Augenbreite ("Eye Aspect Ratio").
      // MediaPipes eyeBlink-Werte koppeln beide Augen, das hier nicht.
      // Als "Schließ-Wert" gespeichert: höher = geschlossener.
      const earLeft = d(lm[386], lm[374]) / Math.max(d(lm[362], lm[263]), 1e-6); // linkes Auge (des Nutzers)
      const earRight = d(lm[159], lm[145]) / Math.max(d(lm[33], lm[133]), 1e-6);
      blend.eyeCloseGeoLeft = 0.4 - earLeft;
      blend.eyeCloseGeoRight = 0.4 - earRight;

      // Mundwinkel runter: Mundwinkel (61, 291) relativ zur Mundmitte,
      // entlang der Gesichts-"Unten"-Richtung (senkrecht zur Augenlinie).
      const ex = (lm[263].x - lm[33].x) * width, ey = (lm[263].y - lm[33].y) * height;
      const len = Math.hypot(ex, ey) || 1;
      const down = { x: -ey / len, y: ex / len };
      const cx = (lm[13].x + lm[14].x) / 2 * width, cy = (lm[13].y + lm[14].y) / 2 * height;
      const drop = (p) => ((p.x * width - cx) * down.x + (p.y * height - cy) * down.y) / eyes;
      blend.mouthCornerDown = (drop(lm[61]) + drop(lm[291])) / 2;
    }
  }

  let matrix = null;
  const m = res.facialTransformationMatrixes && res.facialTransformationMatrixes[0];
  if (m && m.data && m.data.length === 16) {
    matrix = Array.from(m.data);
    // Absicherung gegen Zeilen- vs. Spalten-Layout: die Translation (z ca. -30..-80 cm)
    // muss in den Indizes 12..14 stehen. Steht sie in 3/7/11, transponieren.
    if (Math.abs(matrix[11]) > Math.abs(matrix[14]) && Math.abs(matrix[11]) > 1) {
      const t = new Array(16);
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) t[c * 4 + r] = matrix[r * 4 + c];
      matrix = t;
    }
  }
  return { blend, matrix, landmarks: lm || null };
}
