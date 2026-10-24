// WebGL post-process: tile light squares w/ ordered dithering, glow lights, emissive bloom,
// color grading, rain/frost, and an optional palette snap ("color space" mode).
export const MAX_LIGHTS = 32;

const VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() { v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5); gl_Position = vec4(a_pos, 0.0, 1.0); }`;

// 24-colour palette used by palette-snap mode. Tuned for fire against darkness.
export const PALETTE = [
  '#0b0a10', '#16131f', '#241d30', '#2e2a3e', '#3e3a52', '#5a5670', '#8a86a0', '#c8c4d8',
  '#14241a', '#1f3a24', '#2f5a30', '#4a8040', '#7aa858',
  '#2a1a14', '#4a2c1c', '#6e4a2c', '#9a7048',
  '#5a1410', '#a82a18', '#e0561f', '#ff9a3a', '#ffd870', '#fff6d8',
  '#3aa0c8',
];

const FRAG = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_scene, u_emit, u_light;
uniform vec2 u_res, u_lmOrigin, u_lmSize;
uniform vec4 u_ls[${MAX_LIGHTS}];
uniform vec3 u_lc[${MAX_LIGHTS}];
uniform int u_n;
uniform float u_time, u_rain, u_cold, u_pal, u_flash, u_dead;
uniform vec3 u_palette[${PALETTE.length}];

float bayer2(vec2 a) { a = floor(a); return fract(dot(a, vec2(0.5, a.y * 0.75))); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec2 px = floor(v_uv * u_res) + 0.5;
  vec3 sc = texture2D(u_scene, v_uv).rgb;
  vec3 em = texture2D(u_emit, v_uv).rgb;

  // Walkable light squares (one texel per tile, nearest).
  vec2 lmUV = (px - u_lmOrigin) / (u_lmSize * 16.0);
  float L = texture2D(u_light, lmUV).r;

  // Soft glow from flame sources.
  vec3 glow = vec3(0.0);
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    if (i >= u_n) break;
    vec4 s = u_ls[i];
    float d = length(px - s.xy) / s.z;
    float a = s.w * max(0.0, 1.0 - d);
    glow += u_lc[i] * a * a;
  }

  // Dithered banding of the tile light: crisp pixel-art falloff.
  float dith = bayer4(px);
  float q = clamp(floor(L * 6.0 + dith) / 6.0, 0.0, 1.0);
  vec3 lightCol = mix(vec3(0.35, 0.38, 0.62), vec3(1.0, 0.86, 0.68), smoothstep(0.1, 0.8, q));
  float ambient = 0.018;
  vec3 col = sc * (ambient + q * lightCol * 1.55 + glow * (0.45 + 0.8 * q));

  // Emissive + bloom.
  vec3 bloom = vec3(0.0);
  vec2 texel = 1.0 / u_res;
  for (int i = 0; i < 12; i++) {
    float a = float(i) * 0.5236;
    vec2 dir = vec2(cos(a), sin(a));
    bloom += texture2D(u_emit, v_uv + dir * texel * 3.0).rgb * 0.5;
    bloom += texture2D(u_emit, v_uv + dir * texel * 7.0).rgb * 0.3;
    bloom += texture2D(u_emit, v_uv + dir * texel * 13.0).rgb * 0.2;
  }
  bloom /= 12.0;
  col += em + bloom * 0.9;

  // Rain: cooler, slightly darker world.
  col = mix(col, col * vec3(0.78, 0.86, 1.05), u_rain * 0.6);

  // Grade: lift shadows toward violet-blue, keep highlights warm, gentle tonemap.
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, col * vec3(0.82, 0.86, 1.25) + vec3(0.004, 0.003, 0.012), (1.0 - smoothstep(0.0, 0.3, lum)) * 0.7);
  col = mix(vec3(lum), col, 1.12);
  col = col / (1.0 + col * 0.18) * 1.12;

  // Vignette.
  vec2 c = v_uv - 0.5;
  float vig = 1.0 - dot(c, c) * 0.9;
  col *= vig;

  // Frost creeping in from the edges while freezing.
  if (u_cold > 0.0) {
    float edge = smoothstep(0.55 - u_cold * 0.35, 0.75, length(c * vec2(1.0, 1.3)) + (hash(floor(px / 2.0)) - 0.5) * 0.08);
    vec3 frost = vec3(0.62, 0.78, 0.95) * (0.35 + 0.25 * hash(floor(px / 3.0)));
    col = mix(col, frost, edge * u_cold);
    col = mix(col, vec3(dot(col, vec3(0.33))), u_cold * 0.5);
  }
  if (u_dead > 0.0) col = mix(col, vec3(dot(col, vec3(0.3, 0.5, 0.2))) * vec3(0.7, 0.75, 0.95), u_dead);
  col += vec3(1.0, 0.7, 0.4) * u_flash;

  if (u_pal > 0.5) {
    vec3 cc = col + (dith - 0.5) * 0.06;
    float best = 1e9; vec3 pick = cc;
    for (int i = 0; i < ${PALETTE.length}; i++) {
      vec3 d = cc - u_palette[i];
      float dist = dot(d * vec3(0.3, 0.59, 0.11), d) + dot(d, d) * 0.15;
      if (dist < best) { best = dist; pick = u_palette[i]; }
    }
    col = pick;
  }
  gl_FragColor = vec4(col, 1.0);
}`;

