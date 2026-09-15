/* =============================================================================
   fakeAR — p5 sketch

   One draw loop, two stacked canvases inside a CFG.ASPECT box:

       p5 2D canvas   z1   <- the live rear camera, cropped to CFG.ASPECT
       WebGL canvas   z2   <- transparent three.js composite
       reference img  z3   <- optional alignment plate
       nudge readout  z20  <- only with ?cal=1

   Tap anywhere once to start (iOS requires a gesture for camera access).
   3-finger tap captures the exact camera frame for Blender.
   ?cal=1 hands all touch to calibtouch.js.
============================================================================= */

var host, glCanvas, refEl;
var wdTime = 0, wdSeen = -1;
var wakeLock = null;
var plateEl = null;

/* -------------------------------------------------------------------- setup */
function setup() {
  var b = fitBox();

  // Baseline page styling, so the sketch survives a bare index.html too.
  var hs = document.documentElement.style, bs = document.body.style;
  hs.margin = bs.margin = '0';
  hs.padding = bs.padding = '0';
  bs.background = '#000';
  bs.overflow = 'hidden';
  bs.touchAction = 'none';
  bs.userSelect = bs.webkitUserSelect = 'none';
  bs.webkitTouchCallout = 'none';
  bs.webkitTapHighlightColor = 'transparent';

  // Wrapper so every layer shares one identical box.
  host = document.createElement('div');
  host.style.position = 'fixed';
  host.style.left = '0';
  host.style.top = '0';
  host.style.overflow = 'hidden';
  host.style.background = '#000';
  document.body.appendChild(host);

  // Layer 1 — p5 2D canvas. Set only position/z-index; let p5 own width/height.
  var c = createCanvas(b.w, b.h);
  pixelDensity(Math.min(window.devicePixelRatio || 1, CFG.MAX_DPR));
  c.parent(host);
  c.elt.style.position = 'absolute';
  c.elt.style.left = '0';
  c.elt.style.top = '0';
  c.elt.style.zIndex = '1';

  // Layer 2 — three.js. setSize() owns its width/height styles.
  glCanvas = document.createElement('canvas');
  glCanvas.style.position = 'absolute';
  glCanvas.style.left = '0';
  glCanvas.style.top = '0';
  glCanvas.style.zIndex = '2';
  glCanvas.style.pointerEvents = 'none';
  host.appendChild(glCanvas);

  // Layer 3 — optional Blender plate, for alignment only.
  if (CFG.REF_URL && CFG.REF_ALPHA > 0) {
    refEl = document.createElement('img');
    refEl.src = CFG.REF_URL;
    refEl.draggable = false;
    refEl.style.position = 'absolute';
    refEl.style.left = '0';
    refEl.style.top = '0';
    refEl.style.width = '100%';
    refEl.style.height = '100%';
    refEl.style.objectFit = 'fill';        // the plate is already CFG.ASPECT
    refEl.style.zIndex = '3';
    refEl.style.pointerEvents = 'none';
    refEl.style.opacity = String(CFG.REF_ALPHA);
    host.appendChild(refEl);
    refEl.onerror = function () { fwarn('reference image not found:', CFG.REF_URL); };
    flog('reference plate on @ alpha', CFG.REF_ALPHA);
  }

  textAlign(CENTER, CENTER);
  noStroke();
  background(0);

  // Preload the GLB now — a fetch needs no user gesture.
  if (ARLayer.init(glCanvas)) ARLayer.load(CFG.GLB_URL);

  layout();

  window.addEventListener('orientationchange', function () {
    setTimeout(layout, 350);
  });
  document.addEventListener('visibilitychange', onVisibility);

  if (typeof CalTouch !== 'undefined') CalTouch.init();

  /* ---- viewport report: confirms whether full-screen is actually possible */
  var standalone = !!(window.navigator.standalone);
  var vAsp = window.innerWidth / window.innerHeight;
  flog('viewport', window.innerWidth + 'x' + window.innerHeight,
       '| aspect', vAsp.toFixed(6),
       '| CFG.ASPECT', CFG.ASPECT.toFixed(6),
       '| dpr', window.devicePixelRatio,
       '| standalone', standalone);
  flog('stage', b.w + 'x' + b.h);

  if (CFG.ASPECT < vAsp - 0.005 && !standalone) {
    fwarn('CFG.ASPECT (' + CFG.ASPECT.toFixed(4) + ') is narrower than this ' +
          'viewport (' + vAsp.toFixed(4) + '), so you get SIDE letterbox bars. ' +
          'Safari\'s address bar is stealing height — use Share > Add to Home ' +
          'Screen and launch from the icon for true full screen.');
  }

  flog('ready — tap to start' +
       (CFG.PLATE_CAPTURE ? '  (3-finger tap = capture plate)' : '') +
       (CFG.CAL_TOUCH ? '  (?cal=1: drag to nudge objects)' : ''));
}

