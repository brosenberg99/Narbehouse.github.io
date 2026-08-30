/**
 * Benny's Ballista — world building.
 *
 * Ground, sky, fog and the lighting rig. Deliberately its own small module
 * rather than a fork of Race Tracks' world.js (that file is a road/terrain
 * generator this game has no use for — see the ballista-3d plan on the wart
 * that leaves in FishMaster).
 *
 * Takes colours as plain arguments rather than reading the palette itself, so
 * this module has no dependency on game state or the DOM theme — game.js
 * reads the CSS custom properties once per theme change and hands the result
 * here and to art.js. That is also what makes refresh() below possible: it
 * repaints the same objects rather than rebuilding the world.
 */
RT.world = (function () {
  'use strict';

  const A = RT.art;

  const GROUND_SIZE = 400;

  /**
   * @param {THREE.Scene} scene
   * @param {object} pal  { sky1, sky2, ground, dirt, sunColor }
   * @returns {object} handles for refresh()/later tuning
   */
  function build(scene, pal) {
    scene.fog = new THREE.Fog(pal.sky2, 40, 260);
    scene.background = new THREE.Color(pal.sky2);

    const skyMat = new THREE.MeshBasicMaterial({
      map: A.skyTexture(pal.sky1, pal.sky2, pal.sky2),
      side: THREE.BackSide, fog: false, depthWrite: false
    });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(500, 20, 14), skyMat);
    sky.renderOrder = -10;
    scene.add(sky);

    const groundMat = A.paper(pal.ground, { roughness: 1 });
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE),
      groundMat
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    const hemi = new THREE.HemisphereLight(pal.sky1, pal.ground, 2.0);
    scene.add(hemi);

    const amb = new THREE.AmbientLight(0xffffff, 0.55);
    scene.add(amb);

    const sun = new THREE.DirectionalLight(pal.sunColor || 0xfff4dc, 3.0);
    sun.position.set(-14, 22, 12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    // Tight frustum around where the castle actually sits (roughly muzzle to
    // ~40 units downrange, per data.js's rangeWindow); re-centre per level once
    // levels exist rather than trying to cover the whole ground plane.
    const SH = 26;
    sun.shadow.camera.left = -SH;
    sun.shadow.camera.right = SH;
    sun.shadow.camera.top = SH;
    sun.shadow.camera.bottom = -SH;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 80;
    sun.shadow.bias = -0.0016;
    sun.shadow.normalBias = 0.035;
    sun.target.position.set(0, 0, -20);
    scene.add(sun);
    scene.add(sun.target);

    return { sky: sky, skyMat: skyMat, ground: ground, groundMat: groundMat, hemi: hemi, amb: amb, sun: sun };
  }

  /** Repaint an existing world for a new theme, without rebuilding geometry. */
  function refresh(handles, pal) {
    handles.skyMat.map = A.skyTexture(pal.sky1, pal.sky2, pal.sky2);
    handles.skyMat.map.needsUpdate = true;
    handles.groundMat.color.set(pal.ground);
    handles.hemi.color.set(pal.sky1);
    handles.hemi.groundColor.set(pal.ground);
    handles.sun.color.set(pal.sunColor || 0xfff4dc);
  }

  /** Re-centres the shadow frustum on a level's actual distance, now that
   *  real levels (js/levels.js) exist and don't all sit at the same `dist`
   *  the fixed frustum in build() was tuned for. Keeps the same half-size,
   *  just slides where it's aimed. */
  function recenterShadow(handles, dist) {
    const sun = handles.sun;
    sun.target.position.set(0, 0, -dist);
    sun.target.updateMatrixWorld();
    const SH = sun.shadow.camera.right;   // half-size chosen in build()
    sun.shadow.camera.far = dist + SH + 10;
    sun.shadow.camera.updateProjectionMatrix();
  }

  return { build, refresh, recenterShadow };
})();
