// The camera and the input state of the walkable page, kept out of the page so
// that something can drive them without a browser.
//
// There is no browser on the machine this is developed on, so controls that
// live inside an inline <script> are controls nobody ever runs until a user
// does. Everything here is plain state and arithmetic: it takes key codes,
// mouse deltas and a timestep and hands back an eye, a target and how far the
// tile streamer has to reach. scripts/web/check_controls.js drives exactly
// this object, and mutates this file to prove the checks can fail.
//
// The frame is the manifest's: scene metres, z up. Yaw is measured about z from
// +x, pitch up from the horizon, both radians. Right is cross(forward, up),
// which is the same right the renderer's view matrix builds, so D moves the
// picture the way the screen says it should.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WalkControls = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
'use strict';

// A person, and the speeds a person moves at on a screen, which are not the
// speeds a person moves at. This shipped at 3.4 m/s, was corrected to 1.8 --
// a brisk walk, the honest number for a body -- and 1.8 is what a walker on
// this page actually complained about. Both readings were right about
// different questions. A screen gives none of the proprioception that makes
// real walking feel like progress, so a true walking pace reads as a crawl;
// and the crop is 450 by 600 m, four minutes corner to corner at 1.8 m/s,
// spent on a near field that is not worth four minutes of looking at. 4 m/s
// crosses it in under two and is still slow enough to steer between buildings.
// The ratio of 2.25 keeps shift a gear rather than a jump.
const EYE_H = 1.65, WALK = 4.0, RUN = 9.0;
// Flying is for crossing the crop, not for imitating a person: the crop is
// 450 by 600 m and traversing it at walking pace takes four minutes.
const FLY = 12, FLY_RUN = 36;
const FLY_FLOOR = 0.5;   // metres of terrain clearance kept while flying

const FOV = 62;
const LOOK = 0.0022;             // radians per pixel of pointer-locked mouse
// Radians per pixel of a drag, for turning when the pointer lock is not
// available. It is coarser than the locked mouse because a drag is bounded by
// the window and a locked mouse is not: 0.0045 puts a half turn in 700 px.
const DRAG_LOOK = 0.0045;
const PITCH_MAX = 1.45;          // 83 degrees, short of the pole
const ORBIT_LOOK = 0.005, ORBIT_ZOOM = 0.0011;
// The shallowest tilt the pan rate is allowed to divide by. Near the horizon
// the ground runs along the view and a pixel of drag really is hundreds of
// metres of it, which is true and unusable.
const PAN_TILT_MIN = 0.3;
const ORBIT_PITCH = [0.15, 1.50], ORBIT_DIST = [80, 2000];
// A pinch reports a ratio of finger separations rather than a wheel's arbitrary
// delta, so it drives the distance directly instead of through an exponent.
const PINCH_MIN = 0.02, PINCH_MAX = 50;
// Metres of climb over which the model's painted sky fades out. Above the
// roofs the model carries a backdrop of a few very large gaussians so the walk
// has a sky; from the overview the camera is above it and looks down through
// it, which washes the whole campus white. See setSky.
const SKY_FADE_M = 40;
const TWEEN_S = 0.7;             // seconds of camera blend when the mode changes
// Travelling to a named building blends over a distance-dependent time: 0.7 s
// across a courtyard is a step, 0.7 s across the crop is 600 m/s and reads as a
// glitch rather than as going somewhere.
const TRAVEL_S = [0.7, 1.8], TRAVEL_FAR = 320;
const PICK_MAX = 260;            // metres the crosshair reaches down the ray
const UNNAMED = 255;             // the ident plane's value for a building OSM does not name
const WALK_RADIUS = 900;         // metres of tiles to stream while on foot
// A frame longer than this is a stall -- a tab that spent a while in the
// background, a tile landing on the main thread -- and the walk takes one step
// of it rather than leaping across the quad.
//
// It was 0.05, which is not a stall guard, it is a speed limit. Every frame
// slower than 20 fps was cut to 20 fps worth of movement, so the walk ran slow
// in exact proportion to how badly the page was running: half speed at 10 fps,
// a twentieth at 1. Streaming a couple of million gaussians is exactly when the
// frame rate drops, which is exactly when the walk stopped moving.
const DT_MAX = 0.25;