/* ------------------------------------------------------------------- layout */
// Largest CFG.ASPECT box that fits the viewport, centred, letterboxed black.
function fitBox() {
  var w = windowWidth;
  var h = Math.round(windowWidth / CFG.ASPECT);
  if (h > windowHeight) {
    h = windowHeight;
    w = Math.round(windowHeight * CFG.ASPECT);
  }
  return {
    w: w, h: h,
    x: Math.round((windowWidth - w) / 2),
    y: Math.round((windowHeight - h) / 2)
  };
}

function layout() {
  var b = fitBox();

  host.style.left = b.x + 'px';
  host.style.top = b.y + 'px';
  host.style.width = b.w + 'px';
  host.style.height = b.h + 'px';

  resizeCanvas(b.w, b.h);
  ARLayer.setSize(b.w, b.h, pixelDensity());
  CamFeed.updateCrop();
}

function windowResized() { layout(); }

/* ------------------------------------------------------------ tap to start */
// With ?cal=1, calibtouch.js owns touch — including starting the camera and the
// 3-finger plate capture — so we must not double-handle here.
function touchStarted() {
  if (CFG.CAL_TOUCH) return false;
  if (CFG.PLATE_CAPTURE && touches.length >= 3) { savePlate(); return false; }
  begin();
  return false;
}

function mousePressed() {
  if (CFG.CAL_TOUCH) return;
  begin();
}

function begin() {
  if (plateEl) return;                       // plate viewer is open
  if (CamFeed.ready || CamFeed.starting) return;
  CamFeed.start();
  if (CFG.KEEP_AWAKE) keepAwake();
}

function keepAwake() {
  if (wakeLock || !navigator.wakeLock) return;
  navigator.wakeLock.request('screen').then(function (wl) {
    wakeLock = wl;
    wl.addEventListener('release', function () { wakeLock = null; });
    flog('wake lock acquired');
  }).catch(function () { /* unsupported or battery saver */ });
}

/* --------------------------------------------------------------------- draw */
function draw() {
  // Pull the delta every frame so it can never accumulate while idling.
  var dt = ARLayer.clock ? Math.min(ARLayer.clock.getDelta(), 0.05) : 0;

  var v = CamFeed.video;
  var cr = CamFeed.crop;

  if (!CamFeed.ready || !v || !v.videoWidth || cr.sw <= 0) {
    background(0);
    hint(statusText(), height / 2);
    return;
  }

  // ---- layer 1: live rear camera, cropped to CFG.ASPECT, UNMIRRORED --------
  var ctx = drawingContext;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(v, cr.sx, cr.sy, cr.sw, cr.sh, 0, 0, width, height);

  // ---- layer 2: transparent 3D composite ----------------------------------
  if (ARLayer.loaded) {
    ARLayer.update(dt);
    if (!CFG.HIDE3D) ARLayer.render();
    else ARLayer.renderer.clear();
  } else if (ARLayer.loadError) {
    hint(ARLayer.loadError, height - height * 0.06);
  } else {
    hint('loading 3D...', height - height * 0.06);
  }

  watchdog(v);
}

/* --------------------------------------------------------------------- text */
// The ONLY on-screen text. Set CFG.HINT = false once installed.
function statusText() {
  if (ARLayer.initError) return ARLayer.initError;
  if (CamFeed.error) return CamFeed.error;
  if (CamFeed.starting) return 'starting camera...';
  if (ARLayer.loadError) return ARLayer.loadError + '  —  tap to start';
  if (!ARLayer.loaded) return 'loading 3D...  —  tap to start';
  return 'tap to start';
}

