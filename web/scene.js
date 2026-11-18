import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const SPACING = 26;        // metres between two clearings
const CLEARING_X = 9;      // distance between the middle of the forest and the centre of a clearing
const CLEARING_RADIUS = 9; // no tree inside this circle
const SHEET_X = 13;        // the stage stands at the back of its clearing
const SHEET_WIDTH = 9.6;   // a big 16:9 sheet...
const SHEET_HEIGHT = 5.4;
const SHEET_BOTTOM = 1.2;  // ...hanging just above the subwoofers
const BPM = 160;           // fixed tempo of the dancers (we cannot analyse YouTube's sound)
const DANCERS_PER_SCENE = 28;
const EYE = 1.7;           // height of the camera = our eyes
const SPEED = 3;           // walking speed, metres per second
const TURN_START = 8;      // the head starts turning towards a clearing this many metres before it
const START_Z = 12;        // where we enter the forest, a few steps before the first clearing

const status = document.getElementById("status");
const startButton = document.getElementById("start");
const hud = document.getElementById("hud");
const now = document.getElementById("now");

// ---------- 1. Data from our server ----------

async function loadTracks() {
  let data;
  try {
    // Relative address (no "/" at the start): works at localhost:8080/ AND at .../music-viz/
    data = await (await fetch("api/tracks")).json();
  } catch {
    throw new Error("Le serveur ne répond pas. Lance « docker compose up ».");
  }
  if (data.error) throw new Error(data.error); // message written by the Flask API
  if (data.tracks.length === 0) throw new Error("Aucun morceau avec pochette et musique pour l'instant.");
  return data;
}

// Mix the list (Fisher-Yates): from the end, swap each track with a random one before it.
// Every order has the same chance, so each reload gives a different walk.
function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

// The cover goes through our nginx (covers/...) instead of i.ytimg.com (relative address too)
function coverUrl(track) {
  return track.thumbnail.replace("https://i.ytimg.com/vi/", "covers/");
}

// ---------- 2. The 3D scene ----------

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;                // objects cast shadows...
renderer.shadowMap.type = THREE.PCFSoftShadowMap; // ...with soft edges
document.body.prepend(renderer.domElement);

const NIGHT = "#0b1119";
const scene = new THREE.Scene();
scene.background = new THREE.Color(NIGHT);
// Fog of the same colour as the sky: far objects slowly melt into the night
scene.fog = new THREE.FogExp2(NIGHT, 0.035);

const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 500);
camera.position.set(0, EYE, START_Z);
camera.rotation.order = "YXZ"; // turn the head left/right first, then up/down

// ---- Lights ----
// Soft light coming from everywhere: bluish from the sky, almost black from the ground
// (it ignores shadows: it keeps the ground visible under the treetops)
scene.add(new THREE.HemisphereLight("#4a6488", "#2a2a1c", 3.5));

// Moonlight: one strong bluish light from one direction. It is the one that casts the shadows.
const moonLight = new THREE.DirectionalLight("#a9bcff", 3);
moonLight.castShadow = true;
moonLight.shadow.mapSize.set(2048, 2048); // shadow sharpness
moonLight.shadow.bias = -0.001;           // avoids stripes on surfaces that shadow themselves
moonLight.shadow.normalBias = 0.05;
Object.assign(moonLight.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 1, far: 200 });
scene.add(moonLight, moonLight.target);

// The moon itself, far away in the sky (fog: false, otherwise the fog would hide it)
const moon = new THREE.Mesh(
  new THREE.SphereGeometry(8, 32, 16),
  new THREE.MeshBasicMaterial({ color: "#dfe6ff", fog: false }),
);
scene.add(moon);

const MOON_DIRECTION = new THREE.Vector3(-0.5, 0.6, -1).normalize(); // up, ahead, a bit to the left

// The moon and its light walk with us: shadows are only computed in a 80 m square around us
function followCamera() {
  moonLight.target.position.set(0, 0, camera.position.z - 20);
  moonLight.position.copy(moonLight.target.position).addScaledVector(MOON_DIRECTION, 100);
  moon.position.copy(camera.position).addScaledVector(MOON_DIRECTION, 400);
}

