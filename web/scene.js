import * as THREE from "three";

const SPACING = 14; // metres between two sheets along the path
const SIDE = 5;     // distance between the path and a sheet
const EYE = 1.7;    // height of the camera = our eyes
const SPEED = 4;    // walking speed, metres per second

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

// The cover goes through our nginx (/covers/...) instead of i.ytimg.com
function coverUrl(track) {
  return track.thumbnail.replace("https://i.ytimg.com/vi/", "/covers/");
}

// ---------- 2. The 3D scene ----------

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color("#05070a");

const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 500);
camera.position.set(0, EYE, SPACING); // a few steps before the first sheet

addEventListener("resize", () => { // responsive: the scene always fills the window
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// -1 = sheet on the left of the path, 1 = on the right
function sideOf(index) {
  return index % 2 === 0 ? -1 : 1;
}

function buildScene(tracks) {
  const length = tracks.length * SPACING + 2 * SPACING;

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(200, length + 100),
    new THREE.MeshBasicMaterial({ color: "#0b100b" }),
  );
  ground.rotation.x = -Math.PI / 2; // a plane is vertical by default: lay it down
  ground.position.z = -length / 2 + SPACING;
  scene.add(ground);

  const path = new THREE.Mesh(
    new THREE.PlaneGeometry(3, length),
    new THREE.MeshBasicMaterial({ color: "#2a2118" }),
  );
  path.rotation.x = -Math.PI / 2;
  path.position.set(0, 0.01, ground.position.z); // 1 cm above the ground so both stay visible
  scene.add(path);

  const loader = new THREE.TextureLoader();
  tracks.forEach((track, i) => {
    const sheet = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    loader.load(coverUrl(track), texture => {
      texture.colorSpace = THREE.SRGBColorSpace;
      sheet.material.map = texture;
      sheet.material.needsUpdate = true;
      sheet.scale.x = texture.image.width / texture.image.height; // keep the picture's shape
    });
    sheet.position.set(sideOf(i) * SIDE, 2.6, -i * SPACING);
    sheet.rotation.y = -sideOf(i) * Math.PI / 2; // turn the sheet to face the path
    scene.add(sheet);
  });
}

// ---------- 3. The YouTube player ----------

let player;

function createPlayer() {
  return new Promise(resolve => {
    player = new YT.Player("player", {
      width: "100%",
      height: "100%",
      playerVars: { playsinline: 1 },
      events: {
        onReady: resolve,
        onStateChange: event => {
          if (event.data === YT.PlayerState.ENDED && !walking) goTo(current + 1); // track over: next sheet
        },
        onError: () => { if (!walking) goTo(current + 1); }, // video removed or blocked: skip it
      },
    });
  });
}

function timeout(seconds, message) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), seconds * 1000));
}

// ---------- 4. Walking from sheet to sheet ----------

let tracks = [];
let current = 0;      // the sheet we walk to, then listen to
let walking = false;  // true while moving, false while listening
let started = false;  // false until the "enter" click

function goTo(index) {
  current = index % tracks.length;
  if (current === 0) camera.position.z = SPACING; // after the last one: back to the start
  walking = true;
  player.stopVideo();

  const track = tracks[current];
  const date = track.playedAt
    ? "écouté le " + new Date(track.playedAt * 1000).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" })
    : "en cours d'écoute";
  now.innerHTML = "";
  const name = document.createElement("strong");
  name.textContent = `${track.artist} – ${track.title}`;
  now.append(name, `${current + 1} / ${tracks.length} · ${date}`);
}

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1); // seconds since the last image (max 0.1 if the tab was hidden)

  if (started) {
    const stopZ = -current * SPACING;
    if (walking) {
      camera.position.z = Math.max(stopZ, camera.position.z - SPEED * dt);
      if (camera.position.z === stopZ) { // arrived in front of the sheet: play its music
        walking = false;
        player.loadVideoById(tracks[current].videoId);
      }
    }
    // Head: look ahead while walking, towards the sheet while listening (smoothly)
    const targetYaw = walking ? 0 : -sideOf(current) * Math.PI / 2;
    camera.rotation.y += (targetYaw - camera.rotation.y) * Math.min(1, dt * 2);
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
  tracks = data.tracks;
  buildScene(tracks);
  await createPlayer();
  status.textContent = data.warning ?? `${tracks.length} morceaux t'attendent.`;
  startButton.hidden = false;
} catch (error) {
  status.textContent = error.message;
  status.classList.add("error");
}