// Where H, and the first walk of a session, puts you. `?at=x,y` overrides the
// position and `?yaw=` the heading, both in scene metres and radians, so a
// spot can be linked to rather than described. Anything unparseable is
// ignored rather than becoming NaN and putting the camera nowhere.
const HOME = (() => {
  const d = {pos: [675, 550], yaw: 1.9, pitch: -0.05};
  try {
    const q = new URLSearchParams(location.search);
    const at = (q.get('at') || '').split(',').map(Number);
    if (at.length === 2 && at.every(Number.isFinite)) d.pos = at;
    const y = Number(q.get('yaw'));
    if (q.has('yaw') && Number.isFinite(y)) d.yaw = y;
  } catch (e) { /* no location in the node test harness */ }
  return d;
})();
const DEFAULT_CROP = [450, 250, 900, 850];
const MOVE_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'KeyC',
                   'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

const clamp = (v, lo, hi) => v < lo ? lo : (v > hi ? hi : v);
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const smooth = t => t * t * (3 - 2 * t);
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t,
                            a[1] + (b[1] - a[1]) * t,
                            a[2] + (b[2] - a[2]) * t];

function create(opts) {
  opts = opts || {};
  let ground = opts.ground || null;          // {z, w, h, step, crop}
  let solid = opts.solid || null;            // {ident, height, w, h, step, crop}
  let places = opts.places || [];            // named buildings, from walk_layer.json
  const byId = new Map();
  let crop = (ground && ground.crop) || opts.crop || DEFAULT_CROP;
  let zRange = opts.zRange || [216, 267];    // scene z extent, for framing only
  let aspect = opts.aspect || 1.6;           // canvas width over height
  let vpH = opts.vpH || 750;                 // canvas pixels tall, for the pan rate
  let skyZ = Infinity;                       // above this the model paints sky
  // How close the orbit may come. A ladder whose finest level has a spacing of
  // s is only honest beyond s*focal/tau, so a viewer built from coarse tiles
  // alone should not let anyone drive inside the distance its own data can
  // answer for. The page reads that number off the manifest and sets it here;
  // the default is the old floor, so a full ladder behaves as it did.
  let orbitNear = ORBIT_DIST[0];

  let mode = 'walk';
  let pos = [HOME.pos[0], HOME.pos[1], 0], yaw = HOME.yaw, pitch = HOME.pitch;
  let fly = false;
  const keys = new Set();
  const orbit = {t: [0, 0, 0], yaw: HOME.yaw + Math.PI, pitch: 0.85, dist: 600};
  let tween = null;

  // ---- the terrain the walker stands on --------------------------------------
  // A splat has no surface to collide with, and picking a height out of the
  // gaussians puts the eye inside a hedge as often as on the path, so height
  // comes off the lidar grid the whole scene was built from.
  function groundAt(x, y) {
    if (!ground) return 222.0;
    const g = ground;
    const c = (x - g.crop[0]) / g.step, r = (y - g.crop[1]) / g.step;
    const c0 = clamp(Math.floor(c), 0, g.w - 2), r0 = clamp(Math.floor(r), 0, g.h - 2);
    const fx = clamp(c - c0, 0, 1), fy = clamp(r - r0, 0, 1);
    const a = g.z[r0 * g.w + c0], b = g.z[r0 * g.w + c0 + 1];
    const d = g.z[(r0 + 1) * g.w + c0], e = g.z[(r0 + 1) * g.w + c0 + 1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy;
  }
  // ---- what is solid, and what it is called ----------------------------------
  // A splat has no surfaces, so nothing here can be collided with or picked out
  // of the gaussians. Both questions are answered by one raster on the lidar
  // grid: a byte per cell saying which building is there, and a second byte
  // saying how tall it is. scripts/web/05_walk_layer.py writes it.
  function cell(x, y) {
    if (!solid) return -1;
    const c = Math.floor((x - solid.crop[0]) / solid.step);
    const r = Math.floor((y - solid.crop[1]) / solid.step);
    if (c < 0 || r < 0 || c >= solid.w || r >= solid.h) return -1;
    return r * solid.w + c;
  }
  function identAt(x, y) {
    const i = cell(x, y);
    return i < 0 ? 0 : solid.ident[i];
  }
  const isSolid = (x, y) => identAt(x, y) !== 0;
  function setSolid(s_) {
    solid = s_;
    if (solid && isSolid(pos[0], pos[1])) pushOut();
  }
  function setPlaces(list) {
    places = Array.isArray(list) ? list : [];
    byId.clear();
    for (const p of places) if (p && p.id) byId.set(p.id, p);
  }
  // The walker can end up inside a wall two ways: flying in and landing, and
  // arriving at a position from the query string. Walk out along the shortest
  // way out rather than refusing to move, which is what standing inside a
  // closed footprint with collision on would otherwise mean.
  function pushOut(maxR) {
    if (!solid) return false;
    const step = solid.step, R = (maxR || 40) / step;
    for (let ring = 1; ring <= R; ring++) {
      let best = null, bd = Infinity;
      for (let i = 0; i < 8 * ring; i++) {
        const th = 2 * Math.PI * i / (8 * ring);
        const x = pos[0] + Math.cos(th) * ring * step;
        const y = pos[1] + Math.sin(th) * ring * step;
        if (isSolid(x, y)) continue;
        const d = (x - pos[0]) * (x - pos[0]) + (y - pos[1]) * (y - pos[1]);
        if (d < bd) { bd = d; best = [x, y]; }
      }
      if (best) {
        pos[0] = best[0]; pos[1] = best[1];
        keepInside();
        pos[2] = fly ? Math.max(pos[2], groundAt(pos[0], pos[1]) + FLY_FLOOR) : eyeZ();
        return true;
      }
    }
    return false;
  }

  // What the crosshair is on. March the ident plane rather than the gaussians:
  // a splat cloud has nothing to intersect, and the same raster that stops the
  // walker already knows which building each cell belongs to. The height plane
  // is what keeps the sky above a roof from reading as the building under it.
  function lookingAt(maxT) {
    if (!solid) return null;
    const f = forward(), st = solid.step, lim = maxT || PICK_MAX;
    for (let t = 1.0; t < lim; t += st) {
      const x = pos[0] + f[0] * t, y = pos[1] + f[1] * t, z = pos[2] + f[2] * t;
      const i = cell(x, y);
      if (i < 0) return null;
      const g = groundAt(x, y);
      if (z < g) return null;                       // the ray met the terrain
      const id = solid.ident[i];
      if (!id) continue;
      if (z > g + solid.height[i]) continue;        // over the roof, not on it
      return {id, dist: t, at: [x, y], place: byId.get(id) || null,
              name: (byId.get(id) || {}).name || null};
    }
    return null;
  }

  // Named buildings, nearest first, with the bearing to each relative to where
  // the walker is facing, so a list can be ordered by distance and an arrow can
  // point.
  function nearby(n) {
    const e = mode === 'overview' ? orbit.t : pos;
    const out = places.map(p => {
      const dx = p.at[0] - e[0], dy = p.at[1] - e[1];
      return {place: p, dist: Math.hypot(dx, dy),
              bearing: Math.atan2(dy, dx) - yaw};
    });
    out.sort((a, b) => a.dist - b.dist);
    return n ? out.slice(0, n) : out;
  }

  // Go and stand in front of a building. The spot and the heading are solved
  // for offline, on the same raster, so the arrival looks at a facade from
  // outside it rather than landing in the lobby.
  function goTo(which) {
    const p = typeof which === 'object' ? which
            : byId.get(which) || places.find(q => q.name === which);
    if (!p || !p.stand) return false;
    const was = camera();
    const from = pos.slice();
    if (mode !== 'walk') { mode = 'walk'; fly = false; }
    pos = [p.stand[0], p.stand[1], 0];
    keepInside();
    pos[2] = eyeZ();
    yaw = p.yaw; fly = false;
    // Look at the building, not at the horizon. Arriving level aims at the
    // foot of the wall, and the foot of a wall is the one part of it the
    // ground in between can hide: the IGB Gatehouse stands up a 1.4 m rise, so
    // a level ray from 22 m away went into the hillside and the page reported
    // that the walker it had just sent there was looking at nothing.
    const aimZ = groundAt(p.at[0], p.at[1]) + 0.4 * (p.h || 0);
    const away = Math.hypot(p.at[0] - pos[0], p.at[1] - pos[1]);
    pitch = clamp(Math.atan2(aimZ - pos[2], Math.max(away, 1)),
                  -PITCH_MAX, PITCH_MAX);
    const far = Math.hypot(pos[0] - from[0], pos[1] - from[1]);
    const dur = TRAVEL_S[0] + (TRAVEL_S[1] - TRAVEL_S[0]) *
                clamp(far / TRAVEL_FAR, 0, 1);
    tween = {t: 0, eye: was.eye, target: was.target, dur};
    return true;
  }

  // The overview's answer to "show me that building". The walk's answer is to
  // stand on the pavement outside its front door, which is the wrong answer
  // from up here and, on a page that is only a bird's-eye, drops the viewer
  // into a camera it does not offer.
  function focus(which) {
    const p = typeof which === 'object' ? which
            : byId.get(which) || places.find(q => q.name === which);
    if (!p) return false;
    if (mode !== 'overview') return goTo(p);
    const was = camera();
    orbit.t = [p.at[0], p.at[1], groundAt(p.at[0], p.at[1])];
    // far enough back that the building is a building rather than a texture:
    // its own footprint sets the scale, and the ladder sets the floor
    orbit.dist = clamp(3.2 * Math.sqrt(Math.max(p.area || 400, 400)),
                       orbitNear, ORBIT_DIST[1]);
    tween = {t: 0, eye: was.eye, target: was.target, dur: TRAVEL_S[1]};
    return true;
  }

  function setGround(g) {
    ground = g;
    if (g && g.crop) crop = g.crop;
    if (g && g.zRange) zRange = g.zRange.slice();
    clampToSky();
    keepInside();
    pos[2] = eyeZ();
    frameScene();
  }

  // ---- the sky the model painted --------------------------------------------
  // Above the roofs this model carries a backdrop: a few thousand very large,
  // fairly opaque gaussians standing in for a sky, which is what the walk looks
  // up into. They are 0.36% of the model and they wreck the overview twice
  // over. They reach z 441, so the z extent the overview is asked to frame is
  // 225 m tall rather than the 50 m the campus is, and the framing pulls back
  // far enough to hold a column of sky. And the overview eye is *above* them,
  // so it looks down at the campus through the backdrop and the whole quad
  // comes out white.
  //
  // Neither is a rendering bug. The backdrop is doing its job for the walk and
  // has no business in a view from above it, so it is faded out over the climb
  // that leaves it behind, and the framing stops at the roofs.
  //
  // scripts/web/05_walk_layer.py measures the height: it is the one step that
  // knows how tall the buildings are. Without it skyZ stays infinite and
  // nothing here does anything, which is how a ladder built before this
  // behaves.
  function clampToSky() {
    if (Number.isFinite(skyZ)) zRange = [zRange[0], Math.min(zRange[1], skyZ)];
  }
  function setSky(z) {
    skyZ = Number.isFinite(z) ? z : Infinity;
    clampToSky();
    frameScene();
  }
  // How much of the backdrop to take away.
  //
  // Height alone was the wrong question. It answers "is the camera above the
  // sky", and what matters is "is the sky between the camera and the campus" --
  // which it is for the whole of the overview, not only the part of it that is
  // high up. At 406 m out and the minimum tilt the eye sits at 282 m, 14 m over
  // a sky floor of 268, so a third of the backdrop was still being drawn; and
  // at that angle it is not overhead, it is edge-on across the far half of the
  // quad. It read as a bank of fog and doubled the brightness of the frame.
  //
  // So the overview never wants it, and on foot the old ramp still applies, for
  // the walker who flies up out of it. Blended across a mode change by the same
  // curve as the camera, so nothing snaps.
  const skyFade = () => {
    if (!Number.isFinite(skyZ)) return 0;
    const now = mode === 'overview' ? 1
              : clamp((camera().eye[2] - skyZ) / SKY_FADE_M, 0, 1);
    return (tween && tween.fade0 !== undefined)
      ? tween.fade0 + (now - tween.fade0) * smooth(tween.t) : now;
  };

  // The framing and the pan rate both depend on the shape of the window, so
  // the page hands its canvas over on every resize and R frames the scene
  // again. setAspect is kept because it is what the aspect means; the pan also
  // needs the height in pixels, which an aspect ratio cannot supply.
  const setAspect = a => { if (a > 0.05 && a < 20) aspect = a; };
  const setViewport = (w, h) => { if (h > 16) vpH = h; setAspect(w / h); };

  const forward = () => {
    const cp = Math.cos(pitch);
    return [cp * Math.cos(yaw), cp * Math.sin(yaw), Math.sin(pitch)];
  };
  const eyeZ = () => groundAt(pos[0], pos[1]) + EYE_H;
  // 1 m inside the crop: outside it there are no tiles to look at and the
  // terrain grid only repeats its edge row, so walking out is walking into
  // nothing rather than off the end of the world.
  function keepInside() {
    pos[0] = clamp(pos[0], crop[0] + 1, crop[2] - 1);
    pos[1] = clamp(pos[1], crop[1] + 1, crop[3] - 1);
  }

  // ---- the two cameras -------------------------------------------------------
  function orbitEyeAt(d) {
    const cp = Math.cos(orbit.pitch);
    return [orbit.t[0] + d * cp * Math.cos(orbit.yaw),
            orbit.t[1] + d * cp * Math.sin(orbit.yaw),
            orbit.t[2] + d * Math.sin(orbit.pitch)];
  }
  const orbitEye = () => orbitEyeAt(orbit.dist);
  // Everything in the crop, inside the frame. There is no closed form at this
  // elevation: the near corner sits at a fraction of the centre's depth and
  // leaves the bottom of the frame while the far one is still well inside the
  // top, which is what fitting the crop's diagonal to the field of view got
  // wrong by 7% of the frame. Whether the corners fit is monotone in the
  // distance, so ask the question and bisect on the answer.
  const FIT = 0.97;                // of the half angle, so nothing sits on the edge
  // the eye and the renderer's own basis at a given orbit distance
  function orbitBasis(d) {
    const eye = orbitEyeAt(d);
    const f = [(orbit.t[0] - eye[0]) / d, (orbit.t[1] - eye[1]) / d,
               (orbit.t[2] - eye[2]) / d];
    const rl = Math.hypot(f[1], f[0]) || 1;             // cross(f, up), normalised
    const r = [f[1] / rl, -f[0] / rl, 0];
    const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2],
               r[0] * f[1] - r[1] * f[0]];
    return {eye, f, r, u};
  }
  function fits(d) {
    const b = orbitBasis(d);
    const tanY = Math.tan(FOV * Math.PI / 360) * FIT, tanX = tanY * aspect;
    for (const x of [crop[0], crop[2]])
      for (const y of [crop[1], crop[3]])
        for (const z of zRange) {
          const v = [x - b.eye[0], y - b.eye[1], z - b.eye[2]];
          const dz = dot3(v, b.f);
          if (dz <= 0) return false;
          if (Math.abs(dot3(v, b.r)) > tanX * dz) return false;
          if (Math.abs(dot3(v, b.u)) > tanY * dz) return false;
        }
    return true;
  }
  function frameDist() {
    let lo = 20, hi = 20;
    while (hi < ORBIT_DIST[1] && !fits(hi)) { lo = hi; hi *= 1.4; }
    for (let i = 0; i < 32; i++) { const m = (lo + hi) / 2; if (fits(m)) hi = m; else lo = m; }
    return hi;
  }
  // Where the corners of the crop sit in the frame, as fractions of the half
  // angle: 1 is the edge of the picture. Returns the middle and the extent of
  // that box, which is what both the fit and the centring are about.
  function frame() {
    const b = orbitBasis(orbit.dist), tanY = Math.tan(FOV * Math.PI / 360);
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, behind = false;
    for (const x of [crop[0], crop[2]])
      for (const y of [crop[1], crop[3]])
        for (const z of zRange) {
          const v = [x - b.eye[0], y - b.eye[1], z - b.eye[2]];
          const dz = dot3(v, b.f);
          if (dz <= 0) { behind = true; continue; }
          const px = dot3(v, b.r) / (dz * tanY * aspect), py = dot3(v, b.u) / (dz * tanY);
          x0 = Math.min(x0, px); x1 = Math.max(x1, px);
          y0 = Math.min(y0, py); y1 = Math.max(y1, py);
        }
    return {behind, mx: (x0 + x1) / 2, my: (y0 + y1) / 2,
            half: Math.max(x1 - x0, y1 - y0, x1, -x0, y1, -y0)};
  }
  function frameScene() {
    orbit.t = [(crop[0] + crop[2]) / 2, (crop[1] + crop[3]) / 2, 0];
    orbit.t[2] = groundAt(orbit.t[0], orbit.t[1]);
    orbit.pitch = 0.85;
    orbit.dist = clamp(frameDist(), orbitNear, ORBIT_DIST[1]);
    // The crop is a rectangle on a plane seen at an angle, so its near edge is
    // magnified and its far edge shrinks: aiming at the middle of the crop does
    // not put the middle of the crop in the middle of the picture, and the
    // first version of this left the quad low and to the left with a third of
    // the frame empty. Slide the target across the ground until the corners sit
    // symmetrically, refitting the distance each time.
    const tanY = Math.tan(FOV * Math.PI / 360);
    for (let i = 0; i < 6; i++) {
      const b = orbitBasis(orbit.dist), f = frame();
      if (f.behind) break;
      const fg = [b.f[0], b.f[1], 0], fl = Math.hypot(fg[0], fg[1]) || 1;
      fg[0] /= fl; fg[1] /= fl;
      const along = f.my * tanY * orbit.dist / Math.max(dot3(fg, b.u), 1e-3);
      const across = f.mx * tanY * aspect * orbit.dist;
      orbit.t[0] += b.r[0] * across + fg[0] * along;
      orbit.t[1] += b.r[1] * across + fg[1] * along;
      orbit.t[2] = groundAt(orbit.t[0], orbit.t[1]);
      orbit.dist = clamp(frameDist(), orbitNear, ORBIT_DIST[1]);
    }
  }
  function rawCamera() {
    if (mode === 'overview') return {eye: orbitEye(), target: orbit.t.slice()};
    const f = forward();
    return {eye: pos.slice(), target: [pos[0] + f[0], pos[1] + f[1], pos[2] + f[2]]};
  }
  // Blended while a mode change is in flight, so the picture travels between
  // the two viewpoints instead of cutting. The streamer reads this eye too,
  // which is why the levels have time to arrive on the way.
  function camera() {
    const c = rawCamera();
    if (tween) {
      const t = smooth(tween.t);
      c.eye = lerp3(tween.eye, c.eye, t);
      c.target = lerp3(tween.target, c.target, t);
    }
    c.up = [0, 0, 1];
    c.fov = FOV;
    return c;
  }

  // Tiles to ask for. On foot the horizon does the limiting. From the overview
  // the far corner of the crop is already 880 m away at the framing distance
  // and 1,800 m after a few clicks of the wheel, so the walk's fixed 900 m
  // dropped the far half of the scene and the picture ended in a straight edge.
  // Measure to the crop's own corners instead.
  function streamRadius() {
    if (mode === 'walk' && !tween) return WALK_RADIUS;
    const e = camera().eye;
    let m = 0;
    for (const x of [crop[0], crop[2]])
      for (const y of [crop[1], crop[3]])
        for (const z of zRange)
          m = Math.max(m, Math.hypot(x - e[0], y - e[1], z - e[2]));
    return Math.max(mode === 'walk' ? WALK_RADIUS : 0, m) + 8;
  }

  // ---- mode ------------------------------------------------------------------
  function setMode(m) {
    if (m === mode) return;
    const was = camera();          // the blended one, so a second switch mid-blend
                                   // starts from where the picture actually is
    releaseKeys();                 // whatever was held belongs to the old mode
    if (m === 'overview') {
      // Frame the whole crop, but keep the heading: the walker's facing becomes
      // the direction the overview looks along, so the scene rotates into place
      // rather than arriving from an unrelated compass point. The heading goes
      // first, because the framing depends on which way the rectangle is seen.
      orbit.yaw = yaw + Math.PI;
      frameScene();
    } else {
      // Land under what the overview was looking at. Teleporting back to a
      // fixed spot loses the thing the user just picked out from above.
      pos = [orbit.t[0], orbit.t[1], 0];
      keepInside();
      pos[2] = eyeZ();
      yaw = orbit.yaw + Math.PI;   // the orbit eye sits opposite its view
      pitch = HOME.pitch;
      fly = false;
    }
    const fade0 = skyFade();       // before the mode changes what it answers
    mode = m;
    tween = {t: 0, eye: was.eye, target: was.target, fade0};
  }
  const toggleMode = () => setMode(mode === 'walk' ? 'overview' : 'walk');

  function home() {
    if (mode === 'overview') { orbit.yaw = HOME.yaw + Math.PI; frameScene(); return; }
    pos = [HOME.pos[0], HOME.pos[1], 0];
    pos[2] = eyeZ();
    yaw = HOME.yaw; pitch = HOME.pitch; fly = false;
  }

  // ---- input -----------------------------------------------------------------
  // keydown repeats while a key is held -- tens of times a second -- so a
  // toggle written in the handler fires tens of times. F flipped fly on every
  // repeat and R re-homed continuously, which is what made both keys look
  // random. Fire on the transition: the browser's repeat flag, and our own set,
  // which also covers the repeats that arrive for a key held across a blur.
  function keyDown(code, repeat) {
    const held = keys.has(code);
    keys.add(code);
    if (!held && !repeat) {
      if (code === 'KeyR') home();
      // Landing inside a building is the one way flight can leave the walker
      // somewhere collision would never have let it walk to, so it walks out.
      if (code === 'KeyF' && mode === 'walk') {
        fly = !fly;
        if (!fly && solid && isSolid(pos[0], pos[1])) pushOut();
      }
      if (code === 'KeyM') toggleMode();
    }
    return MOVE_KEYS.indexOf(code) >= 0;
  }
  const keyUp = code => { keys.delete(code); };
  // Nothing delivers keyup while the window is not focused, so a key released
  // during an alt-tab stays down for ever and the camera walks off on its own.
  // The page calls this on blur and on losing pointer lock.
  const releaseKeys = () => { keys.clear(); };

  function look(dx, dy, gain) {
    const k = gain || LOOK;
    yaw -= dx * k;
    pitch = clamp(pitch - dy * k, -PITCH_MAX, PITCH_MAX);
  }
  // Turning on foot without the pointer lock. The lock is the good way to look
  // around and it is not always there to be had: Chrome refuses one within a
  // second of the last Escape, an iframe needs allow="pointer-lock", and a
  // walker who pressed Escape has no way back until they click again. The page
  // already told them to "drag instead" in that case and nothing was listening.
  //
  // The same direction as the locked mouse, deliberately. A drag that turned
  // the camera the other way would mean the page looks around two different
  // ways depending on whether a lock happened to be granted, and the lock can
  // be granted halfway through.
  const lookDrag = (dx, dy) => look(dx, dy, DRAG_LOOK);
  function drag(dx, dy, pan) {
    if (mode !== 'overview') return;
    if (pan) {
      // Slide the ground under the cursor, in the horizontal plane, so panning
      // never lifts the orbit centre off the terrain.
      //
      // Metres of ground per pixel of drag, so the ground stays under the
      // cursor rather than lagging behind it. This was one constant, 0.0016 per
      // metre of distance, which is dist/focal for a 750 pixel tall canvas
      // looking at a surface face on. Neither held: on any other window height
      // both axes were wrong, and the ground is not seen face on, so a pixel up
      // the screen covers more ground than a pixel across it and the vertical
      // drag ran a third too slow at the framing tilt.
      const focal = vpH / (2 * Math.tan(FOV * Math.PI / 360));
      const across = orbit.dist / focal;
      const along = across / Math.max(Math.sin(orbit.pitch), PAN_TILT_MIN);
      // cross(view direction, up), which is right on the screen; the target
      // then moves against the drag, so the ground travels with the cursor
      const right = [-Math.sin(orbit.yaw), Math.cos(orbit.yaw)];
      const fwd = [-Math.cos(orbit.yaw), -Math.sin(orbit.yaw)];
      for (let i = 0; i < 2; i++)
        orbit.t[i] += -dx * right[i] * across + dy * fwd[i] * along;
      orbit.t[0] = clamp(orbit.t[0], crop[0] - 200, crop[2] + 200);
      orbit.t[1] = clamp(orbit.t[1], crop[1] - 200, crop[3] + 200);
      orbit.t[2] = groundAt(orbit.t[0], orbit.t[1]);
    } else {
      orbit.yaw -= dx * ORBIT_LOOK;
      orbit.pitch = clamp(orbit.pitch + dy * ORBIT_LOOK, ORBIT_PITCH[0], ORBIT_PITCH[1]);
    }
  }
  // Two fingers. `ratio` is the new separation over the old one, so spreading
  // them apart is greater than one and has to bring the camera closer -- the
  // gesture pulls the ground toward you, the same way it does on a map.
  function pinch(ratio) {
    if (mode !== 'overview') return;
    if (!(ratio > PINCH_MIN && ratio < PINCH_MAX)) return;   // a lifted finger
    orbit.dist = clamp(orbit.dist / ratio, orbitNear, ORBIT_DIST[1]);
  }
  const setNearest = m => {
    if (m > 0 && m < ORBIT_DIST[1]) orbitNear = m;
    if (orbit.dist < orbitNear) orbit.dist = orbitNear;
  };
  function zoom(deltaY) {
    if (mode !== 'overview') return;
    orbit.dist = clamp(orbit.dist * Math.exp(deltaY * ORBIT_ZOOM),
                       orbitNear, ORBIT_DIST[1]);
  }

  // ---- the step --------------------------------------------------------------
  function step(dt) {
    dt = clamp(dt, 0, DT_MAX);
    if (tween) { tween.t += dt / (tween.dur || TWEEN_S); if (tween.t >= 1) tween = null; }
    if (mode !== 'walk') return;

    const run = keys.has('ShiftLeft') || keys.has('ShiftRight');
    const speed = fly ? (run ? FLY_RUN : FLY) : (run ? RUN : WALK);
    const f = forward();
    const h = Math.hypot(f[0], f[1]) || 1;
    const flat = [f[0] / h, f[1] / h, 0];
    const right = [flat[1], -flat[0], 0];
    const d = [0, 0, 0];
    const add = (v, k) => { d[0] += v[0] * k; d[1] += v[1] * k; d[2] += v[2] * k; };
    if (keys.has('KeyW') || keys.has('ArrowUp')) add(fly ? f : flat, 1);
    if (keys.has('KeyS') || keys.has('ArrowDown')) add(fly ? f : flat, -1);
    if (keys.has('KeyD') || keys.has('ArrowRight')) add(right, 1);
    if (keys.has('KeyA') || keys.has('ArrowLeft')) add(right, -1);
    // Rise and fall belong to flight. On foot the terrain sets the eye height
    // and the z was thrown away a line later, but only after it had been
    // normalised in: holding space while walking cost 30% of the pace and did
    // nothing else.
    if (fly) {
      if (keys.has('Space')) d[2] += 1;
      if (keys.has('KeyC')) d[2] -= 1;
    }
    // one normalisation, so a diagonal is a step and not 1.41 steps
    const l = Math.hypot(d[0], d[1], d[2]);
    if (l > 0) {
      const k = speed * dt / l;
      const mx = d[0] * k, my = d[1] * k;
      if (fly || !solid) {
        pos[0] += mx; pos[1] += my;
      } else {
        // Walls, and sliding along them. Trying the whole step, then each axis
        // on its own, is what makes a glancing approach slide instead of
        // stopping dead: without the two fallbacks, walking into Altgeld at any
        // angle other than head-on stops the walker completely.
        if (!isSolid(pos[0] + mx, pos[1] + my)) { pos[0] += mx; pos[1] += my; }
        else {
          if (!isSolid(pos[0] + mx, pos[1])) pos[0] += mx;
          if (!isSolid(pos[0], pos[1] + my)) pos[1] += my;
        }
      }
      pos[2] += d[2] * k;
    }
    keepInside();

    // On foot the eye rides the terrain exactly. Flying keeps clearance rather
    // than a height: the old floor was 1.2 m, so C stopped descending a metre
    // above the grass while the readout still said flying, which is the whole
    // of "C does nothing".
    if (!fly) pos[2] = eyeZ();
    else pos[2] = Math.max(pos[2], groundAt(pos[0], pos[1]) + FLY_FLOOR);
  }

  frameScene();
  pos[2] = eyeZ();
  if (opts.places) setPlaces(opts.places);

  return {
    // constants a test or a heads-up display needs to talk about
    EYE_H, WALK, RUN, FLY, FLY_RUN, FOV, LOOK, DRAG_LOOK, PITCH_MAX, TWEEN_S, DT_MAX,
    setGround, setSolid, setPlaces, setAspect, setViewport, setSky,
    groundAt, camera, streamRadius, step,
    identAt, isSolid, lookingAt, nearby, goTo, focus, pushOut,
    keyDown, keyUp, releaseKeys, look, lookDrag, drag, zoom, pinch, setNearest,
    setMode, toggleMode, home, forward,
    get mode() { return mode; },
    get fly() { return fly; },
    get pos() { return pos; },
    get yaw() { return yaw; },
    get pitch() { return pitch; },
    get orbit() { return orbit; },
    get keys() { return keys; },
    get tweening() { return tween !== null; },
    get altitude() { return pos[2] - groundAt(pos[0], pos[1]); },
    get crop() { return crop; },
    get nearest() { return orbitNear; },
    get zRange() { return zRange.slice(); },
    get skyZ() { return skyZ; },
    get skyFade() { return skyFade(); },
    get places() { return places; },
    get hasSolid() { return solid !== null; },
  };
}

return {create, EYE_H, WALK, RUN, FLY, FLY_RUN, FOV, LOOK, DRAG_LOOK, PITCH_MAX,
        TWEEN_S, DT_MAX, SKY_FADE_M, UNNAMED, HOME, MOVE_KEYS};
});
