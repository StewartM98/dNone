/* =============================================================================
   fakeAR — three.js layer (the transparent canvas that sits over the video)

   Written against three r147:
     renderer.outputEncoding / THREE.sRGBEncoding   (renamed in r152+)
     THREE.GLTFLoader from examples/js              (removed in r148+)
============================================================================= */

var ARLayer = {

  renderer: null,
  scene: null,
  cam: null,
  clock: null,
  mixer: null,
  actions: [],

  dupMixers: [],            // one AnimationMixer per duplicated object
  gltfScene: null,          // the loaded GLB root — calibtouch.js picks from this
  paused: false,

  loaded: false,
  loadError: null,
  initError: null,
  clipCount: 0,
  camSource: '',

  // The authored pose + lens, before CAL deltas are applied.
  basePos: null,
  baseQuat: null,
  baseFov: 50,
  baseShift: { x: 0, y: 0 },

  /* ------------------------------------------------------------------- init */
  init: function (canvasEl) {
    if (typeof THREE === 'undefined') {
      this.initError = 'three.js did not load';
      fwarn(this.initError + ' — check the CDN <script> tag in index.html');
      return false;
    }

    try {
      this.renderer = new THREE.WebGLRenderer({
        canvas: canvasEl,
        alpha: true,             // <- transparent, so the video shows through
        antialias: true,
        premultipliedAlpha: true
      });
    } catch (e) {
      this.initError = 'WebGL unavailable';
      fwarn(this.initError, e);
      return false;
    }

    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setClearAlpha(0);
    this.renderer.outputEncoding = THREE.sRGBEncoding;
    // No tone mapping. Set Blender > Render > Color Management >
    // View Transform = "Standard" so brightness matches what you authored.
    this.renderer.toneMapping = THREE.NoToneMapping;

    this.scene = new THREE.Scene();
    this.scene.background = null;

    // Deliberately NOT added to the scene: with camera.parent === null the
    // renderer updates its world matrix itself, and nothing inside the GLB
    // hierarchy can ever move it.
    this.cam = new THREE.PerspectiveCamera(50, CFG.ASPECT, 0.1, 3000);

    this.basePos = new THREE.Vector3();
    this.baseQuat = new THREE.Quaternion();
    this.clock = new THREE.Clock();

    this.applyCalibration();
    flog('three r' + THREE.REVISION + ' ready');
    return true;
  },

  /* ----------------------------------------------------------------- sizing */
  setSize: function (cssW, cssH, dpr) {
    if (!this.renderer) return;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(cssW, cssH, true);   // true => also writes CSS size
    // aspect stays LOCKED to CFG.ASPECT, never to the screen — that is what
    // preserves the Blender framing on every device.
    this.applyCalibration();
  },

  /* ------------------------------------------------------------- GLB loader */
  load: function (url) {
    var self = this;

    if (!THREE.GLTFLoader) {
      this.loadError = 'GLTFLoader.js not loaded';
      fwarn(this.loadError + ' — check the r147 examples/js <script> tag.');
      return;
    }

    var loader = new THREE.GLTFLoader();

    // Only needed if you enabled compression on export. Harmless otherwise.
    if (THREE.DRACOLoader) {
      var d = new THREE.DRACOLoader();
      d.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.147.0/examples/js/libs/draco/');
      loader.setDRACOLoader(d);
    }
    if (typeof MeshoptDecoder !== 'undefined' && loader.setMeshoptDecoder) {
      loader.setMeshoptDecoder(MeshoptDecoder);
    }

    var ok = function (gltf) {
      try {
        self._onLoad(gltf);
      } catch (e) {
        self.loadError = 'GLB loaded but failed to set up';
        fwarn(self.loadError, e);
      }
    };

    /* ---- embedded base64 fallback (only if you ever add glbdata.js) ------ */
    if (typeof GLB_B64 !== 'undefined' && GLB_B64 && GLB_B64.length > 64) {
      try {
        var buf = this._b64ToArrayBuffer(GLB_B64);
        flog('parsing embedded GLB —', (buf.byteLength / 1048576).toFixed(2), 'MB');
        loader.parse(buf, '', ok, function (err) {
          self.loadError = 'embedded GLB failed to parse';
          fwarn(self.loadError, err);
        });
      } catch (e) {
        this.loadError = 'GLB_B64 is not valid base64';
        fwarn(this.loadError, e);
      }
      return;
    }

    /* ---- normal path: fetch the local file ------------------------------ */
    if (!url) {
      this.loadError = 'no GLB source — set CFG.GLB_URL';
      fwarn(this.loadError);
      return;
    }

    flog('loading', url);

    loader.load(url, ok,
      function (e) {
        if (e && e.lengthComputable) {
          flog('glb', Math.round(100 * e.loaded / e.total) + '%',
               '(' + (e.total / 1048576).toFixed(2) + ' MB)');
        }
      },
      function (err) {
        self.loadError = 'GLB failed: ' + url;
        fwarn(self.loadError, err);
        flog('checks:');
        flog('  - filename matches EXACTLY (GitHub Pages is case-sensitive)');
        flog('  - the file is at the repo root, next to index.html');
        flog('  - the path has no leading slash');
        flog('  - it is a single self-contained .glb, not .gltf + .bin');
        flog('  - it is NOT in Git LFS (Pages serves the pointer file)');
        flog('  - you are on http(s), not file://');
      }
    );
  },

  _onLoad: function (gltf) {
    this.scene.add(gltf.scene);
    this.gltfScene = gltf.scene;
    gltf.scene.updateMatrixWorld(true);

    /* ---- camera --------------------------------------------------------- */
    var glbCam = null;
    if (CFG.USE_GLB_CAMERA && gltf.cameras) {
      for (var i = 0; i < gltf.cameras.length; i++) {
        if (gltf.cameras[i].isPerspectiveCamera) { glbCam = gltf.cameras[i]; break; }
      }
    }

    if (glbCam) {
      // glTF stores yfov (vertical FOV), which is exactly PerspectiveCamera.fov.
      // The Blender exporter computes it for the render aspect at export time,
      // so rendering at that same aspect reproduces Blender's projection exactly.
      glbCam.updateMatrixWorld(true);
      glbCam.matrixWorld.decompose(this.basePos, this.baseQuat, new THREE.Vector3());
      this.baseFov = glbCam.fov;
      this.baseShift = { x: 0, y: 0 };        // glTF cannot carry lens shift
      this.cam.near = glbCam.near || 0.1;
      this.cam.far = glbCam.far || 3000;
      this.camSource = 'GLB';

      if (glbCam.aspect && Math.abs(glbCam.aspect - CFG.ASPECT) > 0.01) {
        fwarn('GLB camera aspect ' + glbCam.aspect.toFixed(4) +
              ' != CFG.ASPECT ' + CFG.ASPECT.toFixed(4) +
              ' — Blender rendered at a different shape. With Sensor Fit = ' +
              'Vertical the vertical FOV still matches, but you will see MORE ' +
              'or LESS horizontally than you composed. Set Blender\'s Output ' +
              'resolution to match CFG.ASPECT.');
      }
      if (BLENDER_CAM.shiftX || BLENDER_CAM.shiftY) {
        fwarn('your Blender camera uses lens shift, which glTF does not export. ' +
              'Either set USE_GLB_CAMERA:false, or dial it in with ' +
              'CAL.shiftX / CAL.shiftY.');
      }

      // Detach so no animation track and no animated parent can move it.
      if (glbCam.parent) glbCam.parent.remove(glbCam);

    } else {
      this.baseFov = BL.fovY(BLENDER_CAM) * 180 / Math.PI;
      this.baseShift = BL.shiftFrac(BLENDER_CAM);
      BL.transform(BLENDER_CAM, this.basePos, this.baseQuat);
      this.cam.near = BLENDER_CAM.near;
      this.cam.far = BLENDER_CAM.far;
      this.camSource = 'BLENDER_CAM';

      if (CFG.USE_GLB_CAMERA) {
        fwarn('no camera found in the GLB — falling back to BLENDER_CAM. ' +
              'Re-export with Include > Cameras ticked for an exact match.');
      }
    }

    this.applyCalibration();
    flog('camera from', this.camSource,
         '| authored vFOV', this.baseFov.toFixed(3) + 'deg',
         '| effective', this.cam.fov.toFixed(3) + 'deg',
         '| pos', this.basePos.x.toFixed(2) + ',' +
                  this.basePos.y.toFixed(2) + ',' +
                  this.basePos.z.toFixed(2));

    /* ---- animations: play EVERY clip ------------------------------------ */
    var clips = gltf.animations || [];
    this.clipCount = clips.length;

    if (clips.length) {
      this.mixer = new THREE.AnimationMixer(gltf.scene);
      for (var c = 0; c < clips.length; c++) {
        var a = this.mixer.clipAction(clips[c]);
        a.setLoop(THREE.LoopRepeat, Infinity);
        a.clampWhenFinished = false;
        a.enabled = true;
        a.play();
        this.actions.push(a);
      }
      flog(clips.length + ' clip(s): ' + clips.map(function (k) {
        return k.name + ' (' + k.duration.toFixed(2) + 's, ' +
               k.tracks.length + ' tracks)';
      }).join(', '));
    } else {
      fwarn('no animations in the GLB. In Blender check: Animation ticked, ' +
            '"Always Sample Animations" ON, "Optimize Animation Size" OFF, ' +
            'and that the scene frame range covers your loop.');
    }

    if (glbCam) this._warnIfCameraAnimated(glbCam, clips);

    /* ---- top-level names (use these as OBJ_OFFSETS / DUPLICATES keys) ---- */
    var tops = [];
    for (var t = 0; t < gltf.scene.children.length; t++) {
      var nm = gltf.scene.children[t];
      if (nm.name) tops.push(nm.name);
    }
    if (tops.length) flog('top-level objects: ' + tops.join(', '));

    /* ---- lights --------------------------------------------------------- */
    var hasLight = false;
    var meshes = 0;
    gltf.scene.traverse(function (o) {
      if (o.isLight) hasLight = true;
      if (o.isMesh || o.isSkinnedMesh) {
        meshes++;
        // Animated objects can drift far from their bind-pose bounds and get
        // culled wrongly. Cheap insurance for a small scene.
        o.frustumCulled = false;
        o.castShadow = false;
        o.receiveShadow = false;
      }
    });
    flog(meshes + ' mesh(es)', hasLight ? '| GLB has its own lights' : '| no lights in GLB');

    if (!hasLight && CFG.FALLBACK_LIGHTS) {
      var dir = new THREE.DirectionalLight(0xffffff, 2.0);
      dir.position.set(3, 6, 4);
      this.scene.add(new THREE.HemisphereLight(0xbfd7ff, 0x30302c, 1.4));
      this.scene.add(dir);
      flog('added fallback hemisphere + directional lights');
    }

    if (!hasLight && CFG.ENV_LIGHT && THREE.RoomEnvironment && THREE.PMREMGenerator) {
      var pm = new THREE.PMREMGenerator(this.renderer);
      this.scene.environment = pm.fromScene(new THREE.RoomEnvironment(), 0.04).texture;
      pm.dispose();
      var k = CFG.ENV_INTENSITY;
      gltf.scene.traverse(function (o) {
        if (o.isMesh && o.material && 'envMapIntensity' in o.material) {
          o.material.envMapIntensity = k;
        }
      });
      flog('added RoomEnvironment IBL @', k);
    }

    this.loaded = true;
    this.loadError = null;
  },

  _warnIfCameraAnimated: function (glbCam, clips) {
    var names = {};
    var n = glbCam;
    while (n) { if (n.name) names[n.name] = true; n = n.parent; }
    for (var i = 0; i < clips.length; i++) {
      for (var t = 0; t < clips[i].tracks.length; t++) {
        if (names[clips[i].tracks[t].name.split('.')[0]]) {
          fwarn('the exported camera (or one of its parents) is ANIMATED. ' +
                'A fixed mount needs a static camera — its frame-0 pose is ' +
                'being used. Delete its keyframes in Blender.');
          return;
        }
      }
    }
  },

  /* --------------------------------------------------------- CAL -> camera */
  applyCalibration: function () {
    if (!this.cam) return;
    var D = Math.PI / 180, R = 180 / Math.PI;

    // 1. lens: scale tan(fov/2), so the change is linear in screen space
    var baseRad = this.baseFov * D;
    var eff = 2 * Math.atan(Math.tan(baseRad * 0.5) * (CAL.fovScale || 1));
    this.cam.fov = eff * R;
    this.cam.aspect = CFG.ASPECT;

    // 2. principal point (Blender lens shift + live nudge), via setViewOffset.
    //    +x slides the frustum right, so content appears to move LEFT.
    //    Blender's +shift_y moves content DOWN while three's +offsetY moves it
    //    UP, hence the sign flip on Y.
    var fx = this.baseShift.x + (CAL.shiftX || 0);
    var fy = this.baseShift.y + (CAL.shiftY || 0);
    if (fx !== 0 || fy !== 0) {
      var W = 1000, H = Math.round(1000 / CFG.ASPECT);
      this.cam.setViewOffset(W, H, fx * W, -fy * H, W, H);
    } else if (this.cam.view) {
      this.cam.clearViewOffset();
    }
    this.cam.updateProjectionMatrix();

    // 3. orientation: small deltas in the camera's OWN frame
    var dq = new THREE.Quaternion().setFromEuler(new THREE.Euler(
      (CAL.pitch || 0) * D,
      (CAL.yaw   || 0) * D,
      (CAL.roll  || 0) * D,
      'YXZ'
    ));
    this.cam.quaternion.copy(this.baseQuat).multiply(dq);
    this.cam.position.copy(this.basePos);
    this.cam.updateMatrixWorld(true);
  },

  /* ------------------------------------------------------------------ frame */
  // Duplicated objects each own a mixer, so pause/resume must reach those too.
  setPaused: function (p) {
    this.paused = !!p;

    for (var i = 0; i < this.actions.length; i++) {
      this.actions[i].paused = this.paused;
    }

    for (var d = 0; d < this.dupMixers.length; d++) {
      var m = this.dupMixers[d];
      var acts = m._actions || [];
      for (var j = 0; j < acts.length; j++) acts[j].paused = this.paused;
    }
  },

  update: function (dt) {
    if (this.paused) return;
    if (this.mixer) this.mixer.update(dt);
    for (var i = 0; i < this.dupMixers.length; i++) {
      this.dupMixers[i].update(dt);
    }
  },

  render: function () {
    if (this.renderer && this.scene && this.cam) {
      this.renderer.render(this.scene, this.cam);
    }
  },

  /* base64 (or a data: URL) -> ArrayBuffer */
  _b64ToArrayBuffer: function (b64) {
    var s = String(b64).replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
    var bin = atob(s);
    var n = bin.length;
    var bytes = new Uint8Array(n);
    for (var i = 0; i < n; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }
};
