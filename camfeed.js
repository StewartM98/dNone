/* =============================================================================
   fakeAR — rear camera feed

   - getUserMedia must be called from inside a user gesture on iOS.
   - The <video> stays in the DOM at 1x1 / opacity 0.01: some iOS versions
     refuse to hand frames to drawImage() from a display:none video.
   - NEVER apply transform: scaleX(-1). Rear cameras must not be mirrored.
============================================================================= */

var CamFeed = {

  video: null,
  stream: null,
  track: null,

  ready: false,
  starting: false,
  error: null,

  // Source rectangle inside the video frame, centre-cropped to CFG.ASPECT.
  crop: { sx: 0, sy: 0, sw: 0, sh: 0 },

  /* ------------------------------------------------------------------ start */
  start: function () {
    var self = this;
    if (this.ready || this.starting) return;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this.error = 'no camera API — the page must be HTTPS';
      fwarn('getUserMedia unavailable. The page must be served over HTTPS. ' +
            'http://localhost works on a laptop, but NOT from the phone — ' +
            'use VS Code port forwarding, a tunnel, or the deployed URL.');
      return;
    }

    this.starting = true;
    this.error = null;

    this._open()
      .then(function (stream) { return self._attach(stream); })
      .then(function () {
        self.ready = true;
        self.starting = false;
        self.updateCrop();
        self._logDevices();

        var s = (self.track && self.track.getSettings) ? self.track.getSettings() : {};
        var a = self.video.videoWidth / self.video.videoHeight;

        flog('stream', self.video.videoWidth + 'x' + self.video.videoHeight,
             '| aspect', a.toFixed(4),
             '| crop', Math.round(self.crop.sw) + 'x' + Math.round(self.crop.sh),
             '| fps', s.frameRate || '?',
             '| lens', (s.deviceId || '?').slice(0, 16));

        if (Math.abs(a - 4 / 3) > 0.02 && Math.abs(a - 3 / 4) > 0.02) {
          fwarn('stream aspect ' + a.toFixed(4) + ' is not 4:3 family — it is ' +
                'being cropped to ' + CFG.ASPECT.toFixed(4) + ', which changes ' +
                'the effective field of view. Expect to re-tune CAL.fovScale.');
        }
      })
      .catch(function (e) {
        self.starting = false;
        self.ready = false;
        self.error = CamFeed._describe(e);
        fwarn('camera failed:', e && e.name, e && e.message);
        flog(self.error);
      });
  },

  /* Constraint ladder — first success wins. */
  _open: function () {
    var tries = [];

    if (CFG.DEVICE_ID) {
      tries.push({ audio: false, video: {
        deviceId: { exact: CFG.DEVICE_ID },
        width:  { ideal: CFG.VIDEO_W },
        height: { ideal: CFG.VIDEO_H }
      }});
    }
    tries.push({ audio: false, video: {
      facingMode: { exact: 'environment' },
      width:  { ideal: CFG.VIDEO_W },
      height: { ideal: CFG.VIDEO_H }
    }});
    tries.push({ audio: false, video: { facingMode: { ideal: 'environment' } } });
    tries.push({ audio: false, video: true });

    var i = 0;
    function next(lastErr) {
      if (i >= tries.length) return Promise.reject(lastErr || new Error('no camera'));
      var c = tries[i++];
      return navigator.mediaDevices.getUserMedia(c).catch(function (e) {
        // A hard permission denial will not be fixed by relaxing constraints.
        if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) throw e;
        return next(e);
      });
    }
    return next(null);
  },

  _attach: function (stream) {
    var self = this;
    this.stream = stream;
    this.track = stream.getVideoTracks()[0];

    var v = document.createElement('video');
    v.setAttribute('playsinline', '');           // iOS: don't go fullscreen
    v.setAttribute('webkit-playsinline', '');
    v.setAttribute('muted', '');
    v.muted = true;                              // required for autoplay
    v.playsInline = true;
    v.autoplay = true;
    v.srcObject = stream;

    // Effectively invisible, but still in the DOM and still painting.
    v.style.position = 'fixed';
    v.style.right = '0';
    v.style.bottom = '0';
    v.style.width = '1px';
    v.style.height = '1px';
    v.style.opacity = '0.01';
    v.style.pointerEvents = 'none';
    v.style.zIndex = '0';
    document.body.appendChild(v);
    this.video = v;

    v.addEventListener('resize', function () { self.updateCrop(); });
    if (this.track) {
      this.track.addEventListener('ended', function () {
        fwarn('camera track ended');
        self.ready = false;
      });
    }

    return v.play().then(function () {
      // iOS reports videoWidth 0 for a beat after play() resolves.
      return new Promise(function (res, rej) {
        var t0 = performance.now();
        (function poll() {
          if (v.videoWidth && v.videoHeight) return res();
          if (performance.now() - t0 > 10000) return rej(new Error('no video frames'));
          requestAnimationFrame(poll);
        })();
      });
    });
  },

  /* ---------------------------------------------------------------- restart */
  restart: function () {
    this.stop();
    this.start();
  },

  stop: function () {
    if (this.stream) {
      try {
        this.stream.getTracks().forEach(function (t) { t.stop(); });
      } catch (e) {}
    }
    if (this.video && this.video.parentNode) {
      this.video.parentNode.removeChild(this.video);
    }
    this.video = null;
    this.stream = null;
    this.track = null;
    this.ready = false;
    this.starting = false;
  },

  /* ------------------------------------------------------------------- crop */
  // Centre-crop the incoming frame to exactly CFG.ASPECT.
  //
  // Full screen (0.4614) is NARROWER than the 3:4 stream (0.75), so the crop
  // takes the SIDES and your full vertical FOV is preserved. That is why the
  // Blender focal length solve carries over unchanged between the two.
  updateCrop: function () {
    var v = this.video;
    if (!v || !v.videoWidth || !v.videoHeight) return;

    var vw = v.videoWidth, vh = v.videoHeight, A = CFG.ASPECT;
    var sw, sh;

    if (vw / vh > A) { sh = vh; sw = vh * A; }    // stream wider -> crop sides
    else             { sw = vw; sh = vw / A; }    // stream taller -> crop top/bottom

    this.crop = { sx: (vw - sw) / 2, sy: (vh - sh) / 2, sw: sw, sh: sh };
  },

  isLive: function () {
    return !!(this.track && this.track.readyState === 'live');
  },

  /* ------------------------------------------------------------ diagnostics */
  _logDevices: function () {
    if (!navigator.mediaDevices.enumerateDevices) return;
    navigator.mediaDevices.enumerateDevices().then(function (list) {
      var rear = list.filter(function (d) {
        return d.kind === 'videoinput' && !/front|face/i.test(d.label);
      });
      flog('rear cameras — paste one deviceId into CFG.DEVICE_ID to pin the lens:');
      rear.forEach(function (d) { flog('    ' + d.label + '  =  ' + d.deviceId); });
      flog('   (avoid "Dual"/"Triple" virtual devices: they switch physical ' +
           'lenses at runtime, which changes the FOV mid-experience)');
    }).catch(function () {});
  },

  _describe: function (e) {
    var n = e && e.name;
    if (n === 'NotAllowedError' || n === 'PermissionDeniedError') {
      return 'camera blocked — Settings > Safari > Camera > Allow, then reload';
    }
    if (n === 'NotFoundError' || n === 'DevicesNotFoundError') {
      return 'no camera found (clear CFG.DEVICE_ID?)';
    }
    if (n === 'NotReadableError' || n === 'TrackStartError') {
      return 'camera busy — close other camera apps and tabs';
    }
    if (n === 'OverconstrainedError') {
      return 'unsupported resolution/lens (' + (e.constraint || '?') + ')';
    }
    if (n === 'SecurityError') return 'blocked — the page must be HTTPS';
    return (n || 'error') + ': ' + (e && e.message);
  }
};