addEventListener("resize", () => { // responsive: the scene always fills the window
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// -1 = sheet on the left of the path, 1 = on the right
function sideOf(index) {
  return index % 2 === 0 ? -1 : 1;
}

// Centre of the clearing of track number `index`
function clearingOf(index) {
  return { x: sideOf(index) * CLEARING_X, z: -index * SPACING };
}

// ---- The walk: ONE winding curve through the whole forest, no path ----
// Even when we skip several tracks, we stay on this curve: no tree grows on it.

// Where we stand to look at clearing number `index`: at its edge
function stopOf(index) {
  return new THREE.Vector3(0, 0, -index * SPACING);
}

let path;               // the curve of the whole walk
let stopDistances = []; // metres from the start of the walk to each clearing

// The walk goes: start, 1 point, clearing 0, 3 points pushed left/right/left (a slalom),
// clearing 1, 3 points, clearing 2...
// Catmull-Rom = a curve that goes exactly through each point with round turns;
// "centripetal" keeps it from making loops.
function buildPath(count) {
  const points = [new THREE.Vector3(0, 0, START_Z)];
  const stopIndices = []; // where each clearing is in the list of points
  for (let i = 0; i < count; i++) {
    const fromZ = points[points.length - 1].z;
    const toZ = stopOf(i).z;
    const steps = i === 0 ? 1 : 3;
    let side = Math.random() < 0.5 ? -1 : 1;
    for (let s = 1; s <= steps; s++) {
      const z = fromZ + (toZ - fromZ) * s / (steps + 1);
      points.push(new THREE.Vector3(side * (1.5 + Math.random() * 2.5), 0, z));
      side = -side;
    }
    stopIndices.push(points.length);
    points.push(stopOf(i));
  }
  path = new THREE.CatmullRomCurve3(points, false, "centripetal");

  // Three.js measures the curve in small pieces. With 20 pieces between two points,
  // point number k is at piece number k * 20: that gives the distance to each clearing.
  path.arcLengthDivisions = (points.length - 1) * 20;
  const lengths = path.getLengths(); // lengths[n] = metres from the start to piece n
  stopDistances = stopIndices.map(k => lengths[k * 20]);
}

// A tree may grow here if its trunk is 1.3 m away from where we walk and outside every clearing.
// The trees are tall: their branches start above our head, so we can pass close to the trunks.
function isFree(x, z, clearings, routePoints) {
  for (const p of routePoints) {
    if (Math.abs(p.z - z) < 1.3 && Math.hypot(p.x - x, p.z - z) < 1.3) return false;
  }
  return clearings.every(c => Math.hypot(x - c.x, z - c.z) > CLEARING_RADIUS);
}

// A fir tree = 3 cones stacked, wider at the bottom, merged into ONE shape.
// Both shapes start at the ground (y = 0), so a tree and its trunk share the same position.
// The lowest branches start 4 m high: above our head even for the smallest trees.
function firGeometry() {
  const tiers = [ // [radius, height, height of its centre]
    [2.0, 3.5, 5.7],
    [1.5, 3.0, 7.5],
    [0.9, 2.4, 9.2],
  ];
  return mergeGeometries(tiers.map(([radius, height, y]) =>
    new THREE.ConeGeometry(radius, height, 8).translate(0, y, 0)));
}

const treeSpots = []; // where every tree stands, to draw the map

// Thousands of trees drawn in one go: an InstancedMesh is ONE shape repeated many times,
// each copy with its own position, rotation, size and colour.
function addForest(startZ, endZ, clearings, routePoints) {
  const max = Math.round((startZ - endZ) * 9);
  const trunks = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.15, 0.3, 7, 6).translate(0, 3.5, 0), // top radius, bottom radius, height, sides
    new THREE.MeshLambertMaterial({ color: "#3b2a1d" }),
    max,
  );
  // Lambert = a material that reacts to light. flatShading: each face gets one shade (low-poly look)
  const leaves = new THREE.InstancedMesh(firGeometry(), new THREE.MeshLambertMaterial({ flatShading: true }), max);
  for (const mesh of [trunks, leaves]) {
    mesh.castShadow = true;    // the trees throw shadows on the ground...
    mesh.receiveShadow = true; // ...and on each other
  }

  const tree = new THREE.Object3D(); // invisible helper: we place it, then copy where it is
  const colour = new THREE.Color();
  let count = 0;

  function plant(x, z) {
    if (count === max || !isFree(x, z, clearings, routePoints)) return;
    const size = 0.8 + Math.random() * 0.6;
    treeSpots.push({ x, z, size }); // remembered for the map and the roots
    tree.position.set(x, 0, z);
    tree.rotation.set(
      (Math.random() - 0.5) * 0.08, // leans a little...
      Math.random() * Math.PI * 2,  // ...turned any way, so no two trees look the same
      (Math.random() - 0.5) * 0.08,
    );
    const width = size * (0.85 + Math.random() * 0.3); // some firs are thinner, some fatter
    tree.scale.set(width, size, width);
    tree.updateMatrix();
    trunks.setMatrixAt(count, tree.matrix);
    leaves.setMatrixAt(count, tree.matrix);
    leaves.setColorAt(count, colour.setHSL(0.28 + Math.random() * 0.08, 0.35, 0.1 + Math.random() * 0.08));
    count++;
  }

  // 1. Trees all along the walk, every ~3 m, one on each side, 1.5 to 4 m away:
  //    the trunks we slalom between
  routePoints.forEach((p, k) => {
    if (k % 6 !== 0) return; // the route points are 50 cm apart: 1 in 6 = every 3 m
    plant(p.x - 1.5 - Math.random() * 2.5, p.z + (Math.random() - 0.5) * 2);
    plant(p.x + 1.5 + Math.random() * 2.5, p.z + (Math.random() - 0.5) * 2);
  });
  // 2. The rest of the forest, at random, denser in the middle
  for (let i = 0; i < max; i++) {
    const side = Math.random() < 0.5 ? -1 : 1;
    plant(side * Math.random() ** 2 * 45, endZ + Math.random() * (startZ - endZ));
  }

  trunks.count = leaves.count = count; // only draw the trees really planted
  scene.add(trunks, leaves);
}

