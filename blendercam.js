/* =============================================================================
   fakeAR — Blender camera math

   Three things people reliably get wrong. All three are handled here:

   1. sensor_fit 'AUTO' applies the sensor size to the LARGER render dimension.
      For a PORTRAIT render that means the 36 mm value describes the VERTICAL
      extent. Treat it as horizontal and you are out by ~33%.

   2. Axis conversion. Blender is Z-up, three.js is Y-up:
          (x, y, z)_blender  ->  (x, z, -y)_three      which is Rx(-90 deg)
      Camera LOCAL conventions already agree (both look down local -Z with
      local +Y up), so there is NO extra local flip. Adding one is the classic
      double-correction bug that leaves you looking backwards.

   3. Euler order. Blender's 'XYZ' euler builds  R = Rz * Ry * Rx.
      three.js calls that order 'ZYX'. Using THREE.Euler(x, y, z, 'XYZ') gives
      a subtly wrong rotation whenever two axes are non-zero.
============================================================================= */

var BL = {

  /* Vertical FOV in RADIANS — exactly what PerspectiveCamera.fov expresses
     (only in degrees). */
  fovY: function (b) {
    var fit = (b.sensorFit || 'AUTO').toUpperCase();
    var verticalFit = (fit === 'VERTICAL') ||
                      (fit === 'AUTO' && b.renderH >= b.renderW);

    if (verticalFit) {
      // The sensor size maps straight onto image height.
      return 2 * Math.atan((b.sensor * 0.5) / b.focal);
    }
    // The sensor size maps onto image width; convert through the aspect.
    var fovX = 2 * Math.atan((b.sensor * 0.5) / b.focal);
    return 2 * Math.atan(Math.tan(fovX * 0.5) / (b.renderW / b.renderH));
  },

  /* Blender normalises lens shift by `viewfac` pixels, where viewfac is the
     render dimension the sensor is fitted to. Convert to a fraction of the
     frame's own width / height. */
  shiftFrac: function (b) {
    var fit = (b.sensorFit || 'AUTO').toUpperCase();
    var W = b.renderW, H = b.renderH;
    var viewfac = (fit === 'HORIZONTAL') ? W
                : (fit === 'VERTICAL')   ? H
                : Math.max(W, H);
    return {
      x: (b.shiftX || 0) * viewfac / W,
      y: (b.shiftY || 0) * viewfac / H
    };
  },

  /* Blender location + XYZ euler  ->  three.js world position + quaternion. */
  transform: function (b, outPos, outQuat) {
    var D = Math.PI / 180;

    var q = new THREE.Quaternion().setFromEuler(new THREE.Euler(
      b.rotDeg[0] * D,
      b.rotDeg[1] * D,
      b.rotDeg[2] * D,
      'ZYX'                        // <- three's 'ZYX' == Blender's 'XYZ'
    ));

    var m = new THREE.Matrix4().compose(
      new THREE.Vector3(b.loc[0], b.loc[1], b.loc[2]),
      q,
      new THREE.Vector3(1, 1, 1)
    );

    // v_three = C * v_blender, therefore M_three = C * M_blender.
    m.premultiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2));

    m.decompose(outPos, outQuat, new THREE.Vector3());
  },

  /* glTF (Y-up) delta  ->  Blender (Z-up) delta, so you can type the numbers
     straight into Blender's transform fields and re-export. */
  toBlenderDelta: function (x, y, z) {
    return { x: x, y: -z, z: y };
  }
};