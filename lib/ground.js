/* A ground with no resolution limit, drawn under the splats.
 *
 * docs/14 section 5e measures why the immediate foreground cannot be fixed with
 * gaussians: at two metres and a five pixel blob threshold a gaussian has to be
 * 1.5 cm across, which is 4,400 points per square metre of ground against the
 * 25 the production run gives it. Range is in the denominator and under your
 * own feet it goes to nearly zero.
 *
 * So the ground is drawn the way the renderer draws it: a class map says what
 * each patch is made of, and the detail is evaluated per pixel rather than
 * stored. Three layers, coarse to fine:
 *
 *   the skin      the trained model's own colour, rasterised top down. Carries
 *                 the sun, the shadows and the tone curve, so it matches the
 *                 splats by construction rather than by tuning.
 *   the patch     metre-scale mottling, per class, from materials.py's PATCH_M.
 *   the grain     centimetre-scale, from materials.py's detail scale, plus a
 *                 running bond where the class map says brick.
 *
 * Everything below the skin is procedural, so walking closer keeps producing
 * detail instead of magnifying texels. The class table arrives in the manifest
 * rather than being written in here, so it cannot drift from the renderer's.
 */
(function (global) {
'use strict';

const VS = `#version 300 es
precision highp float;
in vec3 aPos;                      // metres, scene frame, z from the height field
uniform mat4 uView, uProj;
out vec2 vXY;
out float vDist;
void main(){
  vec4 p = uView * vec4(aPos, 1.0);
  vDist = -p.z;
  vXY = aPos.xy;
  gl_Position = uProj * p;
}`;

const FS = `#version 300 es
precision highp float;
in vec2 vXY;
in float vDist;
uniform sampler2D uSkin, uClass;
uniform vec4 uSkinCrop, uClassCrop;
uniform vec3 uRGB[16];
uniform float uPatchM[16], uDetailM[16], uAmp[16], uBrick[16];
uniform float uMix, uTint, uFade;
uniform vec3 uBrickM;              // width, height, mortar
out vec4 frag;

// Cheap value noise. Not simplex: this runs on the whole lower half of the
// frame every frame and the eye cannot tell them apart at these amplitudes.
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
// running bond: 1 in the mortar, 0 in the face
float bond(vec2 p, vec3 b){
  float row = floor(p.y / b.y);
  float x = p.x + mod(row, 2.0) * b.x * 0.5;
  vec2 d = vec2(min(fract(x / b.x), 1.0 - fract(x / b.x)) * b.x,
                min(fract(p.y / b.y), 1.0 - fract(p.y / b.y)) * b.y);
  return 1.0 - smoothstep(0.0, b.z, min(d.x, d.y));
}

void main(){
  vec2 st = (vXY - uSkinCrop.xy) / (uSkinCrop.zw - uSkinCrop.xy);
  vec3 base = texture(uSkin, st).rgb;
  vec2 ct = (vXY - uClassCrop.xy) / (uClassCrop.zw - uClassCrop.xy);
  int cid = int(texture(uClass, ct).r * 255.0 + 0.5);
  cid = clamp(cid, 0, 15);

  float pm = max(uPatchM[cid], 0.25), dm = max(uDetailM[cid], 0.02);
  float mottle = vnoise(vXY / pm) - 0.5;
  float grain = vnoise(vXY / dm) - 0.5;
  float n = mix(grain, mottle, uMix);
  if (uBrick[cid] > 0.5) n = mix(n, -bond(vXY, uBrickM), 0.55);

  // The detail rides the skin multiplicatively, so a shadow stays a shadow.
  // It also fades with distance: past the range where the skin itself is
  // finer than a pixel the grain is aliasing, not detail.
  float amp = uAmp[cid] * (1.0 - smoothstep(uFade * 0.5, uFade, vDist));
  vec3 col = base * (1.0 + amp * n);
  col = mix(col, uRGB[cid], uTint * (1.0 - smoothstep(0.0, uFade, vDist)));
  frag = vec4(col, 1.0);
}`;

function compile(gl, vs, fs){
  const mk = (t, src) => {
    const s = gl.createShader(t);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(p));
  return p;
}

function tex(gl, unit, img, filter, srgb){
  const t = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, srgb ? gl.RGBA : gl.RGBA, gl.RGBA,
                gl.UNSIGNED_BYTE, img);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

/* Build the grid once, with the height baked into the vertices.
 *
 * The height field was a texture at first, sampled in the vertex shader. On
 * WebGL2 an R32F texture is only filterable with OES_texture_float_linear,
 * and without it LINEAR makes the texture incomplete: GL error 1282 and a
 * black canvas, with nothing in the shader log to say so. The grid is small
 * and built on the CPU anyway, so reading the height here removes the texture,
 * the extension and the failure mode together. */
function grid(crop, shape, step, z){
  const [x0, y0, x1, y1] = crop;
  const [gh, gw] = shape;
  const at = (x, y) => {           // bilinear, clamped, row 0 at y = y0
    const fx = Math.min(gw - 1, Math.max(0, (x - x0) / (x1 - x0) * (gw - 1)));
    const fy = Math.min(gh - 1, Math.max(0, (y - y0) / (y1 - y0) * (gh - 1)));
    const i0 = Math.floor(fx), j0 = Math.floor(fy);
    const i1 = Math.min(gw - 1, i0 + 1), j1 = Math.min(gh - 1, j0 + 1);
    const tx = fx - i0, ty = fy - j0;
    return (z[j0 * gw + i0] * (1 - tx) + z[j0 * gw + i1] * tx) * (1 - ty) +
           (z[j1 * gw + i0] * (1 - tx) + z[j1 * gw + i1] * tx) * ty;
  };
  const nx = Math.max(2, Math.round((x1 - x0) / step) + 1);
  const ny = Math.max(2, Math.round((y1 - y0) / step) + 1);
  const xy = new Float32Array(nx * ny * 3);
  for (let j = 0, k = 0; j < ny; j++)
    for (let i = 0; i < nx; i++, k += 3) {
      xy[k] = x0 + (x1 - x0) * i / (nx - 1);
      xy[k + 1] = y0 + (y1 - y0) * j / (ny - 1);
      xy[k + 2] = at(xy[k], xy[k + 1]);
    }
  const idx = new Uint32Array((nx - 1) * (ny - 1) * 6);
  for (let j = 0, k = 0; j < ny - 1; j++)
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      idx[k++] = a; idx[k++] = c; idx[k++] = b;
      idx[k++] = b; idx[k++] = c; idx[k++] = d;
    }
  return {xy, idx, n: idx.length};
}

async function createGround(gl, man, base, opts = {}){
  const g = man.ground;
  if (!g || !g.skin || !g.file) return null;
  const url = p => (base ? base.replace(/\/$/, '') + '/' : '') + p;

  const hb = await (await fetch(url(g.file))).arrayBuffer();
  const [hh, hw] = g.shape;
  const hf = new Float32Array(hb);
  if (hf.length !== hh * hw)
    throw new Error(`ground.bin is ${hf.length} floats, the manifest says ${hh}x${hw}`);
  const load = src => new Promise((ok, no) => {
    const im = new Image();
    im.onload = () => ok(im); im.onerror = () => no(new Error('no ' + src));
    im.src = src;
  });
  const skinImg = await load(url(g.skin.colour));
  const classImg = await load(url(g.skin.class));
  const skinT = tex(gl, 1, skinImg, gl.LINEAR, true);
  const classT = tex(gl, 2, classImg, gl.NEAREST, false);

  const prog = compile(gl, VS, FS);
  const {xy, idx, n} = grid(g.crop, g.shape, g.step_m, hf);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vb);
  gl.bufferData(gl.ARRAY_BUFFER, xy, gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
  const ib = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
  gl.bindVertexArray(null);

  // class parameters, straight from the manifest
  const rgb = new Float32Array(48), pm = new Float32Array(16),
        dm = new Float32Array(16), amp = new Float32Array(16),
        br = new Float32Array(16);
  for (const [k, v] of Object.entries(g.skin.classes || {})) {
    const i = Math.min(15, parseInt(k, 10));
    rgb[i * 3] = v.rgb[0]; rgb[i * 3 + 1] = v.rgb[1]; rgb[i * 3 + 2] = v.rgb[2];
    pm[i] = v.patch_m || 2.0;
    dm[i] = v.detail_m || 0.1;
    amp[i] = opts.amp === undefined ? 0.30 : opts.amp;
    br[i] = v.brick ? 1 : 0;
  }
  const u = k => gl.getUniformLocation(prog, k);

  return {
    n, classes: Object.keys(g.skin.classes || {}).length,
    begin(w, h){
      gl.viewport(0, 0, w, h);
      gl.clearColor(0.055, 0.070, 0.086, 1);
      // depthMask has to be back on before the clear or the depth buffer keeps
      // whatever the first frame left in it and the terrain self-occludes
      gl.depthMask(true);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    },
    draw(view, p, probe){
      const at = probe ? (where) => {
        const e = gl.getError();
        if (e) console.warn('ground GL ' + e + ' after ' + where);
      } : () => {};
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.activeTexture(gl.TEXTURE0 + 1); gl.bindTexture(gl.TEXTURE_2D, skinT);
      gl.activeTexture(gl.TEXTURE0 + 2); gl.bindTexture(gl.TEXTURE_2D, classT);
      gl.uniform1i(u('uSkin'), 1); gl.uniform1i(u('uClass'), 2);
      gl.uniform4f(u('uSkinCrop'), g.skin.crop[0], g.skin.crop[1],
                   g.skin.crop[2], g.skin.crop[3]);
      const cc = g.skin.class_crop || g.skin.crop;
      gl.uniform4f(u('uClassCrop'), cc[0], cc[1], cc[2], cc[3]);
      gl.uniformMatrix4fv(u('uView'), false, view);
      gl.uniformMatrix4fv(u('uProj'), false, p.m);
      gl.uniform3fv(u('uRGB'), rgb);
      gl.uniform1fv(u('uPatchM'), pm);
      gl.uniform1fv(u('uDetailM'), dm);
      gl.uniform1fv(u('uAmp'), amp);
      gl.uniform1fv(u('uBrick'), br);
      gl.uniform1f(u('uMix'), g.skin.patch_mix === undefined ? 0.62 : g.skin.patch_mix);
      gl.uniform1f(u('uTint'), opts.tint === undefined ? 0.0 : opts.tint);
      gl.uniform1f(u('uFade'), opts.fade === undefined ? 45.0 : opts.fade);
      const b = g.skin.brick_m || [0.2032, 0.0635, 0.0095];
      gl.uniform3f(u('uBrickM'), b[0], b[1], b[2]);
      gl.drawElements(gl.TRIANGLES, n, gl.UNSIGNED_INT, 0);
      gl.bindVertexArray(null);
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
    },
  };
}

global.WalkGround = {createGround, grid, VS, FS};
})(typeof window === 'undefined' ? globalThis : window);