// The ground: a big plane cut into small squares. Each corner gets a colour between moss
// and earth, and sinks a little at random: a ground that is no longer perfectly flat.
// The texture of the ground, drawn once on a 256 x 256 canvas and repeated every 4 m:
// thousands of specks of earth, moss and light, and little strokes for fir needles and twigs
function groundTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const context = canvas.getContext("2d");
  context.fillStyle = "#c8c8c0"; // light: the texture is MULTIPLIED by the colours of the ground
  context.fillRect(0, 0, 256, 256);
  const specks = ["#5b4630", "#3a3528", "#7a9a5a", "#4d6a3a", "#eeeedd"];
  for (let i = 0; i < 4000; i++) {
    context.fillStyle = specks[Math.floor(Math.random() * specks.length)];
    const size = 1 + Math.random() * 3;
    context.fillRect(Math.random() * 256, Math.random() * 256, size, size);
  }
  context.lineWidth = 1;
  for (let i = 0; i < 500; i++) { // needles and twigs
    const x = Math.random() * 256;
    const y = Math.random() * 256;
    const angle = Math.random() * Math.PI;
    const length = 4 + Math.random() * 10;
    context.strokeStyle = Math.random() < 0.7 ? "#6b4e2e" : "#2e2418";
    context.beginPath();
    context.moveTo(x, y);
    context.lineTo(x + Math.cos(angle) * length, y + Math.sin(angle) * length);
    context.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping; // repeat it like tiles
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy(); // stays sharp when seen from the side
  return texture;
}

function groundGeometry(width, length) {
  const geometry = new THREE.PlaneGeometry(width, length, 50, Math.round(length / 4));
  const position = geometry.attributes.position;
  const moss = new THREE.Color("#2e3d20");
  const earth = new THREE.Color("#45331f");
  const colours = [];
  for (let i = 0; i < position.count; i++) {
    position.setZ(i, -Math.random() * 0.25); // only down: it never covers the clearings
    const c = moss.clone().lerp(earth, Math.random());
    colours.push(c.r, c.g, c.b);
  }
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colours, 3));
  geometry.computeVertexNormals(); // recompute which way each bit of ground faces, for the light
  return geometry;
}

// ---- Ground details: grass, roots and stones. Three InstancedMesh, like the trees ----

// A tuft of grass = 7 thin 3-sided spikes, leaning a little in all directions
function tuftGeometry() {
  const blades = [];
  for (let i = 0; i < 7; i++) {
    const height = 0.15 + Math.random() * 0.25;
    blades.push(new THREE.ConeGeometry(0.03, height, 3, 1, true)
      .translate(0, height / 2, 0)                  // base on the ground
      .rotateZ((Math.random() - 0.5) * 0.8)         // lean
      .rotateX((Math.random() - 0.5) * 0.8)
      .translate((Math.random() - 0.5) * 0.15, 0, (Math.random() - 0.5) * 0.15));
  }
  return mergeGeometries(blades);
}

// A root = a cone lying down, thick at the trunk, thin at the end, going slightly into the ground
function rootGeometry() {
  return new THREE.CylinderGeometry(0.02, 0.14, 1.4, 5, 1, true) // thin end, thick end, length
    .translate(0, 0.7, 0)              // the thick end at the origin (the trunk)
    .rotateZ(-Math.PI / 2 - 0.12);     // lie it down, pointing a bit into the ground
}

function addGroundDetails(clearings, routePoints) {
  const helper = new THREE.Object3D();
  const colour = new THREE.Color();

  // 1. Grass: denser where we walk and in the clearings, where we look
  const grassSpots = [];
  routePoints.forEach((p, k) => {
    if (k % 3 !== 0) return; // every 1.5 m
    for (let n = 0; n < 10; n++) grassSpots.push([p.x + (Math.random() - 0.5) * 14, p.z + (Math.random() - 0.5) * 3]);
  });
  for (const c of clearings) {
    for (let n = 0; n < 150; n++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.sqrt(Math.random()) * CLEARING_RADIUS; // sqrt: spread evenly in the circle
      grassSpots.push([c.x + Math.cos(angle) * radius, c.z + Math.sin(angle) * radius]);
    }
  }
  const grass = new THREE.InstancedMesh(tuftGeometry(), new THREE.MeshLambertMaterial({ flatShading: true }), grassSpots.length);
  grassSpots.forEach(([x, z], k) => {
    helper.position.set(x, -0.05, z);
    helper.rotation.set(0, Math.random() * Math.PI * 2, 0);
    helper.scale.setScalar(0.7 + Math.random() * 0.8);
    helper.updateMatrix();
    grass.setMatrixAt(k, helper.matrix);
    grass.setColorAt(k, colour.setHSL(0.22 + Math.random() * 0.1, 0.55, 0.06 + Math.random() * 0.08));
  });
  grass.receiveShadow = true;
  scene.add(grass);

  // 2. Roots: 3 to 5 around the trees close to us (far ones are hidden by the fog anyway)
  const rootSpots = [];
  for (const t of treeSpots) {
    if (Math.abs(t.x) > 14) continue;
    const count = 3 + Math.floor(Math.random() * 3);
    for (let n = 0; n < count; n++) {
      rootSpots.push({ x: t.x, z: t.z, size: t.size, angle: (n / count) * Math.PI * 2 + Math.random() * 0.6 });
    }
  }
  const roots = new THREE.InstancedMesh(rootGeometry(), new THREE.MeshLambertMaterial({ color: "#3b2a1d", flatShading: true }), rootSpots.length);
  rootSpots.forEach((r, k) => {
    helper.position.set(r.x, 0.1, r.z);
    helper.rotation.set(0, r.angle, 0); // all around the trunk
    helper.scale.setScalar(r.size * (0.7 + Math.random() * 0.6));
    helper.updateMatrix();
    roots.setMatrixAt(k, helper.matrix);
  });
  roots.castShadow = true;
  roots.receiveShadow = true;
  scene.add(roots);

  // 3. Stones: a 12-faced ball, squashed, half in the ground
  const stoneSpots = routePoints.filter((_, k) => k % 8 === 0); // about one every 4 m
  const stones = new THREE.InstancedMesh(
    new THREE.DodecahedronGeometry(0.3),
    new THREE.MeshLambertMaterial({ flatShading: true }),
    stoneSpots.length,
  );
  stoneSpots.forEach((p, k) => {
    const side = Math.random() < 0.5 ? -1 : 1;
    helper.position.set(p.x + side * (1 + Math.random() * 6), 0, p.z + (Math.random() - 0.5) * 3);
    helper.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    const size = 0.4 + Math.random() * 1.2;
    helper.scale.set(size, size * 0.5, size * (0.7 + Math.random() * 0.5)); // flatter than wide
    helper.updateMatrix();
    stones.setMatrixAt(k, helper.matrix);
    stones.setColorAt(k, colour.setHSL(0.15 + Math.random() * 0.15, 0.1, 0.18 + Math.random() * 0.12));
  });
  stones.castShadow = true;
  stones.receiveShadow = true;
  scene.add(stones);
}