function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function makePost(canvas) {
  const gl = canvas.getContext('webgl', { antialias: false, premultipliedAlpha: false });
  if (!gl) return null;
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'a_pos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const U = {};
  for (const n of ['u_scene', 'u_emit', 'u_light', 'u_res', 'u_lmOrigin', 'u_lmSize', 'u_ls', 'u_lc', 'u_n', 'u_time', 'u_rain', 'u_cold', 'u_pal', 'u_flash', 'u_dead', 'u_palette']) U[n] = gl.getUniformLocation(prog, n);
  gl.uniform3fv(U.u_palette, new Float32Array(PALETTE.flatMap(hexToRgb)));

  const tex = (unit) => {
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };
  const tScene = tex(0), tEmit = tex(1), tLight = tex(2);
  gl.uniform1i(U.u_scene, 0); gl.uniform1i(U.u_emit, 1); gl.uniform1i(U.u_light, 2);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

  const ls = new Float32Array(MAX_LIGHTS * 4), lc = new Float32Array(MAX_LIGHTS * 3);

  return {
    // o: { scene, emit, lightData (Uint8Array), lmW, lmH, lmOriginX, lmOriginY, lights:[{x,y,r,i,c:[r,g,b]}], time, rain, cold, pal, flash, dead }
    render(o) {
      const w = o.scene.width, h = o.scene.height;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tScene);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, o.scene);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, tEmit);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, o.emit);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, tLight);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, o.lmW, o.lmH, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, o.lightData);
      const n = Math.min(MAX_LIGHTS, o.lights.length);
      for (let i = 0; i < n; i++) {
        const l = o.lights[i];
        ls.set([l.x, l.y, l.r, l.i], i * 4);
        lc.set(l.c, i * 3);
      }
      gl.uniform4fv(U.u_ls, ls); gl.uniform3fv(U.u_lc, lc); gl.uniform1i(U.u_n, n);
      gl.uniform2f(U.u_res, w, h);
      gl.uniform2f(U.u_lmOrigin, o.lmOriginX, o.lmOriginY);
      gl.uniform2f(U.u_lmSize, o.lmW, o.lmH);
      gl.uniform1f(U.u_time, o.time); gl.uniform1f(U.u_rain, o.rain); gl.uniform1f(U.u_cold, o.cold);
      gl.uniform1f(U.u_pal, o.pal ? 1 : 0); gl.uniform1f(U.u_flash, o.flash); gl.uniform1f(U.u_dead, o.dead);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
  };
}
