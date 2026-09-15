/* =============================================================================
   fakeAR — config.  The only file you normally edit.

   Load order is fixed in index.html:
     p5 -> three r147 -> GLTFLoader -> [RoomEnvironment] -> [DRACOLoader]
        -> config.js -> blendercam.js -> camfeed.js -> arlayer.js
        -> calibtouch.js -> sketch.js
============================================================================= */

/* ------------------------------------------------------------------ logging */
/* Everything reports to the console. On the iPhone: Settings > Safari >
   Advanced > Web Inspector ON, plug into the Mac, then
   Mac Safari > Develop > [your iPhone] > the page.                          */

function flog() {
  if (typeof CFG !== 'undefined' && !CFG.LOG) return;
  var a = Array.prototype.slice.call(arguments);
  a.unshift('[fakeAR]');
  console.log.apply(console, a);
}

function fwarn() {
  var a = Array.prototype.slice.call(arguments);
  a.unshift('[fakeAR]');
  console.warn.apply(console, a);
}

/* ================================================================== SETTINGS */

var CFG = {

  /* ----- assets ----------------------------------------------------------- */
  // Netlify and GitHub Pages are CASE-SENSITIVE; macOS is not. 'Scene.glb'
  // will work locally and 404 live. Keep it lowercase and exact.
  GLB_URL: 'scene.glb',

  /* ----- composition ------------------------------------------------------ */
  // MUST equal Blender's render aspect (resolution_x / resolution_y).
  //
  // FULL SCREEN, iPhone 14 Pro Max -> 1290 x 2796 = 0.461373
  //   Blender: Output Resolution X 1290, Y 2796
  //   REQUIRES "Add to Home Screen" + launch from the icon. In normal Safari
  //   the address bar steals ~190px of height and you get SIDE letterbox bars.
  //   The console prints a warning if that happens.
  //
  //   Because Sensor Fit = Vertical ties the lens to image HEIGHT, going
  //   full-screen from 3:4 keeps your ENTIRE vertical FOV and trims the sides
  //   instead — so your Blender focal length carries over unchanged.
  ASPECT: 1290 / 2796,

  // Portrait 3:4 alternative (letterboxed top and bottom, wider horizontally):
  // ASPECT: 3 / 4,        // Blender: 1080x1440, 1200x1600 or 1440x1920

  // iPhone reports devicePixelRatio 3. 2 looks identical and runs much cooler.
  MAX_DPR: 2,

  /* ----- camera source ---------------------------------------------------- */
  // true  = use the PerspectiveCamera exported inside the GLB  (exact, recommended)
  // false = rebuild it from BLENDER_CAM below
  USE_GLB_CAMERA: true,

  /* ----- video stream ----------------------------------------------------- */
  // Ask for a 4:3-family size. Requesting 16:9 makes iOS crop the sensor
  // vertically, which silently changes your vertical field of view.
  VIDEO_W: 1440,
  VIDEO_H: 1920,

  // iPhone 14 Pro Max exposes ultra-wide / wide / tele as SEPARATE devices, and
  // facingMode picks one for you — not necessarily the same one after an iOS
  // update. Worse, the "Dual"/"Triple" VIRTUAL devices switch physical lenses
  // at runtime based on light level, which changes the FOV mid-experience.
  // The console lists every rear lens on startup: paste a SINGLE-lens deviceId
  // here ("Back Camera", not "Back Dual/Triple Camera") so it can never change.
  DEVICE_ID: null,

  /* ----- lighting --------------------------------------------------------- */
  // All three are ignored when the GLB carries its own lights.
  FALLBACK_LIGHTS: true,
  ENV_LIGHT: true,            // needs RoomEnvironment.js; skipped silently if absent
  ENV_INTENSITY: 0.55,

  /* ----- alignment plate (debug) ------------------------------------------ */
  REF_URL: '',                // e.g. 'reference.jpg' — your Blender background plate
  REF_ALPHA: 0,               // 0 = off, 0.5 = ghosted over the live view

  /* ----- diagnostics ------------------------------------------------------ */
  // The ONLY on-screen text: "tap to start" / "loading..." / error messages.
  // It vanishes the moment the composite runs. Set false for the final install.
  HINT: true,
  LOG: true,

  PLATE_CAPTURE: true,        // 3-finger tap saves the exact camera frame
  CAL_TOUCH: true,           // touch nudging; turn on with ?cal=1
  HIDE3D: false,              // hide the 3D layer; turn on with ?hide3d=1

  KEEP_AWAKE: true,           // request a screen wake lock after start
  WATCHDOG_MS: 8000           // restart the camera if the video stalls this long
};

/* =============================================================================
   CAMERA CALIBRATION — fixes ALIGNMENT (the whole composite at once).
   Solve in this order — each step is nearly independent of the ones below it:

     1. fovScale   Match the SPACING of two features near the left and right
                   edges. This is the dominant term; get it first.
     2. yaw/pitch  Slide the whole image so a central landmark lands.
     3. roll       Level the horizon.
     4. shiftX/Y   Only if the centre matches but the error is lopsided
                   left-vs-right or top-vs-bottom.

   Tune live with ?cal=1 (mode button -> CAM) or via the URL overrides below.

   Once fovScale settles, close the loop properly:
       true_focal = blender_focal / fovScale
   Put that in Blender, re-export, and reset fovScale to 1.00.
============================================================================= */

var CAL = {
  fovScale: 1.00,   // >1 = wider virtual lens (virtual objects get smaller)
  yaw:      0.00,   // deg — look left (-) / right (+)
  pitch:    0.00,   // deg — look down (-) / up (+)
  roll:     0.00,   // deg — rotate the horizon
  shiftX:   0.00,   // principal point, fraction of frame width
  shiftY:   0.00    // principal point, fraction of frame height
};

