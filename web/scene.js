import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const SPACING = 26;        // metres between two clearings
const CLEARING_X = 8;      // distance between the middle of the forest and the centre of a clearing
const CLEARING_RADIUS = 7; // no tree inside this circle
const SHEET_X = 12;        // the sheet stands at the back of its clearing
const SHEET_HEIGHT = 6;    // a big sheet: 6 m tall
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
    data = await (await fetch("/api/tracks")).json();
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

// The cover goes through our nginx (/covers/...) instead of i.ytimg.com
function coverUrl(track) {
  return track.thumbnail.replace("https://i.ytimg.com/vi/", "/covers/");
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

// ---- The walk: a winding route between the trees, no path ----

// Where we stand to look at clearing number `index`: just at its edge
function stopOf(index) {
  return new THREE.Vector3(0, 0, -index * SPACING);
}

// For each walk (to clearing 0, 1, 2...) a few points pushed left, right, left...:
// we slalom between the trees instead of walking straight
let waypoints = [];

function makeWaypoints(count) {
  const all = [];
  for (let i = 0; i < count; i++) {
    const fromZ = i === 0 ? START_Z : stopOf(i - 1).z;
    const toZ = stopOf(i).z;
    const steps = i === 0 ? 1 : 3;
    let side = Math.random() < 0.5 ? -1 : 1;
    const points = [];
    for (let s = 1; s <= steps; s++) {
      const z = fromZ + (toZ - fromZ) * s / (steps + 1);
      points.push(new THREE.Vector3(side * (1.5 + Math.random() * 2.5), 0, z));
      side = -side;
    }
    all.push(points);
  }
  return all;
}

// A smooth curve from `start` to clearing `index`. Catmull-Rom = a curve that goes
// exactly through each point; "centripetal" keeps it from making loops.
function routeFrom(start, index) {
  const ahead = waypoints[index].filter(p => p.z < start.z - 2); // only the points still in front of us
  return new THREE.CatmullRomCurve3([start.clone(), ...ahead, stopOf(index)], false, "centripetal");
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
function groundGeometry(width, length) {
  const geometry = new THREE.PlaneGeometry(width, length, 50, Math.round(length / 4));
  const position = geometry.attributes.position;
  const moss = new THREE.Color("#1b2614");
  const earth = new THREE.Color("#2a2016");
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

  // Draw every walk now, so that no tree grows on it. A point every 50 cm.
  waypoints = makeWaypoints(tracks.length);
  const routePoints = tracks.flatMap((_, i) => {
    const route = routeFrom(i === 0 ? new THREE.Vector3(0, 0, START_Z) : stopOf(i - 1), i);
    return route.getSpacedPoints(Math.ceil(route.getLength() / 0.5));
  });

  addForest(START_Z + 20, -length, clearings, routePoints);
  addFireflies(START_Z + 20, -length);

  // A patch of lighter grass shows each clearing
  for (const c of clearings) {
    const patch = new THREE.Mesh(
      new THREE.CircleGeometry(CLEARING_RADIUS, 32),
      new THREE.MeshLambertMaterial({ color: "#26331b" }),
    );
    patch.rotation.x = -Math.PI / 2;
    patch.position.set(c.x, 0.005, c.z);
    patch.receiveShadow = true;
    scene.add(patch);
  }

  const ground = new THREE.Mesh(
    groundGeometry(200, length + 100),
    new THREE.MeshLambertMaterial({ vertexColors: true }), // use the colour of each corner
  );
  ground.rotation.x = -Math.PI / 2; // a plane is vertical by default: lay it down
  ground.position.z = -length / 2 + START_Z;
  ground.receiveShadow = true;
  scene.add(ground);

  const loader = new THREE.TextureLoader();
  tracks.forEach((track, i) => {
    const sheet = new THREE.Mesh(
      new THREE.PlaneGeometry(SHEET_HEIGHT, SHEET_HEIGHT),
      new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
    );
    loader.load(coverUrl(track), texture => {
      texture.colorSpace = THREE.SRGBColorSpace;
      sheet.material.map = texture;
      sheet.material.needsUpdate = true;
      sheet.scale.x = texture.image.width / texture.image.height; // keep the picture's shape
    });
    sheet.position.set(sideOf(i) * SHEET_X, SHEET_HEIGHT / 2 + 0.5, -i * SPACING); // 50 cm above the grass
    sheet.rotation.y = -sideOf(i) * Math.PI / 2; // turn the sheet to face the middle of the forest
    sheet.castShadow = true;
    scene.add(sheet);
  });
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
let route;            // the curve of the current walk
let routeLength = 0;  // its length in metres
let walked = 0;       // metres already walked on it

// Sound along the walk, with progress = 0 when we leave a sheet and 1 when we reach the next one:
const FADE_OUT_END = 0.7; // the old track is silent at 70 % of the way
const FADE_IN_START = 0.5; // the new track starts half way, then grows until we arrive

function goTo(index) {
  current = index % tracks.length;
  if (current === 0) camera.position.set(0, EYE, START_Z); // after the last one: back to the start
  route = routeFrom(new THREE.Vector3(camera.position.x, 0, camera.position.z), current);
  routeLength = route.getLength();
  walked = 0;
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
      walked = Math.min(routeLength, walked + SPEED * dt);
      const u = walked / routeLength; // 0 = start of the curve, 1 = end
      const point = route.getPointAt(u);
      camera.position.x = point.x;
      camera.position.z = point.z;
      // Look where we go: the tangent is the direction of the curve at this point
      const direction = route.getTangentAt(u);
      yaw += Math.atan2(-direction.x, -direction.z);
      stepPhase += dt * 8;
      bob = Math.sin(stepPhase) * 0.04;
      // The last metres before the clearing: the head turns towards it little by little
      const closeness = Math.max(0, 1 - (routeLength - walked) / TURN_START); // 0 far, 1 arrived
      yaw += (sheetYaw - yaw) * closeness;

      if (walked === routeLength) walking = false; // arrived in front of the sheet
    } else {
      yaw = sheetYaw + Math.sin(time * 0.5) * 0.04; // listening: almost still
      pitch = 0.15;                                  // eyes up towards the cover
    }

    // ---- Crossfade: the volumes depend on where we are on the way ----
    const progress = walking ? walked / routeLength : 1;
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

  if (fireflies) {
    fireflies.position.y = Math.sin(time * 0.5) * 0.3;              // they float up and down
    fireflies.material.opacity = 0.6 + Math.sin(time * 3) * 0.4;   // and twinkle
  }

  renderer.render(scene, camera);
});

// ---------- 5. Start ----------

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