// Fireflies: 600 points of light floating in the fog
let fireflies;

function addFireflies(startZ, endZ) {
  const positions = [];
  for (let i = 0; i < 600; i++) {
    positions.push((Math.random() - 0.5) * 40, 0.5 + Math.random() * 3, endZ + Math.random() * (startZ - endZ));
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  // A point is drawn as a square: we give it a picture of a soft round glow instead,
  // drawn on an invisible 32 x 32 canvas
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 32;
  const context = canvas.getContext("2d");
  const glow = context.createRadialGradient(16, 16, 0, 16, 16, 16);
  glow.addColorStop(0, "white");
  glow.addColorStop(1, "transparent");
  context.fillStyle = glow;
  context.fillRect(0, 0, 32, 32);

  fireflies = new THREE.Points(geometry, new THREE.PointsMaterial({
    color: "#d9ff8a",
    map: new THREE.CanvasTexture(canvas),
    size: 0.2,
    transparent: true,
    blending: THREE.AdditiveBlending, // light adds up: they glow
    depthWrite: false,
  }));
  scene.add(fireflies);
}

function buildScene(tracks) {
  const length = tracks.length * SPACING + 2 * SPACING;
  const clearings = tracks.map((_, i) => clearingOf(i));

  // Draw the walk now, so that no tree grows on it: a point every 50 cm
  buildPath(tracks.length);
  const routePoints = path.getSpacedPoints(Math.ceil(path.getLength() / 0.5));

  addForest(START_Z + 20, -length, clearings, routePoints);
  addFireflies(START_Z + 20, -length);
  addGroundDetails(clearings, routePoints);

  // The same picture, repeated: one tile = 4 m x 4 m
  const soil = groundTexture();
  soil.repeat.set(200 / 4, (length + 100) / 4);
  const clearingTexture = soil.clone(); // same picture, other number of tiles
  clearingTexture.repeat.set(2 * CLEARING_RADIUS / 4, 2 * CLEARING_RADIUS / 4);
  clearingTexture.needsUpdate = true;

  // A patch of lighter grass shows each clearing
  for (const c of clearings) {
    const patch = new THREE.Mesh(
      new THREE.CircleGeometry(CLEARING_RADIUS, 32),
      new THREE.MeshLambertMaterial({ color: "#3a4a2a", map: clearingTexture }),
    );
    patch.rotation.x = -Math.PI / 2;
    patch.position.set(c.x, 0.005, c.z);
    patch.receiveShadow = true;
    scene.add(patch);
  }

  const ground = new THREE.Mesh(
    groundGeometry(200, length + 100),
    new THREE.MeshLambertMaterial({ vertexColors: true, map: soil }), // colour of each corner x texture
  );
  ground.rotation.x = -Math.PI / 2; // a plane is vertical by default: lay it down
  ground.position.z = -length / 2 + START_Z;
  ground.receiveShadow = true;
  scene.add(ground);

  const loader = new THREE.TextureLoader();
  tracks.forEach((track, i) => {
    const sheet = new THREE.Mesh(
      new THREE.PlaneGeometry(SHEET_WIDTH, SHEET_HEIGHT),
      new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
    );
    loader.load(coverUrl(track), texture => {
      texture.colorSpace = THREE.SRGBColorSpace;
      // "high" thumbnails are 4:3: a 16:9 picture with black bars above and below.
      // We only show the middle 75 % of their height, the real picture.
      if (texture.image.width / texture.image.height < 1.5) {
        texture.repeat.set(1, 0.75);
        texture.offset.set(0, 0.125);
      }
      sheet.material.map = texture;
      sheet.material.needsUpdate = true;
    });
    sheet.position.set(sideOf(i) * SHEET_X, SHEET_BOTTOM + SHEET_HEIGHT / 2, clearings[i].z);
    sheet.rotation.y = -sideOf(i) * Math.PI / 2; // turn the sheet to face the middle of the forest
    sheet.castShadow = true;
    scene.add(sheet);
  });

  addSoundSystems(clearings);
  addDancers(clearings);
  addSkyBeams(clearings);
}

// ---- The stages: walls of speakers on the ground, the sheet in the middle ----

// The front of a speaker, drawn once on an invisible canvas: a big woofer and a small one above
function speakerTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const context = canvas.getContext("2d");
  context.fillStyle = "#1c1c1c";
  context.fillRect(0, 0, 128, 128);
  context.strokeStyle = "#555";
  context.lineWidth = 4;
  context.strokeRect(4, 4, 120, 120);
  for (const [y, radius] of [[80, 38], [24, 14]]) {
    context.beginPath();
    context.arc(64, y, radius, 0, Math.PI * 2); // the cone
    context.fillStyle = "#050505";
    context.fill();
    context.strokeStyle = "#777";
    context.lineWidth = 3;
    context.stroke();
    context.beginPath();
    context.arc(64, y, radius / 3, 0, Math.PI * 2); // the dust cap in the middle
    context.fillStyle = "#333";
    context.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function addSoundSystems(clearings) {
  // A speaker = a box. Its 6 faces get 6 materials, in this order: right, left, top, bottom, FRONT, back
  const black = new THREE.MeshLambertMaterial({ color: "#151515" });
  const front = new THREE.MeshLambertMaterial({ map: speakerTexture() });
  const perStage = 2 * 2 * 4 + 8; // 2 walls of 2 x 4 speakers + 8 subwoofers
  const speakers = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 0.8), // 1 m wide, 1 m tall, 80 cm deep
    [black, black, black, black, front, black],
    clearings.length * perStage,
  );
  speakers.castShadow = true;
  speakers.receiveShadow = true;

  const box = new THREE.Object3D();
  let n = 0;
  clearings.forEach((c, i) => {
    const side = sideOf(i);
    // along = left/right position seen from the crowd, y = height of the centre, height = box height
    function place(along, y, height) {
      box.position.set(side * (SHEET_X - 0.8), y, c.z + along); // 80 cm in front of the sheet
      box.rotation.set(0, -side * Math.PI / 2, 0);                // facing the crowd, like the sheet
      box.scale.set(1, height, 1);
      box.updateMatrix();
      speakers.setMatrixAt(n++, box.matrix);
    }
    // Two walls, left and right of the sheet: 2 columns x 4 rows
    for (const direction of [-1, 1]) {
      for (let column = 0; column < 2; column++) {
        for (let row = 0; row < 4; row++) {
          place(direction * (SHEET_WIDTH / 2 + 0.6 + column * 1.05), 0.5 + row * 1.02, 1);
        }
      }
    }
    // A row of 8 subwoofers (taller boxes) on the ground, under the sheet
    for (let k = 0; k < 8; k++) place(-3.675 + k * 1.05, SHEET_BOTTOM / 2, SHEET_BOTTOM);
  });
  scene.add(speakers);
}

