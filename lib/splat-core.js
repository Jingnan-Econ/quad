// The splat rasteriser, shared by every page that draws one.
//
// It lives here and not in a page because there are two pages now -- the single
// payload check at web/splat and the walkable one at web/walk -- and this
// project has been bitten before by one implementation existing twice and the
// two drifting apart. The camera, the controls and the streaming belong to the
// page. The shader, the sort and the upload belong here.
//
// Conventions worth stating once, because getting them wrong is silent:
//
//  * the payload is y-up. scripts/web/01_splat_payload.py bakes the rotation
//    out of the z-up scene frame and the sidecar records it, so a page checks
//    the sidecar rather than assuming;
//  * the view matrix's forward row is +f, because the projection divides by z
//    and a point in front has to come out with positive z;
//  * its up row is +u. It was -u once, which put camera y downward while the
//    projection sends +y to the top of the clip cube, and the covariance goes
//    through the same matrix, so the whole scene came out upside down and
//    mirrored with nothing looking torn;
//  * blending is premultiplied "over", so the sort has to be far to near.
window.SplatCore = (function(){
'use strict';

const VS = `#version 300 es
precision highp float; precision highp int;
uniform highp usampler2D uData;
uniform mat4 uView, uProj;
uniform vec2 uFocal, uViewport;
uniform vec4 uSkyPlane;          // xyz: up in this payload's frame; w: where the sky starts
uniform float uSkyFade;          // 0 keeps the backdrop, 1 takes it away
in vec2 aCorner;
in uint aIndex;
out vec4 vColour;
out vec2 vPos;

mat3 quatToMat(vec4 q){          // q is (w, x, y, z), already unit length
  float w=q.x, x=q.y, y=q.z, z=q.w;
  return mat3(
    1.0-2.0*(y*y+z*z), 2.0*(x*y+w*z),     2.0*(x*z-w*y),
    2.0*(x*y-w*z),     1.0-2.0*(x*x+z*z), 2.0*(y*z+w*x),
    2.0*(x*z+w*y),     2.0*(y*z-w*x),     1.0-2.0*(x*x+y*y));
}

void main(){
  int i = int(aIndex);
  ivec2 tx = ivec2((i & 0x3ff) << 1, i >> 10);
  uvec4 a = texelFetch(uData, tx, 0);
  uvec4 b = texelFetch(uData, ivec2(tx.x | 1, tx.y), 0);

  vec3 centre = uintBitsToFloat(a.xyz);
  // The backdrop, when the eye has climbed above it. This model paints a sky
  // out of a few thousand very large gaussians standing over the roofs; from a
  // camera above them the campus is seen through the backdrop and comes out
  // white. uSkyPlane.xyz is which way up is in this payload's frame -- the two
  // pages do not agree on that -- and .w is the height the backdrop starts at.
  // uSkyFade is 0 for every camera under it, so a page that never sets these
  // draws exactly what it always drew.
  float skyKeep = (uSkyFade > 0.0 && dot(centre, uSkyPlane.xyz) > uSkyPlane.w)
                  ? 1.0 - uSkyFade : 1.0;
  if (skyKeep < 0.004) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  vec4 cam = uView * vec4(centre, 1.0);
  vec4 clip = uProj * cam;
  // Behind, or far enough off screen that its quad cannot reach back in. The
  // margin is 1.8 rather than 1.35 because it is a test on the centre and the
  // quad is now twice as wide as it was: at 1.35 a large gaussian just off the
  // edge vanished while it was still covering pixels, which reads as popping
  // when you turn. 1.8 in clip space is the same window check_splat.py uses in
  // pixels, so the two agree about what is on screen as well as how it draws.
  if (clip.w <= 0.0 || any(greaterThan(abs(clip.xyz), vec3(1.8, 1.8, 1.0) * clip.w))) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }

  vec3 scale = uintBitsToFloat(b.xyz);
  vec4 qb = vec4(uvec4(b.w & 0xffu, (b.w >> 8) & 0xffu,
                       (b.w >> 16) & 0xffu, (b.w >> 24) & 0xffu)) / 128.0 - 1.0;
  mat3 M = quatToMat(normalize(qb)) * mat3(scale.x, 0.0, 0.0,
                                           0.0, scale.y, 0.0,
                                           0.0, 0.0, scale.z);
  mat3 sigma = M * transpose(M);

  // The 3D covariance through the perspective projection, to first order.
  // The linearisation is only good near the optical axis: a gaussian close to
  // the eye and out towards the edge of the frame projects to an ellipse tens
  // of times too long, and draws as a streak across the picture. Clamping the
  // point the Jacobian is taken at to 1.3 times the field of view is what the
  // CUDA rasteriser the model was fitted with does, and it is why its renders
  // have no streaks in them and ours did.
  float iz = 1.0 / cam.z;
  vec2 lim = 1.3 * uViewport / (2.0 * uFocal);
  vec2 tt = clamp(cam.xy * iz, -lim, lim) * cam.z;
  mat3 J = mat3(uFocal.x * iz, 0.0, 0.0,
                0.0, uFocal.y * iz, 0.0,
                -uFocal.x * tt.x * iz * iz, -uFocal.y * tt.y * iz * iz, 0.0);
  mat3 T = J * mat3(uView);
  mat3 c2 = T * sigma * transpose(T);
  float ca = c2[0][0] + 0.3, cb = c2[0][1], cc = c2[1][1] + 0.3;

  float mid = 0.5 * (ca + cc);
  float rad = sqrt(max(0.02, mid * mid - (ca * cc - cb * cb)));
  float l1 = mid + rad, l2 = max(mid - rad, 0.02);
  if (l1 < 0.35) {                       // smaller than a pixel: not worth a quad
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  vec2 e1 = normalize(abs(cb) < 1e-8 ? vec2(1.0, 0.0) : vec2(cb, l1 - ca));
  vec2 major = min(sqrt(2.0 * l1), 900.0) * e1;
  vec2 minor = min(sqrt(2.0 * l2), 900.0) * vec2(e1.y, -e1.x);

  uvec4 col = uvec4(a.w & 0xffu, (a.w >> 8) & 0xffu,
                    (a.w >> 16) & 0xffu, (a.w >> 24) & 0xffu);
  vColour = vec4(col) / 255.0;
  vColour.a *= skyKeep;
  // The quad has to be as wide as the falloff written in the fragment shader,
  // and it was half as wide. aCorner runs to 1, vPos to 2, so a corner sits at
  // p = -4; a pixel d along the major axis must land at p = -0.5*d*d/l1, which
  // needs the half extent to be 2*sqrt(2*l1) rather than sqrt(2*l1). With the
  // old factor every gaussian in the scene was drawn at half its own width:
  // surfaces stopped overlapping, the ground broke into speckle and walls read
  // as see-through. The same arithmetic was wrong the same way in
  // scripts/web/check_splat.py, so every check agreed with it.
  vPos = aCorner * 2.0;
  vec2 off = (aCorner.x * major + aCorner.y * minor) * 4.0 / uViewport;
  gl_Position = vec4(clip.xy / clip.w + off, clip.z / clip.w, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec4 vColour;
in vec2 vPos;
out vec4 oColour;
void main(){
  float p = -dot(vPos, vPos);      // -0.5 * d' * inv(cov2d) * d, by construction
  if (p < -4.0) discard;           // the inscribed disc: square corners are not gaussian
  float alpha = exp(p) * vColour.a;
  if (alpha < 0.004) discard;
  oColour = vec4(vColour.rgb * alpha, alpha);   // premultiplied
}`;

const SORTER = `
let pos = null, n = 0;
self.onmessage = e => {
  if (e.data.positions) { pos = e.data.positions; n = pos.length / 3; return; }
  if (!pos) return;
  const v = e.data.view;                       // third row of the view matrix
  const d = new Int32Array(n);
  let lo = 1e30, hi = -1e30;
  for (let i = 0; i < n; i++) {
    // negated, so that sorting ascending puts the far ones first. Premultiplied
    // "over" blending composites back to front; near first draws it inside out.
    const z = v[0]*pos[3*i] + v[1]*pos[3*i+1] + v[2]*pos[3*i+2];
    d[i] = -z * 4096 | 0;
    if (d[i] < lo) lo = d[i];
    if (d[i] > hi) hi = d[i];
  }
  // counting sort: far to near, so premultiplied over-blending composites right
  const B = 65536, cnt = new Uint32Array(B), s = (B - 1) / Math.max(hi - lo, 1);
  for (let i = 0; i < n; i++) { d[i] = (d[i] - lo) * s | 0; cnt[d[i]]++; }
  let run = 0;
  for (let i = 0; i < B; i++) { const c = cnt[i]; cnt[i] = run; run += c; }
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[cnt[d[i]]++] = i;
  self.postMessage({order}, [order.buffer]);
};`;

const sub = (a,b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
const dot = (a,b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const cross = (a,b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const norm = a => { const l = Math.hypot(a[0],a[1],a[2]) || 1;
                    return [a[0]/l, a[1]/l, a[2]/l]; };

function lookAt(eye, target, up){
  const f = norm(sub(target, eye));
  const r = norm(cross(f, up)), u = cross(r, f);
  return [ r[0], u[0], f[0], 0,
           r[1], u[1], f[1], 0,
           r[2], u[2], f[2], 0,
           -dot(r,eye), -dot(u,eye), -dot(f,eye), 1 ];
}

function proj(w, h, fovDeg, near, far){
  const fy = h / (2*Math.tan(fovDeg*Math.PI/360)), fx = fy;
  return { m: [2*fx/w,0,0,0, 0,2*fy/h,0,0, 0,0,far/(far-near),1,
               0,0,-far*near/(far-near),0], fx, fy };
}

function shader(gl, type, src){
  const s = gl.createShader(type);
  gl.shaderSource(s, src.trim()); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
    throw new Error(gl.getShaderInfoLog(s));
  return s;
}

// A gaussian is 32 bytes: position (3 floats), scale (3 floats), colour and
// opacity (4 bytes), rotation (4 bytes). The texture is two texels wide per
// gaussian, 1024 gaussians a row, which is what the vertex shader indexes.
//
// The file's word order is not the texture's. The shader reads the first texel
// as (position, colour) and the second as (scale, rotation), because it wants
// the centre and the colour together and only fetches the second texel for the
// gaussians it did not already cull. So the four words between the position
// and the rotation have to rotate on the way in; see setData.
function createRenderer(gl){
  const prog = gl.createProgram();
  gl.attachShader(prog, shader(gl, gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, shader(gl, gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  const uni = {};
  for (const k of ['uData','uView','uProj','uFocal','uViewport','uSkyPlane','uSkyFade'])
    uni[k] = gl.getUniformLocation(prog, k);

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, 1,1, -1,1]),
                gl.STATIC_DRAW);
  const aCorner = gl.getAttribLocation(prog, 'aCorner');
  gl.enableVertexAttribArray(aCorner);
  gl.vertexAttribPointer(aCorner, 2, gl.FLOAT, false, 0, 0);

  const idxBuf = gl.createBuffer();
  const aIndex = gl.getAttribLocation(prog, 'aIndex');
  gl.bindBuffer(gl.ARRAY_BUFFER, idxBuf);
  gl.enableVertexAttribArray(aIndex);
  gl.vertexAttribIPointer(aIndex, 1, gl.UNSIGNED_INT, 0, 0);
  gl.vertexAttribDivisor(aIndex, 1);

  const tex = gl.createTexture();
  let count = 0;
  // No backdrop to take away until a page says there is one, so this renders
  // what it always rendered. See the shader's uSkyPlane.
  let skyPlane = [0, 0, 1, 1e9], skyFade = 0;

  return {
    get count(){ return count; },
    /** up in the payload's own frame, the height the sky starts at, and how
     *  much of it to take away (0 keeps all of it) */
    setSky(up, height, fade){
      skyPlane = [up[0], up[1], up[2], height];
      skyFade = fade > 0 ? Math.min(fade, 1) : 0;
    },
    /** bytes: a Uint8Array of n*32, tightly packed */
    setData(bytes, n){
      count = n;
      const rows = Math.ceil(n / 1024);
      const words = new Uint32Array(2048 * rows * 4);
      words.set(new Uint32Array(bytes.buffer, bytes.byteOffset, n * 8));
      // file order is p p p s s s c q, the shader reads p p p c | s s s q, so
      // rotate the middle four right by one. Getting this wrong does not show
      // up as a wrong colour: the colour word lands in the z scale, where an
      // rgba8 bit pattern reads as a float near 1e29, the covariance is
      // quadratic in the scale so the projected conic overflows, and the NaN
      // quad that comes out of it is one the GPU silently never draws.
      for (let i = 0, o = 0; i < n; i++, o += 8) {
        const c = words[o + 6];
        words[o + 6] = words[o + 5];
        words[o + 5] = words[o + 4];
        words[o + 4] = words[o + 3];
        words[o + 3] = c;
      }
      // Same reason as draw: this sets a sampler uniform, and rebuild() calls
      // it from the middle of a frame in which another pass may have left its
      // own program current. Without this the uniform1i below is INVALID_
      // OPERATION and the error surfaces on a draw call that is not at fault.
      gl.useProgram(prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32UI, 2048, rows, 0,
                    gl.RGBA_INTEGER, gl.UNSIGNED_INT, words);
      for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER])
        gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
      for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T])
        gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
      gl.uniform1i(uni.uData, 0);
    },
    setOrder(order){
      gl.bindBuffer(gl.ARRAY_BUFFER, idxBuf);
      gl.bufferData(gl.ARRAY_BUFFER, order, gl.DYNAMIC_DRAW);
    },
    // `clear` is false when something else has already painted the frame --
    // the walkable page draws a procedural ground under the splats and has to
    // own the clear so its pass is not wiped by this one.
    draw(view, p, w, h, n, clear = true){
      // The program is bound at setup and was, until something else drew into
      // the same context, still bound here. The walkable page's ground pass
      // switches programs, and every uniform call below then landed on that
      // one: GL error 1282 and a frame of nonsense. A draw call that depends
      // on nobody else having touched the context is not a draw call.
      gl.useProgram(prog);
      // The blend mode and the depth state used to be set once at creation,
      // which is a bet that nothing else ever draws into this context. The
      // walkable page's ground pass disables blending to draw an opaque
      // surface, and every splat after it then REPLACED the pixel with its own
      // premultiplied colour instead of compositing over: a frame five times
      // too dark, with no error anywhere. Premultiplied over, every draw.
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA,
                           gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.viewport(0, 0, w, h);
      if (clear) {
        gl.clearColor(0.055, 0.070, 0.086, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      gl.uniformMatrix4fv(uni.uView, false, view);
      gl.uniformMatrix4fv(uni.uProj, false, p.m);
      gl.uniform2f(uni.uFocal, p.fx, p.fy);
      gl.uniform2f(uni.uViewport, w, h);
      gl.uniform4f(uni.uSkyPlane, skyPlane[0], skyPlane[1], skyPlane[2], skyPlane[3]);
      gl.uniform1f(uni.uSkyFade, skyFade);
      gl.drawArraysInstanced(gl.TRIANGLE_FAN, 0, 4, n);
    },
  };
}

function createSorter(onOrder){
  const w = new Worker(URL.createObjectURL(
    new Blob([SORTER], {type:'text/javascript'})));
  w.onmessage = e => onOrder(e.data.order);
  return {
    setPositions(pos){ w.postMessage({positions: pos}, [pos.buffer]); },
    sort(viewRow){ w.postMessage({view: viewRow}); },
  };
}

return {VS, FS, SORTER, createRenderer, createSorter,
        lookAt, proj, sub, dot, cross, norm};
})();