function hint(msg, y) {
  if (!CFG.HINT || !msg) return;
  if (msg.length > 110) msg = msg.slice(0, 107) + '...';
  push();
  noStroke();
  fill(255, 140);
  textAlign(CENTER, CENTER);
  textSize(Math.max(11, width * 0.030));
  text(msg, width * 0.06, y, width * 0.88);
  pop();
}

/* ------------------------------------------- 3-finger tap: capture the plate
   Saves the EXACT crop of the browser's own stream at native resolution.
   A Camera-app photo is optically a DIFFERENT image (different sensor crop,
   stabilisation crop, sometimes a different lens), whereas this IS the pipeline
   you are compositing into. Solve Blender against it and fovScale lands near 1.

   Uses the iOS SHARE SHEET ("Save Image") because long-pressing a blob: URL
   often refuses to save, and a data: URL long-presses far more reliably.

   Simpler alternative: open ?hide3d=1&hint=0 and take a normal iOS screenshot
   — at full screen there is nothing to crop.
============================================================================= */

function savePlate() {
  if (plateEl) { closePlate(); return; }

  var v = CamFeed.video, cr = CamFeed.crop;
  if (!v || !v.videoWidth || cr.sw <= 0) {
    fwarn('no frame to capture yet — tap once to start the camera first');
    return;
  }

  var c = document.createElement('canvas');
  c.width = Math.round(cr.sw);
  c.height = Math.round(cr.sh);
  var g = c.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);          // explicitly un-mirrored
  g.drawImage(v, cr.sx, cr.sy, cr.sw, cr.sh, 0, 0, c.width, c.height);

  var name = 'fakeAR-plate-' + c.width + 'x' + c.height + '.png';

  // toDataURL is SYNCHRONOUS, so the user gesture is still live for share().
  var dataURL = c.toDataURL('image/png');

  // 1. iOS share sheet -> "Save Image". Most reliable route on iOS 15+.
  try {
    var bin = atob(dataURL.split(',')[1]);
    var u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    var file = new File([u8], name, { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: name }).catch(function () {});
      flog('share sheet opened — choose "Save Image"');
    }
  } catch (e) { /* older iOS, or File unsupported */ }

  // 2. Show it regardless.
  plateEl = document.createElement('img');
  plateEl.src = dataURL;
  plateEl.style.cssText =
    'position:fixed;left:0;top:0;width:100%;height:100%;object-fit:contain;' +
    'background:#000;z-index:99;';
  plateEl.addEventListener('click', closePlate);
  document.body.appendChild(plateEl);

  // 3. Desktop: straight download.
  if (!/iP(hone|ad|od)/.test(navigator.userAgent)) {
    var a = document.createElement('a');
    a.href = dataURL;
    a.download = name;
    a.click();
  }

  flog('plate ' + c.width + 'x' + c.height + ' captured');
  flog('  Blender: set Output resolution to EXACTLY ' + c.width + 'x' + c.height);
  flog('  tap the image to close');
}

function closePlate() {
  if (!plateEl) return;
  if (plateEl.parentNode) plateEl.parentNode.removeChild(plateEl);
  plateEl = null;
}

/* --------------------------------------------------------------- resilience */
// iOS suspends or kills camera tracks on backgrounding, calls and thermal events.
function watchdog(v) {
  if (v.currentTime !== wdSeen) {
    wdSeen = v.currentTime;
    wdTime = millis();
    return;
  }
  if (millis() - wdTime > CFG.WATCHDOG_MS) {
    wdTime = millis();
    fwarn('video stalled for ' + CFG.WATCHDOG_MS + 'ms — restarting camera');
    CamFeed.restart();
  }
}

function onVisibility() {
  if (document.visibilityState !== 'visible') return;
  if (CFG.KEEP_AWAKE) keepAwake();

  if (CamFeed.video && !CamFeed.isLive()) {
    fwarn('track died while hidden — restarting');
    CamFeed.restart();
  } else if (CamFeed.video) {
    CamFeed.video.play().catch(function () {});
  }
  layout();
}