import { FilesetResolver, FaceLandmarker } from '@mediapipe/tasks-vision';

const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/wasm';
const FACE_MODEL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

/** Erstellt den Face Landmarker. Versucht GPU, fällt sonst auf CPU zurück. */
export async function createFaceTracker() {
  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: FACE_MODEL, delegate },
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
    if (eyes > 0) blend.mouthGap = d(lm[13], lm[14]) / eyes;
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
  return { blend, matrix };
}
