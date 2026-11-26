// Renders .glb props on the stage with a local three.js build (no CDN), so the
// board keeps working offline like the rest of the PWA.
import * as THREE from "three";
import { GLTFLoader } from "/vendor/three/loaders/GLTFLoader.js";

const loader = new GLTFLoader();

/** Live viewers, so a re-render reuses the WebGL context instead of leaking one. */
const viewers = new WeakMap();

function fitToView(camera, object) {
  const box = new THREE.Box3().setFromObject(object);
  const size = new THREE.Vector3();
  const centre = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(centre);
  const tallest = Math.max(size.y, size.x, size.z) || 1;
  const scale = 1.85 / tallest;
  object.scale.setScalar(scale);
  // Stand the model on y = 0 so it sits on the stage floor, centred left/right.
  object.position.set(-centre.x * scale, -box.min.y * scale, -centre.z * scale);
  camera.position.set(0, 1.15, 3.1);
  camera.lookAt(0, 0.95, 0);
}

/**
 * Mounts one .glb into `host` and returns a live viewer record.
 * Throws nothing: failures are reported through `host.dataset.state`.
 */
export function mountModel(host, url) {
  const existing = viewers.get(host);
  if (existing) return existing;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.domElement.style.display = "block";
  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";
  host.append(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
  scene.add(new THREE.HemisphereLight(0xc9dcff, 0x1b1030, 2.4));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(2.5, 3.5, 3);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x7ac8ff, 1.8);
  rim.position.set(-3, 2, -2.5);
  scene.add(rim);
  const pivot = new THREE.Group();
  scene.add(pivot);

  host.dataset.state = "loading";
  const viewer = { alive: true, host };

  loader.load(
    url,
    (gltf) => {
      pivot.add(gltf.scene);
      fitToView(camera, gltf.scene);
      host.dataset.state = "ready";
    },
    undefined,
    () => {
      host.dataset.state = "error";
    },
  );

  const resize = () => {
    const width = host.clientWidth || 1;
    const height = host.clientHeight || 1;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();

  const clock = new THREE.Clock();
  const tick = () => {
    if (!viewer.alive) return;
    requestAnimationFrame(tick);
    const delta = clock.getDelta();
    if (document.hidden || host.dataset.state !== "ready") return;
    pivot.rotation.y += delta * 0.4;
    renderer.render(scene, camera);
  };
  tick();

  viewer.dispose = () => {
    viewer.alive = false;
    observer.disconnect();
    renderer.dispose();
    viewers.delete(host);
  };
  viewers.set(host, viewer);
  return viewer;
}

/** Stops the render loop and frees the GPU buffers for a removed prop. */
export function unmountModel(host) {
  const viewer = viewers.get(host);
  if (!viewer) return;
  viewer.dispose?.();
  host.replaceChildren();
}
