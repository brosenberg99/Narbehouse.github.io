/** Benny's Sphere Splash - swimmer bodies: load, recolour into team kit, outline, animate.
 *
 * The bodies and clips come from js/model-data.js (base64 GLB, CC0 Quaternius, built
 * by tools/build/prep-models.mjs). Textures were stripped at build time: a swimmer is
 * painted in flat toon colours here, so a team reads as one bold shape and colour at
 * any distance - small detail does not read for the player this is built for.
 *
 * The kit is painted by bone: every vertex mostly weighted to a hip, spine or thigh
 * bone is kit colour, chest and shoulders are the accent, the rest is skin. That gives
 * every body the same wetsuit silhouette without any hand-painted masks.
 */
SS.models = (function () {
  'use strict';

  const KIT = new Set(['pelvis', 'spine_01', 'spine_02', 'thigh_l', 'thigh_r']);
  const ACCENT = new Set(['spine_03', 'clavicle_l', 'clavicle_r', 'upperarm_l', 'upperarm_r']);
  const INK = 0x14161f;

  let bodies = null, clips = {}, gradient = null;

  function bufferFrom(b64) {
    const bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }
  function parse(key) {
    return new Promise((resolve, reject) =>
      new THREE.GLTFLoader().parse(bufferFrom(SS.MODEL_DATA[key]), '', resolve, reject));
  }

  // Three flat bands of light: the cartoon look, and it keeps kit colours readable
  // instead of shading them into mud in the teal water.
  function makeGradient() {
    const data = new Uint8Array([90, 170, 255]);
    const tex = new THREE.DataTexture(data, data.length, 1, THREE.RedFormat);
    tex.minFilter = tex.magFilter = THREE.NearestFilter; tex.generateMipmaps = false; tex.needsUpdate = true;
    return tex;
  }

  async function load() {
    if (bodies) return;
    const [male, female, anim] = await Promise.all([parse('male'), parse('female'), parse('clips')]);
    bodies = { male: male.scene, female: female.scene };
    anim.animations.forEach(a => { clips[a.name] = a; });
    gradient = makeGradient();
  }

  function toonMaterial() {
    const mat = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: gradient });
    SS.world.addCaustics(mat);
    return mat;
  }

  function paint(geometry, bones, colours) {
    const count = geometry.attributes.position.count;
    const idx = geometry.attributes.skinIndex, wt = geometry.attributes.skinWeight;
    const out = new Float32Array(count * 3), c = new THREE.Color();
    const get = ['getX', 'getY', 'getZ', 'getW'];     // r155 has no getComponent()
    for (let v = 0; v < count; v++) {
      let kit = 0, accent = 0;
      for (let k = 0; k < 4; k++) {
        const name = bones[idx[get[k]](v)].name, w = wt[get[k]](v);
        if (KIT.has(name)) kit += w; else if (ACCENT.has(name)) accent += w;
      }
      c.set(accent > 0.5 ? colours.accent : kit > 0.5 ? colours.kit : colours.skin);
      out[v * 3] = c.r; out[v * 3 + 1] = c.g; out[v * 3 + 2] = c.b;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(out, 3));
  }
  function paintSolid(geometry, hex) {
    const n = geometry.attributes.position.count, out = new Float32Array(n * 3), c = new THREE.Color(hex);
    for (let v = 0; v < n; v++) { out[v * 3] = c.r; out[v * 3 + 1] = c.g; out[v * 3 + 2] = c.b; }
    geometry.setAttribute('color', new THREE.BufferAttribute(out, 3));
  }

  // Inverted hull, skinned: a second copy of the body on the same skeleton, pushed
  // out along its normals in bind pose and drawn back-faces-only in ink. The offset
  // is applied before skinning, so the outline follows every bend of the body.
  function outlineFor(mesh, width) {
    const mat = new THREE.MeshBasicMaterial({ color: INK, side: THREE.BackSide });
    mat.onBeforeCompile = shader => {
      shader.uniforms.uOutline = { value: width };
      shader.vertexShader = 'uniform float uOutline;\n' + shader.vertexShader.replace(
        '#include <begin_vertex>', '#include <begin_vertex>\n  transformed += normal * uOutline;');
    };
    const hull = new THREE.SkinnedMesh(mesh.geometry, mat);
    hull.bind(mesh.skeleton, mesh.bindMatrix);
    hull.position.copy(mesh.position); hull.quaternion.copy(mesh.quaternion); hull.scale.copy(mesh.scale);
    hull.frustumCulled = false;
    return hull;
  }

  /**
   * One swimmer. `o` = { body:'male'|'female', kit, accent, skin, hair, outline }.
   * Returns { group, play(name, fade), update(dt) }. `group` faces +Z.
   */
  function makeSwimmer(o) {
    const root = THREE.SkeletonUtils.clone(bodies[o.body || 'male']);
    const meshes = [];
    root.traverse(n => { if (n.isSkinnedMesh) meshes.push(n); });
    meshes.forEach(mesh => {
      mesh.geometry = mesh.geometry.clone();         // each swimmer owns its colours
      const isBody = mesh.geometry.attributes.position.count > 3000;
      if (isBody) paint(mesh.geometry, mesh.skeleton.bones, o);
      else paintSolid(mesh.geometry, mesh.material.name === 'MI_Eyes' ? INK : (o.hair || 0x3a2a1c));
      mesh.material = toonMaterial();
      mesh.frustumCulled = false;                    // skinned bounds are the bind pose, not the pose
      if (isBody) mesh.parent.add(outlineFor(mesh, o.outline || 0.018));
    });
    const group = new THREE.Group();
    group.add(root);
    const mixer = new THREE.AnimationMixer(root);
    let current = null;
    function play(name, fade = 0.25) {
      const clip = clips[name];
      if (!clip) return;
      const next = mixer.clipAction(clip);
      if (next === current) return;
      next.reset().setEffectiveWeight(1).fadeIn(fade).play();
      if (current) current.fadeOut(fade);
      current = next;
    }
    // Named bones, so the ball can sit in the hands and a badge over the head
    // whatever pose the body is in (a swimmer is mostly horizontal, not upright).
    const bones = SS.rig.bonesOf(root);
    const frame = { forward: new THREE.Vector3(), right: new THREE.Vector3(), belly: new THREE.Vector3(), chest: new THREE.Vector3() };
    const ballPoint = new THREE.Vector3(), handAt = new THREE.Vector3(), elbowPole = new THREE.Vector3(), shoulder = new THREE.Vector3();
    let carrying = false;

    /* The carry: the clip keeps swimming the legs, hips and left arm; the right arm
       is re-posed every frame to cradle the ball against the belly, hand wrapped
       round the outside of it, elbow tucked out and back like a rugby carry. */
    function holdBall() {
      group.updateMatrixWorld(true);
      SS.rig.bodyFrame(bones, frame);
      ballPoint.copy(frame.chest).addScaledVector(frame.belly, 0.3).addScaledVector(frame.forward, -0.1).addScaledVector(frame.right, 0.08);
      handAt.copy(ballPoint).addScaledVector(frame.right, 0.17).addScaledVector(frame.belly, 0.05);
      bones.upperR.getWorldPosition(shoulder);
      elbowPole.copy(shoulder).addScaledVector(frame.right, 0.5).addScaledVector(frame.forward, -0.35);
      SS.rig.twoBone(bones.upperR, bones.lowerR, bones.handR, handAt, elbowPole);
    }

    function update(dt) {
      mixer.update(dt);
      if (carrying) holdBall();
    }
    return { group, root, play, update, mixer, bones, frame, ballPoint,
      head: bones.head, chest: bones.chest, handL: bones.handL, handR: bones.handR,
      setCarry(on) { carrying = on; }, get carrying() { return carrying; } };
  }

  return { load, makeSwimmer, get clipNames() { return Object.keys(clips); } };
})();