/* =============================================================================
   OBJECT OFFSETS — fine per-object nudges.

   Your composition lives in Blender; this is only for the last few centimetres
   of "that cloud wants to sit slightly left of the chimney". Applied to a
   PARENT RIG wrapped around each object, so the AnimationMixer still drives the
   object's own transform and the two never fight.

   Keys are TOP-LEVEL object names from Blender (exactly as in the Outliner —
   the console prints the list on load). Values are metres in the GLB's Y-up
   space. Populate by nudging in ?cal=1 and tapping "copy".

   Two accepted forms:
     "Name": [x, y, z]
     "Name": { pos:[x,y,z], quat:[x,y,z,w], scale:1 }

   PREFERRED WORKFLOW: "copy" also prints the same deltas in BLENDER Z-up, so
   you can type them into Blender, re-export, and empty this object again —
   keeping Blender as the single source of truth.
       blender_x =  glTF_x
       blender_y = -glTF_z
       blender_z =  glTF_y
============================================================================= */

var OBJ_OFFSETS = {
  // "Cloud.001": [0.04, -0.02, 0.00],
};

/* =============================================================================
   BLENDER_CAM — only read when USE_GLB_CAMERA is false, or when the GLB turns
   out to contain no camera.

   Paste this into Blender's Scripting workspace and run it:

     import bpy
     c = bpy.data.objects['Camera']; d = c.data; r = bpy.context.scene.render
     print('focal      ', d.lens)
     print('sensor_w/h ', d.sensor_width, d.sensor_height)
     print('sensor_fit ', d.sensor_fit)
     print('loc        ', list(c.location))
     print('rotDeg     ', [a*57.29577951 for a in c.rotation_euler])
     print('rot_mode   ', c.rotation_mode, '  <- must be XYZ')
     print('shift      ', d.shift_x, d.shift_y)
     print('clip       ', d.clip_start, d.clip_end)
     print('render     ', r.resolution_x, r.resolution_y, r.resolution_percentage)

   iPhone 14 Pro Max main (1x) camera, Sensor Fit = Vertical, Size 36:
     still photo at 1x (theoretical)   72.1 deg  ->  24.7 mm
     BROWSER VIDEO via getUserMedia   ~65.5 deg  ->  ~28 mm   <- start here
   (video adds an ~8-12% stabilisation crop that Apple does not publish)
============================================================================= */

var BLENDER_CAM = {
  focal: 28,              // Camera data > Lens > Focal Length (mm)

  // WHICH sensor number goes here depends on sensorFit:
  //   'HORIZONTAL' or 'AUTO'  ->  sensor_width   (Blender default 36)
  //   'VERTICAL'              ->  sensor_height  (Blender default 24)
  // Recommended: set Blender to VERTICAL with Size 36, and put 36 here. Then
  // vFOV = 2*atan(18/focal) exactly, with no aspect-dependent surprises.
  sensor: 36,
  sensorFit: 'VERTICAL',  // 'AUTO' | 'HORIZONTAL' | 'VERTICAL'

  renderW: 1290,          // Output > Resolution X  (after the % scale)
  renderH: 2796,          // Output > Resolution Y

  loc: [0, -6, 1.6],      // Object > Transform > Location  (Blender, Z-up, metres)
  rotDeg: [90, 0, 0],     // Object > Transform > Rotation  (XYZ Euler, degrees)

  shiftX: 0,              // Camera data > Lens > Shift X
  shiftY: 0,              // Camera data > Lens > Shift Y

  near: 0.1,              // Clip Start
  far: 3000               // Clip End
};

/* =============================================================================
   URL OVERRIDES
   Hosts cache aggressively, so redeploying for every 0.01 is miserable.
   Tune live on the mounted phone by editing the URL:

     ?cal=1                          touch nudging + readout + buttons
     ?fov=1.03&yaw=0.4&pitch=-1.2    numeric camera nudges
     ?ref=0.5                        ghost the reference plate (needs REF_URL)
     ?hide3d=1&hint=0                clean camera view -> screenshot = plate
     ?glb=scene-v2                   load an alternate GLB
     ?aspect=0.4614                  try a different composition aspect
     ?hint=0  ?nolog=1  ?dpr=1

   When you're happy, paste the values into CAL / OBJ_OFFSETS and deploy once.
============================================================================= */

(function () {
  if (!window.URLSearchParams) return;
  var q = new URLSearchParams(location.search);
  if (!q.toString()) return;

  function num(key, obj, prop) {
    if (!q.has(key)) return;
    var v = parseFloat(q.get(key));
    if (!isNaN(v)) obj[prop] = v;
  }

  num('fov',    CAL, 'fovScale');
  num('yaw',    CAL, 'yaw');
  num('pitch',  CAL, 'pitch');
  num('roll',   CAL, 'roll');
  num('shiftx', CAL, 'shiftX');
  num('shifty', CAL, 'shiftY');
  num('ref',    CFG, 'REF_ALPHA');
  num('dpr',    CFG, 'MAX_DPR');
  num('aspect', CFG, 'ASPECT');

  if (q.has('glb'))    CFG.GLB_URL   = q.get('glb') + '.glb';
  if (q.has('hint'))   CFG.HINT      = (q.get('hint')   !== '0');
  if (q.has('nolog'))  CFG.LOG       = false;
  if (q.has('cal'))    CFG.CAL_TOUCH = (q.get('cal')    !== '0');
  if (q.has('hide3d')) CFG.HIDE3D    = (q.get('hide3d') !== '0');

  flog('URL overrides applied:', q.toString());
})();