// ---- The dancers: a crowd in front of each stage, moving left and right ----

let dancers;      // ONE InstancedMesh for all the dancers of the forest
const crowd = []; // where each dancer stands and how it moves

// A little person: a capsule for the body, a ball for the head. Feet at y = 0.
function dancerGeometry() {
  const body = new THREE.CapsuleGeometry(0.2, 0.85, 4, 8).translate(0, 0.625, 0);
  const head = new THREE.SphereGeometry(0.14, 8, 6).translate(0, 1.41, 0);
  return mergeGeometries([body, head]);
}

function addDancers(clearings) {
  clearings.forEach((c, i) => {
    const side = sideOf(i);
    for (let k = 0; k < DANCERS_PER_SCENE; k++) {
      crowd.push({
        x: side * (4.5 + Math.random() * 6),   // between us and the speakers
        z: c.z + (Math.random() - 0.5) * 11,    // spread along the stage
        size: 0.95 + Math.random() * 0.2,       // not everybody is as tall
        phase: Math.random() * Math.PI * 2,     // not everybody moves at the same moment
      });
    }
  });
  dancers = new THREE.InstancedMesh(dancerGeometry(), new THREE.MeshLambertMaterial(), crowd.length);
  dancers.castShadow = true;
  const colour = new THREE.Color();
  crowd.forEach((_, k) => dancers.setColorAt(k, colour.setHSL(Math.random(), 0.25, 0.03 + Math.random() * 0.05)));
  animateDancers(0); // place them before the first image
  scene.add(dancers);
}

const dancer = new THREE.Object3D();

function animateDancers(time) {
  const beat = time * BPM / 60 * Math.PI; // grows by π at each beat
  crowd.forEach((d, k) => {
    const sway = Math.sin(beat / 2 + d.phase); // left... right... (2 beats each way)
    const bounce = Math.abs(Math.sin(beat + d.phase * 0.2)) * 0.08; // a small jump on each beat
    dancer.position.set(d.x, bounce, d.z + sway * 0.15);
    dancer.rotation.set(sway * 0.12, 0, 0); // the body leans the way it moves
    dancer.scale.setScalar(d.size);
    dancer.updateMatrix();
    dancers.setMatrixAt(k, dancer.matrix);
  });
  dancers.instanceMatrix.needsUpdate = true; // tell the graphics card the positions changed
}

