import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

const BG_DARK = 0x1a1d24;
const BG_GREEN = 0x00ff00;

export class AvatarStage {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(BG_DARK);

    this.camera = new THREE.PerspectiveCamera(28, 1, 0.1, 20);
    this.camera.position.set(0, 1.35, 1.4);

    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(0.6, 1.8, 1.5);
    this.scene.add(key, new THREE.AmbientLight(0xffffff, 0.9));

    this.vrm = null;
    this.timer = new THREE.Timer();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  setGreenscreen(on) {
    this.scene.background = new THREE.Color(on ? BG_GREEN : BG_DARK);
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Hochformat: etwas weiter weg, damit Schultern + Hände ins Bild passen
    this.camera.fov = w < h ? 34 : 24;
    this.camera.updateProjectionMatrix();
  }

  async load(url) {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync(url);
    const vrm = gltf.userData.vrm;
    if (!vrm) throw new Error('Datei enthält kein VRM');

    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    if (VRMUtils.combineSkeletons) VRMUtils.combineSkeletons(gltf.scene);
    VRMUtils.rotateVRM0(vrm); // VRM 0.x schaut sonst nach hinten
    vrm.scene.traverse((o) => { o.frustumCulled = false; });

    if (this.vrm) {
      this.scene.remove(this.vrm.scene);
      VRMUtils.deepDispose(this.vrm.scene);
    }
    this.vrm = vrm;
    this.scene.add(vrm.scene);
    vrm.scene.visible = this.avatarMode !== 'mesh';

    if (vrm.lookAt) { vrm.lookAt.autoUpdate = false; vrm.lookAt.target = null; }

    this.restPose();
    this.frame();
    this.expressionNames = new Set(
      (vrm.expressionManager?.expressions || []).map((e) => e.expressionName),
    );
    this.indexMorphs(vrm);
    return vrm;
  }

  /** Alle Morph-Targets (Blendshapes) der Meshes nach Kurznamen erfassen. */
  indexMorphs(vrm) {
    this.morphs = new Map();
    this.direct = {};
    vrm.scene.traverse((o) => {
      if (!o.morphTargetDictionary) return;
      for (const [full, index] of Object.entries(o.morphTargetDictionary)) {
        const short = full.slice(full.lastIndexOf('.') + 1); // "Face.M_F00_000_00_Fcl_BRW_Angry" -> nach dem Punkt
        const key = short.includes('Fcl_') ? short.slice(short.indexOf('Fcl_')) : short;
        if (!this.morphs.has(key)) this.morphs.set(key, []);
        this.morphs.get(key).push({ mesh: o, index });
      }
    });
    this.isVroid = this.morphs.has('Fcl_BRW_Angry') && this.morphs.has('Fcl_MTH_A');
  }

  /** Morph direkt setzen (wird nach vrm.update() angewendet). */
  setMorph(name, value) {
    if (this.morphs?.has(name)) this.direct[name] = value;
  }

  applyDirect() {
    for (const [name, v] of Object.entries(this.direct)) {
      for (const { mesh, index } of this.morphs.get(name)) mesh.morphTargetInfluences[index] = v;
    }
  }

  /** Arme aus der T-Pose nach unten, leicht nach vorne. */
  restPose() {
    const h = this.vrm.humanoid;
    const set = (bone, x, y, z) => {
      const n = h.getNormalizedBoneNode(bone);
      if (n) n.rotation.set(x, y, z);
    };
    set('leftUpperArm', 0, 0, -1.2);
    set('rightUpperArm', 0, 0, 1.2);
    set('leftLowerArm', 0, -0.35, 0);
    set('rightLowerArm', 0, 0.35, 0);
  }

  /** Zwischen VRM-Modell und Mesh-Gesicht umschalten. */
  setAvatarMode(mode) {
    this.avatarMode = mode;
    if (this.vrm) this.vrm.scene.visible = mode !== 'mesh';
    if (this.faceMesh) this.faceMesh.group.visible = mode === 'mesh';
    this.frame();
  }

  frame() {
    if (this.avatarMode === 'mesh') {
      this.camera.position.set(0, 0, 0.42);
      this.camera.lookAt(0, 0, 0);
    } else if (this.vrm) {
      this.frameBust();
    }
  }

  /** Kamera auf Kopf/Oberkörper ausrichten (Sitz-Stream-Ausschnitt). */
  frameBust() {
    this.vrm.scene.updateMatrixWorld(true);
    const head = this.vrm.humanoid.getNormalizedBoneNode('head');
    const p = new THREE.Vector3();
    head.getWorldPosition(p);
    this.lookTarget = new THREE.Vector3(0, p.y - 0.12, 0);
    this.camera.position.set(0, p.y - 0.05, 1.45);
    this.camera.lookAt(this.lookTarget);
  }

  bone(name) { return this.vrm?.humanoid.getNormalizedBoneNode(name); }

  /**
   * Kopfrotation (Euler in Radiant, Avatar-Sicht) auf Wirbelsäule/Hals/Kopf verteilen,
   * damit die Bewegung natürlich wirkt statt nur "Kopf auf Stab".
   */
  applyHead(pitch, yaw, roll) {
    const parts = [['spine', 0.1], ['chest', 0.15], ['neck', 0.3], ['head', 0.45]];
    for (const [name, f] of parts) {
      const b = this.bone(name);
      if (b) b.rotation.set(pitch * f, yaw * f, roll * f, 'YXZ');
    }
  }

  /** Atmen im Leerlauf, damit der Avatar nie "eingefroren" wirkt. */
  idle(t) {
    const up = this.bone('upperChest') || this.bone('chest');
    if (up) up.rotation.x = Math.sin(t * 1.6) * 0.015;
  }

  setExpression(name, value) {
    if (this.expressionNames?.has(name)) this.vrm.expressionManager.setValue(name, value);
  }

  setGaze(yawDeg, pitchDeg) {
    if (this.vrm?.lookAt) { this.vrm.lookAt.yaw = yawDeg; this.vrm.lookAt.pitch = pitchDeg; }
  }

  render() {
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.1);
    if (this.vrm && this.vrm.scene.visible) {
      this.idle(this.timer.getElapsed());
      this.vrm.update(dt);
      this.applyDirect(); // nach update, sonst überschreibt der ExpressionManager
    }
    this.renderer.render(this.scene, this.camera);
  }
}
