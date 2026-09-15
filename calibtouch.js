/* =============================================================================
   fakeAR — place objects, duplicate them, hide the UI

   OBJ mode (default):
     drag anywhere    -> move the SELECTED object, parallel to the screen
     tap on an object -> select it
     pinch            -> nearer / further  (or scale, via the "pinch" button)
     two-finger twist -> rotate about the view axis
     "next"           -> cycle selection
     "step"           -> drag sensitivity 1x / 0.25x / 0.05x
     "dup"            -> duplicate the selection (offset so you can see it);
                         the copy becomes the selection
     "del"            -> delete the selected duplicate (originals are protected)
     "hide"           -> collapse the UI to a small dot; tap the dot to restore

   CAM mode ("mode" button) — whole-composite alignment:
     drag  -> yaw / pitch      pinch -> fovScale      twist -> roll

   3-finger tap -> capture calibration plate.

   Offsets live on a parent RIG wrapped around each top-level object, so the
   AnimationMixer keeps driving the object itself and the two never fight.

   With CFG.CAL_TOUCH false this still runs, purely to apply OBJ_OFFSETS and
   spawn DUPLICATES — so your placements persist in the shipped build.
============================================================================= */

var CalTouch = {

  /* flip if a gesture feels inverted */
  DRAG_X: 1,
  DRAG_Y: 1,
  TWIST: 1,

  STEPS: [1, 0.25, 0.05],
  _stepIdx: 0,

  pinchMode: 'depth',        // 'depth' | 'scale'

  on: false,
  mode: 'obj',
  ready: false,
  hidden: false,

  _baseCal: null,
  _list: [],                 // selectable top-level nodes (originals + copies)
  _rigs: {},                 // key -> rig Group
  _dups: [],                 // { key, src, node, rig, tOff }
  _dupN: 0,
  _idx: -1,
  _sel: null,                // selected rig
  _selKey: '',
  _selIsDup: false,

  _ui: null,
  _out: null,
  _dot: null,
  _pauseBtn: null,
  _delBtn: null,

  _g: null,                  // active gesture snapshot
  _moved: false,
  _ray: null,
  _v2: null,

  /* ------------------------------------------------------------------- init */
  init: function () {
    if (typeof THREE === 'undefined' || !ARLayer.cam) return;

    this._baseCal = JSON.parse(JSON.stringify(CAL));
    this._ray = new THREE.Raycaster();
    this._v2 = new THREE.Vector2();
    this.on = !!CFG.CAL_TOUCH;

    var self = this;
    var t0 = Date.now();
    var poll = setInterval(function () {
      if (ARLayer.loaded) {
        clearInterval(poll);
        self._build();
      } else if (Date.now() - t0 > 30000) {
        clearInterval(poll);
        fwarn('CalTouch: GLB never loaded');
      }
    }, 120);

    if (this.on) this._listen();
  },

  _build: function () {
    this.ready = true;

    // Wrap every top-level object that has geometry under it.
    var root = ARLayer.gltfScene;
    this._list = [];
    for (var i = 0; i < root.children.length; i++) {
      var node = root.children[i];
      if (node.userData.__isRig) node = node.children[0];
      if (!node) continue;
      var hasMesh = false;
      node.traverse(function (o) { if (o.isMesh || o.isSkinnedMesh) hasMesh = true; });
      if (!hasMesh) continue;
      this._rigOf(node);
      this._list.push(node);
    }

    flog('placeable objects (' + this._list.length + '): ' +
         this._list.map(function (n) { return n.name || '(unnamed)'; }).join(', '));

    this._applyStored();
    this._spawnStoredDuplicates();

    if (!this.on) return;

    if (CFG.CAL_UI !== false) {
      this._makeUI();
      this._restore();
      if (this._list.length) this._pick(0);
      ARLayer.setPaused(true);          // much easier to place a still object
      if (this._pauseBtn) this._pauseBtn.textContent = 'play';
      flog('PLACEMENT MODE — drag anywhere to move "' + this._selKey + '".');
      flog('  "dup" duplicates it. "hide" collapses this UI. "copy" exports.');
    } else {
      this._restore();
      if (this._list.length) this._pick(0);
    }
  },

  /* ------------------------------------------------------------- rig / apply */
  _rigOf: function (node, key) {
    if (!node) return null;
    if (node.parent && node.parent.userData.__isRig) return node.parent;

    var k = key || node.name || 'obj';
    var parent = node.parent;
    var g = new THREE.Group();
    g.name = '__rig_' + k;
    g.userData.__isRig = true;
    g.userData.__key = k;
    parent.add(g);
    g.add(node);                        // reparent, preserving local transform
    this._rigs[k] = g;
    return g;
  },

  _rigByKey: function (key) {
    if (this._rigs[key]) return this._rigs[key];
    var root = ARLayer.gltfScene;
    if (!root) return null;
    for (var i = 0; i < root.children.length; i++) {
      var c = root.children[i];
      if (c.userData.__isRig && c.userData.__key === key) return c;
      if (c.name === key) return this._rigOf(c);
    }
    return null;
  },

  _applyStored: function () {
    if (typeof OBJ_OFFSETS === 'undefined') return;
    var n = 0;
    for (var name in OBJ_OFFSETS) {
      if (!OBJ_OFFSETS.hasOwnProperty(name)) continue;
      var rig = this._rigByKey(name);
      if (!rig) {
        fwarn('OBJ_OFFSETS: no object named "' + name +
              '" — check the "placeable objects" list above');
        continue;
      }
      this._setRig(rig, OBJ_OFFSETS[name]);
      n++;
    }
    if (n) flog('applied ' + n + ' stored offset(s)');
  },

  _setRig: function (rig, v) {
    if (!v) return;
    if (Object.prototype.toString.call(v) === '[object Array]') {
      rig.position.set(v[0] || 0, v[1] || 0, v[2] || 0);
      return;
    }
    if (v.pos) rig.position.set(v.pos[0] || 0, v.pos[1] || 0, v.pos[2] || 0);
    if (v.quat) rig.quaternion.set(v.quat[0], v.quat[1], v.quat[2], v.quat[3]);
    if (typeof v.scale === 'number') rig.scale.setScalar(v.scale);
  },

  _pick: function (i) {
    if (!this._list.length) return;
    this._idx = ((i % this._list.length) + this._list.length) % this._list.length;
    var node = this._list[this._idx];
    var rig = (node.parent && node.parent.userData.__isRig)
            ? node.parent : this._rigOf(node);
    this._sel = rig;
    this._selKey = rig.userData.__key;
    this._selIsDup = !!node.userData.__isDup;
    if (this._delBtn) this._delBtn.style.opacity = this._selIsDup ? '1' : '0.35';
    this._paint();
  },

  _selectByNode: function (node) {
    for (var i = 0; i < this._list.length; i++) {
      if (this._list[i] === node) { this._pick(i); return true; }
    }
    return false;
  },

  _sourceOf: function (name) {
    for (var i = 0; i < this._list.length; i++) {
      if (this._list[i].name === name && !this._list[i].userData.__isDup) {
        return this._list[i];
      }
    }
    return null;
  },

  /* ---------------------------------------------------------- DUPLICATION */

  /* Clone a top-level object, wrap it in its own rig, and bind the same
     animation clips to the copy so it moves exactly like the original.
     SkeletonUtils.clone() is used when available (required for skinned
     meshes); plain .clone(true) is fine for rigid objects. */
  duplicate: function (srcNode, opts) {
    if (!srcNode) return null;
    opts = opts || {};

    var cloner = (THREE.SkeletonUtils && THREE.SkeletonUtils.clone)
               ? THREE.SkeletonUtils.clone
               : function (o) { return o.clone(true); };

    var srcName = srcNode.name || 'obj';
    var copy = cloner(srcNode);

    this._dupN++;
    var key = srcName + '__copy' + this._dupN;
    copy.name = key;
    copy.userData.__isDup = true;
    copy.userData.__src = srcName;

    copy.traverse(function (o) {
      if (o.isMesh || o.isSkinnedMesh) o.frustumCulled = false;
    });

    // Same parent as the source's rig, so both share one coordinate space.
    var srcRig = (srcNode.parent && srcNode.parent.userData.__isRig)
               ? srcNode.parent : null;
    var host = srcRig ? srcRig.parent : ARLayer.gltfScene;
    host.add(copy);

    var rig = this._rigOf(copy, key);

    // Start from the source rig's transform, then apply the requested offset.
    if (srcRig) {
      rig.position.copy(srcRig.position);
      rig.quaternion.copy(srcRig.quaternion);
      rig.scale.copy(srcRig.scale);
    }
    if (opts.pos) {
      rig.position.x += opts.pos[0] || 0;
      rig.position.y += opts.pos[1] || 0;
      rig.position.z += opts.pos[2] || 0;
    }
    if (opts.quat) {
      rig.quaternion.multiply(new THREE.Quaternion(
        opts.quat[0], opts.quat[1], opts.quat[2], opts.quat[3]));
    }
    if (typeof opts.scale === 'number') rig.scale.multiplyScalar(opts.scale);

    var tOff = (typeof opts.tOff === 'number') ? opts.tOff : 0;
    this._bindClips(srcNode, copy, tOff);

    this._dups.push({ key: key, src: srcName, node: copy, rig: rig, tOff: tOff });
    this._list.push(copy);

    return { key: key, node: copy, rig: rig };
  },

  /* Re-target every track that referenced the source subtree onto the copy.
     Each copy gets its OWN mixer: names repeat across copies, and a single
     mixer resolves bindings by searching from its root, which would be
     ambiguous. A per-copy mixer removes the ambiguity entirely, and lets each
     copy hold an independent time offset. */
  _bindClips: function (srcNode, copy, tOff) {
    if (!ARLayer.mixer || !ARLayer.actions.length) return;

    var srcNames = {};
    srcNode.traverse(function (o) { if (o.name) srcNames[o.name] = true; });

    var clips = [];
    for (var i = 0; i < ARLayer.actions.length; i++) {
      var c = ARLayer.actions[i].getClip();
      if (clips.indexOf(c) === -1) clips.push(c);
    }

    var dupMixer = new THREE.AnimationMixer(copy);
    var bound = 0;

    for (var k = 0; k < clips.length; k++) {
      var clip = clips[k];
      var tracks = [];

      for (var t = 0; t < clip.tracks.length; t++) {
        var tr = clip.tracks[t];
        var nodeName = tr.name.split('.')[0];

        if (nodeName === srcNode.name) {
          // Track targets the root itself -> retarget to the copy's new name.
          var c2 = tr.clone();
          c2.name = copy.name + tr.name.substring(nodeName.length);
          tracks.push(c2);
        } else if (srcNames[nodeName]) {
          tracks.push(tr.clone());      // child names are preserved by clone()
        }
      }
      if (!tracks.length) continue;

      var sub = new THREE.AnimationClip(clip.name + '__' + copy.name,
                                        clip.duration, tracks);
      var a = dupMixer.clipAction(sub);
      a.setLoop(THREE.LoopRepeat, Infinity);
      a.clampWhenFinished = false;
      a.play();
      a.paused = ARLayer.paused;
      bound++;
    }

    if (!bound) return;

    if (tOff) dupMixer.setTime(tOff);    // stagger this copy's loop

    ARLayer.dupMixers.push(dupMixer);
    copy.userData.__mixer = dupMixer;
    flog('bound ' + bound + ' clip(s) to ' + copy.name +
         (tOff ? '  (offset ' + tOff.toFixed(2) + 's)' : ''));
  },

  _spawnStoredDuplicates: function () {
    if (typeof DUPLICATES === 'undefined' || !DUPLICATES.length) return;
    var n = 0;
    for (var i = 0; i < DUPLICATES.length; i++) {
      var d = DUPLICATES[i];
      var src = this._sourceOf(d.src);
      if (!src) {
        fwarn('DUPLICATES: no source object named "' + d.src + '"');
        continue;
      }
      // pos in DUPLICATES is the copy's ABSOLUTE rig position, so create the
      // copy with no offset and then write the transform directly.
      var made = this.duplicate(src, { tOff: d.tOff });
      if (made) this._setRig(made.rig, d);
      n++;
    }
    if (n) flog('spawned ' + n + ' duplicate(s) from config');
  },

  _dupSelected: function () {
    if (!this._sel) return;
    var node = this._sel.children[0];
    if (!node) return;

    // Offset by ~12% of the frame width at the object's depth, so the copy is
    // clearly visible rather than hidden exactly behind the original.
    var d = this._sel.getWorldPosition(new THREE.Vector3())
              .distanceTo(ARLayer.cam.position);
    var off = 2 * d * Math.tan(ARLayer.cam.fov * Math.PI / 360) * 0.12;
    var right = new THREE.Vector3(1, 0, 0)
                  .applyQuaternion(ARLayer.cam.quaternion)
                  .multiplyScalar(off);

    // Always clone from the ORIGINAL, never from a copy, so clip binding stays
    // clean no matter how many generations deep you go.
    var src = node.userData.__isDup
            ? (this._sourceOf(node.userData.__src) || node)
            : node;

    var made = this.duplicate(src, {});
    if (!made) return;

    // Start from the CURRENT selection's transform, then push it sideways.
    made.rig.position.copy(this._sel.position);
    made.rig.quaternion.copy(this._sel.quaternion);
    made.rig.scale.copy(this._sel.scale);

    var o = new THREE.Vector3(0, 0, 0);
    var pInv = new THREE.Matrix4().copy(made.rig.parent.matrixWorld).invert();
    o.applyMatrix4(pInv);
    made.rig.position.add(right.applyMatrix4(pInv).sub(o));

    this._selectByNode(made.node);
    flog('duplicated -> ' + made.key + '   (objects: ' + this._list.length + ')');
    this._save();
  },

  deleteSelected: function () {
    if (!this._sel || !this._selIsDup) {
      flog('only duplicates can be deleted — originals are protected');
      return;
    }

    var key = this._selKey;
    var rig = this._sel;
    var node = rig.children[0];

    if (node && node.userData.__mixer) {
      var m = node.userData.__mixer;
      m.stopAllAction();
      var mi = ARLayer.dupMixers.indexOf(m);
      if (mi >= 0) ARLayer.dupMixers.splice(mi, 1);
    }

    var li = this._list.indexOf(node);
    if (li >= 0) this._list.splice(li, 1);
    for (var d = 0; d < this._dups.length; d++) {
      if (this._dups[d].key === key) { this._dups.splice(d, 1); break; }
    }
    delete this._rigs[key];

    if (rig.parent) rig.parent.remove(rig);
    // Geometries and materials are shared with the original — do NOT dispose.

    flog('deleted ' + key);
    this._sel = null;
    this._selKey = '';
    this._selIsDup = false;
    if (this._list.length) this._pick(Math.max(0, this._idx - 1));
    this._save();
    this._paint();
  },

  /* -------------------------------------------------------------- listeners */
  _listen: function () {
    var self = this;
    var opts = { passive: false, capture: true };

    function kill(e) { e.preventDefault(); e.stopPropagation(); }
    function mine(e) {
      if (typeof plateEl !== 'undefined' && plateEl) return false;
      if (self._ui && self._ui.contains(e.target)) return false;
      if (self._dot && self._dot.contains(e.target)) return false;
      return true;
    }

    window.addEventListener('touchstart', function (e) {
      if (!self.on || !mine(e)) return;
      if (CFG.PLATE_CAPTURE && e.touches.length >= 3) {
        kill(e);
        if (typeof savePlate === 'function') savePlate();
        return;
      }
      kill(e);
      if (!CamFeed.ready && !CamFeed.starting) {
        if (typeof begin === 'function') begin();
        return;
      }
      self._start(e.touches);
    }, opts);

    window.addEventListener('touchmove', function (e) {
      if (!self.on || !self._g || !mine(e)) return;
      kill(e);
      self._drag(e.touches);
    }, opts);

    function end(e) {
      if (!self.on) return;
      if (e.touches && e.touches.length > 0) {   // one lifted, others remain
        self._g = null;
        self._start(e.touches);
        return;
      }
      // A tap with no movement = select whatever is under the finger.
      if (!self._moved && self._g && self.mode === 'obj') self._hitTest(self._g.a);
      self._g = null;
      self._save();
      self._paint();
    }
    window.addEventListener('touchend', end, opts);
    window.addEventListener('touchcancel', end, opts);

    /* ---- desktop ---- */
    window.addEventListener('mousedown', function (e) {
      if (!self.on) return;
      if (self._ui && self._ui.contains(e.target)) return;
      if (self._dot && self._dot.contains(e.target)) return;
      if (!CamFeed.ready && !CamFeed.starting) {
        if (typeof begin === 'function') begin();
        return;
      }
      self._start([{ clientX: e.clientX, clientY: e.clientY }]);
    });
    window.addEventListener('mousemove', function (e) {
      if (!self.on || !self._g) return;
      self._drag([{ clientX: e.clientX, clientY: e.clientY }]);
    });
    window.addEventListener('mouseup', function () {
      if (!self.on) return;
      if (!self._moved && self._g && self.mode === 'obj') self._hitTest(self._g.a);
      self._g = null; self._save(); self._paint();
    });
    window.addEventListener('wheel', function (e) {
      if (!self.on) return;
      e.preventDefault();
      self._start([{ clientX: e.clientX, clientY: e.clientY }]);
      self._zoom(Math.exp(-e.deltaY * 0.0012), 0);
      self._g = null; self._save(); self._paint();
    }, { passive: false });

    window.addEventListener('keydown', function (e) {
      if (!self.on) return;
      if (e.key === 'd' || e.key === 'D') { self._dupSelected(); self._paint(); return; }
      if (e.key === 'h' || e.key === 'H') { self.setHidden(!self.hidden); return; }
      if (e.key === 'n' || e.key === 'N') { self._pick(self._idx + 1); return; }
      if (self.mode !== 'obj' || !self._sel) return;
      var px = 4 * self._step(), d = null;
      if (e.key === 'ArrowLeft')  d = [-px, 0];
      if (e.key === 'ArrowRight') d = [ px, 0];
      if (e.key === 'ArrowUp')    d = [0, -px];
      if (e.key === 'ArrowDown')  d = [0,  px];
      if (!d) return;
      e.preventDefault();
      self._start([{ clientX: 0, clientY: 0 }]);
      self._move(d[0], d[1]);
      self._g = null; self._save(); self._paint();
    });
  },

  /* ---------------------------------------------------------------- gesture */
  _pt: function (t) { return { x: t.clientX, y: t.clientY }; },
  _step: function () { return this.STEPS[this._stepIdx]; },

  _start: function (ts) {
    var g = { cal: JSON.parse(JSON.stringify(CAL)), a: this._pt(ts[0]) };
    this._moved = false;

    if (ts.length >= 2) {
      g.b = this._pt(ts[1]);
      var dx = g.b.x - g.a.x, dy = g.b.y - g.a.y;
      g.dist = Math.sqrt(dx * dx + dy * dy) || 1;
      g.ang = Math.atan2(dy, dx);
    }

    if (this.mode === 'obj' && this._sel) this._snap(g);
    this._g = g;
  },

  // Freeze everything at gesture start so each frame is computed absolutely
  // from that snapshot — no accumulation, no drift.
  _snap: function (g) {
    var rig = this._sel;
    rig.parent.updateWorldMatrix(true, false);

    g.pos0 = rig.position.clone();
    g.quat0 = rig.quaternion.clone();
    g.scale0 = rig.scale.clone();

    g.pInv = new THREE.Matrix4().copy(rig.parent.matrixWorld).invert();

    var node = rig.children[0] || rig;
    node.updateWorldMatrix(true, false);
    g.pivot = new THREE.Vector3().setFromMatrixPosition(node.matrixWorld);
    g.dist0 = Math.max(0.01, g.pivot.distanceTo(ARLayer.cam.position));
    g.dir = g.pivot.clone().sub(ARLayer.cam.position).normalize();
  },

  _drag: function (ts) {
    var g = this._g;
    if (!g) return;

    if (ts.length >= 2 && g.b) {
      var a = this._pt(ts[0]), b = this._pt(ts[1]);
      var dx = b.x - a.x, dy = b.y - a.y;
      var dist = Math.sqrt(dx * dx + dy * dy) || 1;
      var ang = Math.atan2(dy, dx);
      var tw = ang - g.ang;
      while (tw > Math.PI) tw -= 2 * Math.PI;
      while (tw < -Math.PI) tw += 2 * Math.PI;
      this._moved = true;
      this._zoom(dist / g.dist, tw * this.TWIST);
      return;
    }

    var p = this._pt(ts[0]);
    var mx = (p.x - g.a.x) * this.DRAG_X;
    var my = (p.y - g.a.y) * this.DRAG_Y;
    if (Math.abs(mx) > 3 || Math.abs(my) > 3) this._moved = true;

    if (this.mode === 'obj') this._move(mx, my);
    else this._camDrag(mx, my);
  },

  /* Screen pixels -> world translation at the object's depth.
     No raycasting, so this works wherever on screen you touch. */
  _move: function (px, py) {
    var g = this._g;
    if (!g || !this._sel || !g.pos0) return;

    var cam = ARLayer.cam;
    var H = (typeof height === 'number' && height) ? height : window.innerHeight;
    var worldPerPx = (2 * g.dist0 * Math.tan(cam.fov * Math.PI / 360)) / H;
    var k = worldPerPx * this._step();

    var right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    var up    = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);

    // world delta -> parent-local delta (handles parent rotation and scale)
    var wd = right.multiplyScalar(px * k).add(up.multiplyScalar(-py * k));
    var o = new THREE.Vector3(0, 0, 0).applyMatrix4(g.pInv);
    var ld = wd.applyMatrix4(g.pInv).sub(o);

    this._sel.position.copy(g.pos0).add(ld);
    this._paint();
  },

  /* pinch: r > 1 means fingers spread apart */
  _zoom: function (r, twist) {
    var g = this._g;
    if (!g) return;
    var f = this._step();
    var rf = 1 + (r - 1) * f;          // damp toward 1 when step < 1

    if (this.mode === 'cam') {
      CAL.fovScale = Math.max(0.25, Math.min(4, g.cal.fovScale / rf));
      CAL.roll = g.cal.roll + twist * f * 180 / Math.PI;
      ARLayer.applyCalibration();
      this._paint();
      return;
    }

    if (!this._sel || !g.pos0) return;

    if (this.pinchMode === 'scale') {
      this._sel.scale.copy(g.scale0)
        .multiplyScalar(Math.max(0.05, Math.min(20, rf)));
    } else {
      // Along the camera ray: grows/shrinks but stays put on screen.
      var newD = Math.max(0.05, g.dist0 / rf);
      var wd = g.dir.clone().multiplyScalar(newD - g.dist0);
      var o = new THREE.Vector3(0, 0, 0).applyMatrix4(g.pInv);
      this._sel.position.copy(g.pos0).add(wd.applyMatrix4(g.pInv).sub(o));
    }

    if (twist) {
      var axis = new THREE.Vector3(0, 0, -1).applyQuaternion(ARLayer.cam.quaternion);
      var o2 = new THREE.Vector3(0, 0, 0).applyMatrix4(g.pInv);
      var la = axis.clone().applyMatrix4(g.pInv).sub(o2).normalize();
      var q = new THREE.Quaternion().setFromAxisAngle(la, twist * f);
      this._sel.quaternion.copy(g.quat0).premultiply(q);
    }

    this._paint();
  },

  _camDrag: function (px, py) {
    var g = this._g;
    var H = (typeof height === 'number' && height) ? height : window.innerHeight;
    var dpx = (H * 0.5) / Math.tan(ARLayer.cam.fov * Math.PI / 360);
    var f = this._step();
    CAL.yaw   = g.cal.yaw   + Math.atan(px * f / dpx) * 180 / Math.PI;
    CAL.pitch = g.cal.pitch + Math.atan(py * f / dpx) * 180 / Math.PI;
    ARLayer.applyCalibration();
    this._paint();
  },

  /* Tap-to-select. Convenience only — dragging never depends on it. */
  _hitTest: function (p) {
    if (!ARLayer.gltfScene || !this._list.length) return;
    var r = ARLayer.renderer.domElement.getBoundingClientRect();
    this._v2.set(((p.x - r.left) / r.width) * 2 - 1,
                 -((p.y - r.top) / r.height) * 2 + 1);
    this._ray.setFromCamera(this._v2, ARLayer.cam);
    var hits = this._ray.intersectObject(ARLayer.gltfScene, true);
    if (!hits.length) return;

    var n = hits[0].object;
    while (n && n.parent) {
      if (this._selectByNode(n)) return;
      n = n.parent;
    }
  },

  /* --------------------------------------------------------------------- UI */
  setHidden: function (h) {
    this.hidden = !!h;
    if (this._ui) this._ui.style.display = this.hidden ? 'none' : 'block';
    if (this._dot) this._dot.style.display = this.hidden ? 'block' : 'none';
  },

  _makeUI: function () {
    var self = this;

    /* ---- restore dot: always built, only visible while hidden ---- */
    var dot = document.createElement('div');
    dot.style.cssText =
      'position:fixed;z-index:22;display:none;' +
      'right:calc(6px + env(safe-area-inset-right));' +
      'top:calc(6px + env(safe-area-inset-top));' +
      'width:28px;height:28px;border-radius:50%;' +
      'background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.22);' +
      'pointer-events:auto;';
    dot.addEventListener('touchstart', function (e) { e.stopPropagation(); }, true);
    dot.addEventListener('click', function (e) {
      e.stopPropagation(); e.preventDefault(); self.setHidden(false);
    });
    document.body.appendChild(dot);
    this._dot = dot;

    /* ---- panel ---- */
    var wrap = document.createElement('div');
    wrap.style.cssText =
      'position:fixed;left:0;right:0;top:0;z-index:20;pointer-events:none;' +
      'padding:calc(8px + env(safe-area-inset-top)) 8px 6px;' +
      'font:12px/1.5 ui-monospace,Menlo,monospace;color:#eaf0f8;' +
      'text-shadow:0 1px 3px rgba(0,0,0,.95);';

    this._out = document.createElement('div');
    this._out.style.cssText = 'white-space:pre;';
    wrap.appendChild(this._out);

    var row = document.createElement('div');
    row.style.cssText =
      'margin-top:8px;display:flex;flex-wrap:wrap;gap:7px;pointer-events:auto;';

    function btn(label, fn) {
      var b = document.createElement('button');
      b.textContent = label;
      b.style.cssText =
        '-webkit-appearance:none;appearance:none;font:600 12px/1 inherit;' +
        'background:rgba(22,26,34,.9);color:#eaf0f8;border:1px solid #3d4757;' +
        'border-radius:7px;padding:10px 13px;';
      b.addEventListener('touchstart', function (e) { e.stopPropagation(); }, true);
      b.addEventListener('click', function (e) {
        e.stopPropagation(); e.preventDefault(); fn(b); self._paint();
      });
      row.appendChild(b);
      return b;
    }

    btn('next', function () { self._pick(self._idx + 1); });
    btn('dup',  function () { self._dupSelected(); });

    this._delBtn = btn('del', function () { self.deleteSelected(); });
    this._delBtn.style.opacity = '0.35';

    btn('step', function () {
      self._stepIdx = (self._stepIdx + 1) % self.STEPS.length;
    });

    this._pauseBtn = btn('pause', function (b) {
      ARLayer.setPaused(!ARLayer.paused);
      b.textContent = ARLayer.paused ? 'play' : 'pause';
    });

    btn('pinch', function () {
      self.pinchMode = (self.pinchMode === 'depth') ? 'scale' : 'depth';
    });

    btn('mode', function () {
      self.mode = (self.mode === 'obj') ? 'cam' : 'obj';
    });

    btn('copy', function () { self._copy(); });
    btn('hide', function () { self.setHidden(true); });

    btn('reset', function () {
      try { localStorage.removeItem('fakeAR.cal'); } catch (e) {}
      flog('reset — reloading to config.js values');
      location.reload();
    });

    wrap.appendChild(row);
    document.body.appendChild(wrap);
    this._ui = wrap;
    this._paint();
  },

  _paint: function () {
    if (!this._out || !ARLayer.cam) return;
    var f = function (v) { return (v >= 0 ? ' ' : '') + v.toFixed(3); };
    var L = [];

    if (this.mode === 'obj') {
      L.push('PLACE  ' + (this._selKey || '(none)') +
             (this._selIsDup ? ' [copy]' : '') +
             '   ' + (this._idx + 1) + '/' + this._list.length +
             '   step ' + this._step() + 'x   pinch=' + this.pinchMode);
      if (this._sel) {
        var p = this._sel.position;
        var b = BL.toBlenderDelta(p.x, p.y, p.z);
        L.push('glTF ' + f(p.x) + ' ' + f(p.y) + ' ' + f(p.z) +
               '   scl ' + this._sel.scale.x.toFixed(3));
        L.push('bldr ' + f(b.x) + ' ' + f(b.y) + ' ' + f(b.z));
      } else {
        L.push('no placeable objects found — check the console');
      }
    } else {
      L.push('CAM    fov ' + f(CAL.fovScale) + ' -> ' +
             ARLayer.cam.fov.toFixed(2) + 'deg  (' +
             (18 / Math.tan(ARLayer.cam.fov * Math.PI / 360)).toFixed(1) + 'mm)');
      L.push('yaw ' + f(CAL.yaw) + '  pitch ' + f(CAL.pitch) +
             '  roll ' + f(CAL.roll) + '   step ' + this._step() + 'x');
    }
    this._out.textContent = L.join('\n');
  },

  /* ------------------------------------------------------- copy / autosave */
  _dump: function () {
    var r3 = function (v) { return Math.round(v * 1000) / 1000; };
    var r4 = function (v) { return Math.round(v * 10000) / 10000; };

    var out = { CAL: {
      fovScale: r3(CAL.fovScale), yaw: r3(CAL.yaw), pitch: r3(CAL.pitch),
      roll: r3(CAL.roll), shiftX: r3(CAL.shiftX), shiftY: r3(CAL.shiftY)
    }, OBJ: {}, DUP: [] };

    // originals
    for (var k in this._rigs) {
      var rig = this._rigs[k];
      var node = rig.children[0];
      if (!node || node.userData.__isDup) continue;

      var moved = rig.position.lengthSq() > 1e-8;
      var rot = Math.abs(rig.quaternion.w) < 0.99999;
      var scl = Math.abs(rig.scale.x - 1) > 1e-4;
      if (!moved && !rot && !scl) continue;

      if (!rot && !scl) {
        out.OBJ[k] = [r3(rig.position.x), r3(rig.position.y), r3(rig.position.z)];
      } else {
        out.OBJ[k] = {
          pos: [r3(rig.position.x), r3(rig.position.y), r3(rig.position.z)],
          quat: [r4(rig.quaternion.x), r4(rig.quaternion.y),
                 r4(rig.quaternion.z), r4(rig.quaternion.w)],
          scale: r3(rig.scale.x)
        };
      }
    }

    // duplicates — pos is the copy's absolute rig position
    for (var d = 0; d < this._dups.length; d++) {
      var dup = this._dups[d];
      var r = dup.rig;
      var e = { src: dup.src,
                pos: [r3(r.position.x), r3(r.position.y), r3(r.position.z)] };
      if (Math.abs(r.quaternion.w) < 0.99999) {
        e.quat = [r4(r.quaternion.x), r4(r.quaternion.y),
                  r4(r.quaternion.z), r4(r.quaternion.w)];
      }
      if (Math.abs(r.scale.x - 1) > 1e-4) e.scale = r3(r.scale.x);
      if (dup.tOff) e.tOff = r3(dup.tOff);
      out.DUP.push(e);
    }

    return out;
  },

  _copy: function () {
    var d = this._dump();
    var r3 = function (v) { return Math.round(v * 1000) / 1000; };

    var s = 'var CAL = {\n' +
      '  fovScale: ' + d.CAL.fovScale + ',\n' +
      '  yaw:      ' + d.CAL.yaw + ',\n' +
      '  pitch:    ' + d.CAL.pitch + ',\n' +
      '  roll:     ' + d.CAL.roll + ',\n' +
      '  shiftX:   ' + d.CAL.shiftX + ',\n' +
      '  shiftY:   ' + d.CAL.shiftY + '\n};\n\n';

    var anyObj = false, o = 'var OBJ_OFFSETS = {\n';
    for (var name in d.OBJ) {
      anyObj = true;
      o += '  "' + name + '": ' + JSON.stringify(d.OBJ[name]) + ',\n';
    }
    o += '};\n\n';
    s += anyObj ? o : 'var OBJ_OFFSETS = {};\n\n';

    var u = 'var DUPLICATES = [\n';
    for (var i = 0; i < d.DUP.length; i++) {
      u += '  ' + JSON.stringify(d.DUP[i]) + ',\n';
    }
    u += '];';
    s += u;

    if (anyObj) {
      s += '\n\n/* --- original-object deltas in BLENDER (Z-up) metres.\n' +
           '   Add these to each object\'s Location, re-export, then empty\n' +
           '   OBJ_OFFSETS to keep Blender as the single source of truth. ---\n';
      for (var nm in this._rigs) {
        var rg = this._rigs[nm];
        var nd = rg.children[0];
        if (!nd || nd.userData.__isDup) continue;
        if (rg.position.lengthSq() < 1e-8) continue;
        var bb = BL.toBlenderDelta(rg.position.x, rg.position.y, rg.position.z);
        s += '   ' + nm + ':  X ' + r3(bb.x) + '   Y ' + r3(bb.y) +
             '   Z ' + r3(bb.z) + '\n';
      }
      s += '*/';
    }

    s += '\n\n// Blender focal implied by fovScale (Sensor Fit Vertical, Size 36): ' +
         (18 / Math.tan(ARLayer.cam.fov * Math.PI / 360)).toFixed(2) + ' mm';

    flog('\n' + s);
    if (navigator.clipboard) {
      navigator.clipboard.writeText(s)
        .then(function () { flog('copied to clipboard'); })
        .catch(function () {});
    }
    if (this._out) this._out.textContent = s;
  },

  // Only written while the tool is on, so a stale localStorage can never
  // affect the shipped build.
  _save: function () {
    if (!this.on) return;
    try { localStorage.setItem('fakeAR.cal', JSON.stringify(this._dump())); } catch (e) {}
  },

  _restore: function () {
    if (!this.on) return;
    var raw = null;
    try { raw = localStorage.getItem('fakeAR.cal'); } catch (e) {}
    if (!raw) return;

    try {
      var d = JSON.parse(raw);

      if (d.CAL) for (var k in d.CAL) if (k in CAL) CAL[k] = d.CAL[k];

      if (d.OBJ) for (var n in d.OBJ) {
        var rig = this._rigByKey(n);
        if (rig) this._setRig(rig, d.OBJ[n]);
      }

      // Replace config duplicates with the saved set, so the count is right.
      if (d.DUP) {
        while (this._dups.length) {
          this._sel = this._dups[0].rig;
          this._selKey = this._dups[0].key;
          this._selIsDup = true;
          this.deleteSelected();
        }
        for (var i = 0; i < d.DUP.length; i++) {
          var e = d.DUP[i];
          var src = this._sourceOf(e.src);
          if (!src) continue;
          var made = this.duplicate(src, { tOff: e.tOff });
          if (made) this._setRig(made.rig, e);
        }
        if (d.DUP.length) flog('restored ' + d.DUP.length + ' duplicate(s)');
      }

      ARLayer.applyCalibration();
      flog('restored previous session from localStorage — "reset" to discard');
    } catch (e) {
      fwarn('could not restore session', e);
    }
  }
};