// ---- Party lights ----

const PALETTE = ["#ff2d6f", "#2de1ff", "#b84dff", "#ffb02d", "#3dff7a"].map(c => new THREE.Color(c));

// Real lights are expensive: every light is computed for every pixel. So we do NOT give
// 4 lights to each of the 25 stages. We have 2 "rigs" of 4 lights, and each frame they go
// to the 2 stages closest to us. A stage keeps its rig from far away (lost in the fog)
// until we have walked past it: its lights stay on during the whole approach.
const rigs = [0, 1].map(() => ({
  index: -1, // the stage this rig lights, -1 = none yet
  lamps: [0, 1, 2, 3].map(() => {
    // colour, intensity, reach (m), cone angle (rad), soft edge (0-1), how fast it fades with distance
    const spot = new THREE.SpotLight("#ffffff", 0, 40, 0.45, 0.6, 1);
    // the lamp itself: a small glowing ball where the light comes from
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 8), new THREE.MeshBasicMaterial());
    scene.add(spot, spot.target, bulb);
    return { spot, bulb };
  }),
}));

function setupRig(rig, index) {
  rig.index = index;
  const side = sideOf(index);
  const z = stopOf(index).z;
  const layout = [ // [lamp x, y, z] -> [aimed at x, y, z] (z relative to the stage)
    [[-side * 2, 5, -5], [side * SHEET_X, 2, -3]],                // behind us: on the dancers'
    [[-side * 2, 5, 5], [side * SHEET_X, 2, 3]],                  // backs and the speakers
    [[side * (SHEET_X - 0.8), 4.6, -6.4], [side * 6, 0, -2]],     // on top of the speaker walls:
    [[side * (SHEET_X - 0.8), 4.6, 6.4], [side * 6, 0, 2]],       // towards the crowd
  ];
  rig.lamps.forEach(({ spot, bulb }, k) => {
    const [[x, y, dz], [tx, ty, tdz]] = layout[k];
    spot.position.set(x, y, z + dz);
    spot.target.position.set(tx, ty, z + tdz);
    bulb.position.copy(spot.position);
  });
}

function animateLights(time) {
  if (tracks.length === 0) return;
  const beats = time * BPM / 60;
  const flash = (1 - beats % 1) ** 3;        // 1 right on the beat, then fades quickly
  const colourStep = Math.floor(beats / 8);  // colours change every 8 beats

  // The 2 stages around us: the one we come from and the one we go to.
  // Two neighbours are always one even and one odd: the even one gets rig 0, the odd one rig 1.
  const where = Math.max(0, Math.min(tracks.length - 1, -camera.position.z / SPACING));
  for (const index of [Math.floor(where), Math.ceil(where)]) {
    const rig = rigs[index % 2];
    if (rig.index !== index) setupRig(rig, index);
  }

  for (const rig of rigs) {
    if (rig.index < 0) continue;
    rig.lamps.forEach(({ spot, bulb }, k) => {
      const colour = PALETTE[(rig.index + colourStep + k) % PALETTE.length];
      spot.color.copy(colour);
      bulb.material.color.copy(colour);
      spot.intensity = 40 + 80 * flash; // always on, plus a flash on each beat
    });
  }
}

// ---- Sky beams: searchlights behind each stage, sweeping the sky ----

let beams;
const beamSpots = [];
const beam = new THREE.Object3D();

function addSkyBeams(clearings) {
  // A beam = a long open tube, thin at the bottom, wide at the top, that fades as it rises.
  // The fading comes from a picture: white at the bottom, black at the top (alphaMap = transparency).
  const canvas = document.createElement("canvas");
  canvas.width = 4;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  const fade = context.createLinearGradient(0, 0, 0, 64);
  fade.addColorStop(0, "black"); // top of the picture = top of the beam: invisible
  fade.addColorStop(1, "white"); // bottom = where the light starts: visible
  context.fillStyle = fade;
  context.fillRect(0, 0, 4, 64);

  const geometry = new THREE.CylinderGeometry(3, 0.12, 60, 16, 1, true).translate(0, 30, 0); // 60 m tall
  const material = new THREE.MeshBasicMaterial({
    alphaMap: new THREE.CanvasTexture(canvas),
    transparent: true,
    opacity: 0.2,
    blending: THREE.AdditiveBlending, // light adds up: it glows
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false, // seen from far away above the trees: they show where the next stages are
  });

  clearings.forEach((c, i) => {
    for (const dz of [-4, 0, 4]) {
      beamSpots.push({ index: i, side: sideOf(i), x: sideOf(i) * (SHEET_X + 1.5), z: c.z + dz, phase: Math.random() * 6 });
    }
  });
  beams = new THREE.InstancedMesh(geometry, material, beamSpots.length);
  beams.frustumCulled = false; // they move: never skip drawing them
  animateBeams(0);
  scene.add(beams);
}

function animateBeams(time) {
  const colourStep = Math.floor(time * BPM / 60 / 8);
  beamSpots.forEach((b, k) => {
    beam.position.set(b.x, 0.3, b.z);
    beam.rotation.set(
      Math.sin(time * 0.4 + b.phase) * 0.35,                // sweeps forwards and backwards...
      0,
      -b.side * 0.2 + Math.sin(time * 0.6 + b.phase) * 0.25, // ...and left and right, leaning back
    );
    beam.updateMatrix();
    beams.setMatrixAt(k, beam.matrix);
    beams.setColorAt(k, PALETTE[(b.index + colourStep + k) % PALETTE.length]);
  });
  beams.instanceMatrix.needsUpdate = true;
  beams.instanceColor.needsUpdate = true;
}

// ---------- 3. Two YouTube players ----------
// For a crossfade, two tracks must play at the same time: one player fades out
// while the other fades in. They take turns.

const players = [];
let active = 0;       // the player of the current track (0 or 1)
let loaded = false;   // has the current track already been started in its player?

function createPlayer(elementId) {
  return new Promise(resolve => {
    const player = new YT.Player(elementId, {
      width: "100%",
      height: "100%",
      playerVars: { playsinline: 1 },
      events: {
        onReady: resolve,
        onStateChange: event => {
          // track over: walk to the next sheet (only for the current track, once we are in front of it)
          if (event.data === YT.PlayerState.ENDED && player === players[active] && !walking) goTo(current + 1);
        },
        onError: () => { if (player === players[active] && !walking) goTo(current + 1); }, // video blocked: skip it
      },
    });
    players.push(player);
  });
}

// Volume of a player, from 0 (silent) to 1 (full)
function setLevel(player, level) {
  const volume = Math.round(Math.min(1, Math.max(0, level)) * 100); // YouTube wants 0 to 100
  if (volume === player.volume) return; // only talk to YouTube when the volume really changes
  player.volume = volume;
  player.setVolume(volume);
  if (volume === 0) player.pauseVideo(); // silent: no need to keep playing
}

function timeout(seconds, message) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), seconds * 1000));
}

// ---------- 4. Walking from sheet to sheet ----------

let tracks = [];
let current = 0;      // the sheet we walk to, then listen to
let walking = false;  // true while moving, false while listening
let started = false;  // false until the "enter" click
let distance = 0;     // where we are on the walk, in metres from its start
let walkStart = 0;    // where we were when this walk began (for the crossfade)

// Sound along the walk, with progress = 0 when we leave a sheet and 1 when we reach the next one:
const FADE_OUT_END = 0.7; // the old track is silent at 70 % of the way
const FADE_IN_START = 0.5; // the new track starts half way, then grows until we arrive

function goTo(index) {
  current = index % tracks.length;
  if (current === 0) distance = 0; // after the last one: back to the start of the walk
  walkStart = distance;
  walking = true;

  // The player of the old track keeps playing and will fade out.
  // The other one gets the new track: we stop whatever older track it still had.
  active = 1 - active;
  players[active].stopVideo();
  loaded = false;
  for (const player of players) player.getIframe().classList.toggle("front", player === players[active]);

  const track = tracks[current];
  const date = track.playedAt
    ? "écouté le " + new Date(track.playedAt * 1000).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" })
    : "en cours d'écoute";
  now.innerHTML = "";
  const name = document.createElement("strong");
  name.textContent = `${track.artist} – ${track.title}`;
  now.append(name, `${current + 1} / ${tracks.length} · ${date}`);
}

// Jump straight in front of a stage (from the map): same as goTo, but already arrived
function teleportTo(index) {
  goTo(index);
  distance = walkStart = stopDistances[current];
  walking = false; // not walking = progress 1: the new track starts at full volume, the old one stops
  const point = path.getPointAt(distance / path.getLength());
  camera.position.set(point.x, EYE, point.z);
  camera.rotation.set(0.18, -sideOf(current) * Math.PI / 2, 0); // already facing the sheet
}

// ---------- 5. The map: the forest seen from above ----------

const mapBox = document.getElementById("map");
const mapArea = document.getElementById("map-area");

function openMap() {
  mapBox.hidden = false;
  mapArea.innerHTML = "";
  const width = mapArea.clientWidth;
  const height = mapArea.clientHeight;
  const horizontal = width >= height; // wide screen: the forest goes left to right; phone: bottom to top
  const endZ = stopOf(tracks.length - 1).z - 10;
  const size = Math.max(48, Math.min(140, 1.9 * Math.max(width, height) / tracks.length)); // cover width
  const margin = size / 2 + 4; // so that the covers on the edges are not cut

  // Turns a place in the forest (metres) into a place on the map (pixels).
  // The forest is 25 times longer than wide: we squeeze its length to fit the screen.
  function project(x, z) {
    const along = (START_Z - z) / (START_Z - endZ); // 0 = entrance, 1 = last stage
    const across = (x + 20) / 40;                   // 0 = 20 m on our left, 1 = 20 m on our right
    const [a, b] = horizontal ? [along, across] : [across, 1 - along];
    return [margin + a * (width - 2 * margin), margin + b * (height - 2 * margin)];
  }

  // The trees and the walk, drawn on a canvas
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context.fillStyle = "#3f7a45";
  for (const t of treeSpots) {
    if (Math.abs(t.x) > 20) continue; // outside the map
    const [px, py] = project(t.x, t.z);
    context.beginPath();
    context.arc(px, py, 2.5, 0, Math.PI * 2);
    context.fill();
  }
  context.strokeStyle = "rgba(255, 255, 255, .4)";
  context.lineWidth = 2;
  context.setLineDash([6, 6]);
  context.beginPath();
  path.getSpacedPoints(400).forEach((p, k) => {
    const [px, py] = project(p.x, p.z);
    if (k === 0) context.moveTo(px, py);
    else context.lineTo(px, py);
  });
  context.stroke();
  mapArea.append(canvas);

  // One button per cover, at the place of its stage. Click = teleport.
  tracks.forEach((track, i) => {
    const button = document.createElement("button");
    button.className = "map-cover" + (i === current ? " current" : "");
    button.title = `${track.artist} – ${track.title}`;
    button.style.width = size + "px";
    const [px, py] = project(sideOf(i) * SHEET_X, stopOf(i).z);
    button.style.left = px + "px";
    button.style.top = py + "px";
    const picture = document.createElement("img");
    picture.src = coverUrl(track);
    picture.alt = button.title;
    button.append(picture);
    button.addEventListener("click", () => {
      mapBox.hidden = true;
      teleportTo(i);
    });
    mapArea.append(button);
  });

  // Where we are
  const you = document.createElement("div");
  you.id = "map-you";
  const [px, py] = project(camera.position.x, camera.position.z);
  you.style.left = px + "px";
  you.style.top = py + "px";
  mapArea.append(you);
}

document.getElementById("map-button").addEventListener("click", openMap);
document.getElementById("map-close").addEventListener("click", () => { mapBox.hidden = true; });
addEventListener("resize", () => { if (!mapBox.hidden) openMap(); }); // redraw at the new size

// Move a value a small part of the way towards its target at each image: a smooth movement
function approach(value, target, dt, speed) {
  return value + (target - value) * Math.min(1, dt * speed);
}

const clock = new THREE.Clock();
let stepPhase = 0; // grows while walking: makes the head go up and down with the steps

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1); // seconds since the last image (max 0.1 if the tab was hidden)
  const time = clock.elapsedTime;

  // Where the head wants to look. yaw = left/right, pitch = up/down (in radians)
  let yaw = Math.sin(time * 0.4) * 0.12; // the head wanders slowly a little left and right
  let pitch = 0;
  let bob = 0;

  if (started) {
    const sheetYaw = -sideOf(current) * Math.PI / 2; // +90° = left, -90° = right

    if (walking) {
      const target = stopDistances[current];
      distance = Math.min(target, distance + SPEED * dt);
      const u = distance / path.getLength(); // 0 = start of the curve, 1 = end
      const point = path.getPointAt(u);
      camera.position.x = point.x;
      camera.position.z = point.z;
      // Look where we go: the tangent is the direction of the curve at this point
      const direction = path.getTangentAt(u);
      yaw += Math.atan2(-direction.x, -direction.z);
      stepPhase += dt * 8;
      bob = Math.sin(stepPhase) * 0.04;
      // The last metres before the clearing: the head turns towards it little by little
      const closeness = Math.max(0, 1 - (target - distance) / TURN_START); // 0 far, 1 arrived
      yaw += (sheetYaw - yaw) * closeness;

      if (distance === target) walking = false; // arrived in front of the sheet
    } else {
      yaw = sheetYaw + Math.sin(time * 0.5) * 0.04; // listening: almost still
      pitch = 0.18;                                  // eyes up towards the cover
    }

    // ---- Crossfade: the volumes depend on where we are on the way ----
    const progress = walking ? (distance - walkStart) / Math.max(0.001, stopDistances[current] - walkStart) : 1;
    if (!loaded && progress >= FADE_IN_START) { // half way: the new track starts, silent
      players[active].setVolume(0);
      players[active].volume = 0;
      players[active].loadVideoById(tracks[current].videoId);
      loaded = true;
    }
    if (loaded) setLevel(players[active], (progress - FADE_IN_START) / (1 - FADE_IN_START));
    setLevel(players[1 - active], 1 - progress / FADE_OUT_END);
  }

  camera.rotation.y = approach(camera.rotation.y, yaw, dt, 2);
  camera.rotation.x = approach(camera.rotation.x, pitch, dt, 2);
  camera.position.y = approach(camera.position.y, EYE + bob, dt, 10);
  followCamera();
  if (dancers) animateDancers(time);
  if (beams) animateBeams(time);
  animateLights(time);

  if (fireflies) {
    fireflies.position.y = Math.sin(time * 0.5) * 0.3;              // they float up and down
    fireflies.material.opacity = 0.6 + Math.sin(time * 3) * 0.4;   // and twinkle
  }

  renderer.render(scene, camera);
});

// ---------- 6. Start ----------

document.getElementById("next").addEventListener("click", () => goTo(current + 1));

startButton.addEventListener("click", () => {
  document.getElementById("enter").hidden = true;
  hud.hidden = false;
  started = true;
  goTo(0);
});

try {
  const [data] = await Promise.all([
    loadTracks(),
    Promise.race([window.youtubeReady, timeout(15, "Le lecteur YouTube ne se charge pas. Vérifie ta connexion.")]),
  ]);
  tracks = shuffle(data.tracks);
  buildScene(tracks);
  await Promise.all([createPlayer("player-a"), createPlayer("player-b")]);
  status.textContent = data.warning ?? `${tracks.length} morceaux t'attendent.`;
  startButton.hidden = false;
} catch (error) {
  status.textContent = error.message;
  status.classList.add("error");
}
