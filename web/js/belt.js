/* JitsFlow home page: the belt, the mat and the flow, in WebGL. Loaded by the #belt-js snippet in src/landing.html once
   the page has loaded and the browser is idle; never with reduced motion or Save-Data.

   One canvas (#beltgl), fixed to the viewport between the sections' backgrounds and their text, draws three things:
   - the mat: a tatami floor in perspective under the hero, strongest at the bottom and gone before the headline;
   - the belt: one cloth belt that lies in each numbered page's margin (the .beltslot boxes, which hold a drawing of it for
     everyone without WebGL) and flows between them as you scroll, along the right-hand margin where there's no text. It
     goes white, blue, purple, brown, black, taking four stripes of tape on the way to each new colour, and ties itself
     into a knot beside the last call to action;
   - the flow: on the position map, a glowing line through the cards of one real chain (the page numbers them), drawn as
     the map scrolls into view and ending in a tap.
   Plain WebGL 1, no library. It draws only while something moves (scrolling, or a few seconds after), and only the parts
   on screen; it stops when the tab is hidden and frees everything on pagehide. Lighter mode on modest phones (deviceMemory
   under 4 GB, 4 cores or fewer, or slow first frames): pixel ratio 1, half the segments, no particles. If WebGL is missing
   or anything goes wrong it removes itself and the drawings stay. */

const D = document, H = D.documentElement, W = window;
const RM = W.matchMedia("(prefers-reduced-motion: reduce)"), DARK = W.matchMedia("(prefers-color-scheme: dark)");

// Belt colours (a little deeper than the page's flat swatches: the shader lights them), and the rank bar: black, or red on a black belt.
const RANK = ["white", "blue", "purple", "brown", "black"];
const COL = { white: [0.9, 0.9, 0.87], blue: [0.11, 0.29, 0.68], purple: [0.35, 0.17, 0.53], brown: [0.41, 0.25, 0.15], black: [0.075, 0.075, 0.08] };
const BAR_RED = [0.7, 0.14, 0.12], BAR_BLACK = [0.045, 0.045, 0.05];

// The knot by the last call, front view, in units of the slot: the tail with the bar hangs left, up through the knot, once
// round the waist (the back of the loop further away), back through the knot, over the top and down the front, out as
// the other tail. Points are [x, y, z, twist]; z (towards you) keeps the crossings apart.
const KNOT = [
  [-0.2, 0.47, 0, 0], [-0.14, 0.27, 0.01, 0.25], [-0.06, 0.07, 0.03, 0], [-0.01, -0.05, 0.02, 0],
  [0.16, -0.1, 0.05, 0], [0.37, -0.14, 0.03, 0], [0.46, -0.23, 0, 0], [0.34, -0.32, -0.06, 0], [0, -0.35, -0.08, 0],
  [-0.34, -0.32, -0.06, 0], [-0.46, -0.23, 0, 0], [-0.37, -0.14, 0.03, 0], [-0.16, -0.1, 0.05, 0],
  [-0.03, -0.07, -0.01, 0], [0.05, -0.15, 0, 0], [0.04, -0.2, 0.07, 0], [-0.02, -0.09, 0.11, 0], [0.02, 0.04, 0.1, 0],
  [0.1, 0.17, 0.05, -0.2], [0.19, 0.33, 0.02, 0], [0.25, 0.47, 0, 0],
];

const HP = "#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n";
const HASH = "float hash(vec2 p){vec3 q=fract(vec3(p.xyx)*.1031);q+=dot(q,q.yzx+33.33);return fract((q.x+q.y)*q.z);}\n";

const VS_MAT = "attribute vec2 aP;void main(){gl_Position=vec4(aP,0.,1.);}";
// The mat: 2:1 tatami in running bond, seen from standing height, with soft seams, a little tone between mats, vinyl grain
// and the sheen of the overhead lights. It drifts slower than the page (parallax) and fades out towards the headline.
const FS_MAT = HP + HASH + `
uniform vec4 uR; // the hero in CSS px from the viewport's top left: x, y, w, h
uniform vec4 uV; // pixel ratio, drawing buffer height, scroll, quality
void main(){
  vec2 px=vec2(gl_FragCoord.x,uV.y-gl_FragCoord.y)/uV.x, q=(px-uR.xy)/uR.zw;
  float yy=1.-q.y, den=yy*.75+.5, k=5.;
  vec2 m=vec2((q.x-.6)*uR.z/uR.w*k*1.1/den, k/den+uV.z*.0011);
  float fw=k*.75/(den*den)/uR.w*1.6+.002;
  float r=floor(m.y), mx=m.x*.5+.5*mod(r,2.);
  float seam=min(abs(fract(mx+.5)-.5)*2.,abs(fract(m.y+.5)-.5));
  float line=1.-smoothstep(.011,.011+fw,seam);
  vec3 mat=vec3(.066,.11,.228)*(.93+.14*hash(vec2(floor(mx),r)+7.));
  mat+=vec3(.018,.026,.05)*smoothstep(.09+fw,0.,fract(m.y));
  if(uV.w>.5)mat*=.975+.05*hash(floor(px*1.5));
  vec2 d=(q-vec2(.28,.9))*vec2(1.,2.6);
  mat+=vec3(.035,.05,.09)*exp(-dot(d,d)*2.5);
  vec3 col=mix(mat,vec3(.035,.058,.125),line*.75);
  float a=smoothstep(.74,.28,yy)*.95;
  gl_FragColor=vec4(col*a,a);
}`;

const VS_BELT = `
attribute vec3 aP;attribute vec3 aN;attribute vec3 aS;
uniform vec3 uV; // viewport w, h, camera distance (CSS px)
varying vec3 vN;varying vec3 vS;
void main(){
  float w=(uV.z-aP.z)/uV.z;vN=aN;vS=aS;
  gl_Position=vec4(aP.x/uV.x*2.-1.,1.-aP.y/uV.y*2.,-aP.z*.0005*w,w);
}`;
// The belt: lengthwise rows of stitching over a fine weave, thick edges, soft studio light from the top left, a rim of
// light on dark pages, the rank bar near the tip with up to four stripes of white tape, and a wipe to the next colour.
const FS_BELT = HP + HASH + `
varying vec3 vN;varying vec3 vS; // normal; along (0-1), across (-1 to 1), length from the tip in px
uniform vec3 uA;uniform vec3 uB;uniform vec3 uBarA;uniform vec3 uBarB;
uniform vec4 uBar; // bar from, bar to (px from the tip), stripes, how far the newest stripe is wrapped
uniform vec4 uM;   // wipe (0-1 along), mode (0 belt, 1 shadow), shadow alpha, half width in device px
uniform float uDark;
void main(){
  float v=vS.y,len=vS.z,av=abs(v);
  if(uM.y>.5){float a=smoothstep(1.,.1,av)*uM.z;gl_FragColor=vec4(0.,0.,0.,a);return;}
  bool nb=vS.x<uM.x;
  vec3 col=nb?uB:uA;
  float bar=step(uBar.x,len)*step(len,uBar.y);
  col=mix(col,nb?uBarB:uBarA,bar);
  float tape=0.,gap=(uBar.y-uBar.x)/5.2;
  if(!nb&&bar>0.){for(int k=0;k<4;k++){float fk=float(k);if(fk<uBar.z){
    float g=fk+1.>=uBar.z?uBar.w:1.;tape=max(tape,step(abs(len-uBar.x-(fk+.9)*gap),gap*.22)*step(-1.+2.*(1.-g),v*.999));}}}
  col=mix(col,vec3(.95,.95,.92),tape);
  float row=fract((v*.5+.5)*8.),ridge=sin(row*3.1416);
  float stitch=smoothstep(.16,.02,abs(row-.5))*step(.4,fract(len/3.4))*(1.-tape);
  vec3 n=normalize(vN);if(n.z<0.)n=-n;
  vec3 L=normalize(vec3(-.35,-.6,.72));
  float diff=clamp((dot(n,L)+.35)/1.35,0.,1.);
  float spec=pow(max(dot(n,normalize(L+vec3(0.,0.,1.))),0.),24.)*(tape>0.?.4:.09);
  float rim=pow(1.-abs(n.z),1.6)*(.08+.4*uDark);
  col*=(.36+.74*diff+.07*uDark)*(.9+.1*ridge)*(1.-.16*stitch)*(.97+.06*hash(floor(vec2(len*1.4,(v*.5+.5)*14.))));
  col+=spec+rim*vec3(.55,.65,.95);
  col*=mix(1.,.7,smoothstep(.8,1.,av));
  float a=clamp((1.-av)*uM.w,0.,1.);
  gl_FragColor=vec4(col*a,a);
}`;

const VS_GLOW = `
attribute vec2 aP;attribute vec4 aU;
uniform vec2 uV;
varying vec4 vU;
void main(){vU=aU;gl_Position=vec4(aP.x/uV.x*2.-1.,1.-aP.y/uV.y*2.,0.,1.);}`;
// The flow: kind 0 a line (soft core and halo), 1 a ring round a position, 2 a particle.
const FS_GLOW = HP + `
varying vec4 vU;uniform vec4 uC;
void main(){
  vec2 u=vU.xy;float a;
  if(vU.z<.5)a=exp(-u.y*u.y*14.)+exp(-u.y*u.y*2.5)*.3;
  else if(vU.z<1.5){float d=length(u);a=exp(-pow((d-.72)*9.,2.))+exp(-d*d*5.)*.12;}
  else a=exp(-dot(u,u)*4.5);
  a*=uC.a*vU.w;gl_FragColor=vec4(uC.rgb*a,a);
}`;

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const ss = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

let gl = null, cv = null, P = {}, B = {}, ext = null, io = null, ro = null, alive = false;
let low = false, N = 150, dpr = 1, cw = 0, ch = 0;
let L = null, cur, bv, gv;
let raf = 0, lastT = 0, lastAct = 0, lastSy = 0, energy = 0, time = 0, intro = 1, shown = false;
let heroOn = true, mapOn = false, probe = [], probed = false;
const stat = { frames: 0, tier: "", errors: 0 };

function boot() {
  if (alive || RM.matches || (navigator.connection && navigator.connection.saveData)) return;
  const apple = /iP(hone|ad|od)/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && "ontouchend" in D);
  // iPhones report few cores whatever they have, so there the first frames decide.
  low = !!((navigator.deviceMemory && navigator.deviceMemory < 4) || (!apple && navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4));
  cv = D.createElement("canvas");
  cv.id = "beltgl";
  cv.setAttribute("aria-hidden", "true");
  try {
    gl = cv.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false, depth: true, stencil: false,
      powerPreference: "low-power", failIfMajorPerformanceCaveat: true });
  } catch (e) { gl = null; }
  if (!gl) { cv = null; return; }
  try {
    P.mat = program(VS_MAT, FS_MAT, ["aP"]);
    P.belt = program(VS_BELT, FS_BELT, ["aP", "aN", "aS"]);
    P.glow = program(VS_GLOW, FS_GLOW, ["aP", "aU"]);
  } catch (e) { teardown(); return; }
  ext = gl.getExtension("WEBGL_lose_context");
  B.quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, B.quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  B.belt = gl.createBuffer();
  B.glow = gl.createBuffer();
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.depthFunc(gl.LEQUAL);
  gl.clearColor(0, 0, 0, 0);
  Object.defineProperty(cv, "jf", { value: stat });  // read by tests/web.js
  D.body.appendChild(cv);
  alive = true;
  tier(low);
  cv.addEventListener("webglcontextlost", (e) => { e.preventDefault(); teardown(); });
  W.addEventListener("scroll", kick, { passive: true });
  W.addEventListener("resize", relayout, { passive: true });
  D.addEventListener("visibilitychange", onVis);
  RM.addEventListener && RM.addEventListener("change", onCalm);
  io = new IntersectionObserver((es) => {
    es.forEach((e) => { if (e.target.classList.contains("night")) heroOn = e.isIntersecting; else mapOn = e.isIntersecting; });
    kick();
  });
  const night = D.querySelector(".night"), map = D.querySelector(".posmap");
  if (night) io.observe(night);
  if (map) io.observe(map);
  if (W.ResizeObserver) { ro = new ResizeObserver(relayout); ro.observe(D.body); }
  relayout();
}

function program(vs, fs, attrs) {
  const p = gl.createProgram();
  [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]].forEach(([t, src]) => {
    const s = gl.createShader(t);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error("shader");
    gl.attachShader(p, s);
    gl.deleteShader(s);
  });
  attrs.forEach((a, i) => gl.bindAttribLocation(p, i, a));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("link");
  const u = {};
  for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i < n; i++) {
    const name = gl.getActiveUniform(p, i).name;
    u[name] = gl.getUniformLocation(p, name);
  }
  return { p, u, n: attrs.length };
}

function use(pr) {
  gl.useProgram(pr.p);
  for (let i = 0; i < 3; i++) (i < pr.n ? gl.enableVertexAttribArray : gl.disableVertexAttribArray).call(gl, i);
  return pr.u;
}

// Quality: the pixel ratio (1.5 at most), the belt's segments, the flow's particles.
function tier(isLow) {
  low = isLow;
  stat.tier = low ? "light" : "full";
  N = low ? 72 : 150;
  cur = new Float32Array((N + 1) * 4);
  bv = new Float32Array((N + 1) * 2 * 9 * 2);
  gv = new Float32Array(4096 * 6);
  dpr = low ? 1 : Math.min(1.5, W.devicePixelRatio || 1);
  if (alive) relayout();
}

// Layout, in page coordinates: measured on load, resize and whenever the page's height changes (fonts, an open FAQ),
// never during a frame.
let pendingLayout = false;
function relayout() {
  if (pendingLayout || !alive) return;
  pendingLayout = true;
  requestAnimationFrame(() => { pendingLayout = false; if (alive) { measure(); kick(); } });
}

function measure() {
  const w = cv.clientWidth, h = cv.clientHeight;
  if (Math.round(w * dpr) !== cv.width || Math.round(h * dpr) !== cv.height) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  cw = w; ch = h;
  const sx = W.scrollX, sy = W.scrollY;
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + sx, y: r.top + sy, w: r.width, h: r.height }; };
  const narrow = cw < 760;
  const st = [];
  D.querySelectorAll(".beltslot").forEach((el) => {
    const r = box(el);
    if (r.w < 30 || r.h < 30) return;
    r.belt = COL[el.dataset.belt] ? el.dataset.belt : "black";
    r.kind = el.dataset.pose || "wave";
    r.hw = r.kind === "knot" ? Math.min(r.w, r.h * 1.15) * 0.036 : narrow ? 6.5 : r.kind === "lie" ? 10 : 9;
    r.tilt = r.kind === "lie" ? 0.5 : 0;
    r.navy = !!el.closest(".night,.final,.gyms");
    r.pts = shape(r.kind, r.w, r.h);
    if (r.kind === "knot") r.pre = shape("flat", r.w, r.h);
    r.minX = 1e9;
    for (let i = 0; i <= N; i++) r.minX = Math.min(r.minX, (r.pre || r.pts)[i * 4]);
    st.push(r);
  });
  const night = D.querySelector(".night");
  const chain = [].slice.call(D.querySelectorAll(".posmap .pcard[data-step]"))
    .sort((a, b) => a.dataset.step - b.dataset.step)
    .map((a) => { const r = box(a.querySelector("img") || a); return { x: r.x + r.w / 2, y: r.y + r.h / 2, r: Math.min(r.w, r.h) * 0.42 }; });
  L = { st, hero: night ? box(night) : null, chain };
}

// Belt shapes, sampled evenly along their length so the weave, the bar and the stripes keep their size.
function resample(fn) {
  const M = 360, raw = new Float32Array((M + 1) * 4), cum = new Float32Array(M + 1);
  for (let i = 0; i <= M; i++) {
    raw.set(fn(i / M), i * 4);
    if (i) cum[i] = cum[i - 1] + Math.hypot(raw[i * 4] - raw[i * 4 - 4], raw[i * 4 + 1] - raw[i * 4 - 3], raw[i * 4 + 2] - raw[i * 4 - 2]);
  }
  const out = new Float32Array((N + 1) * 4);
  for (let i = 0, j = 0; i <= N; i++) {
    const want = (cum[M] * i) / N;
    while (j < M - 1 && cum[j + 1] < want) j++;
    const f = clamp((want - cum[j]) / Math.max(1e-6, cum[j + 1] - cum[j]), 0, 1);
    for (let c = 0; c < 4; c++) out[i * 4 + c] = raw[j * 4 + c] + (raw[j * 4 + 4 + c] - raw[j * 4 + c]) * f;
  }
  return out;
}

function spline(pts) {
  const n = pts.length - 1;
  return (u) => {
    const f = Math.min(n - 1e-6, u * n), i = Math.floor(f), t = f - i, t2 = t * t, t3 = t2 * t;
    const a = pts[Math.max(i - 1, 0)], b = pts[i], c = pts[i + 1], d = pts[Math.min(i + 2, n)];
    return b.map((_, k) => 0.5 * (2 * b[k] + (c[k] - a[k]) * t + (2 * a[k] - 5 * b[k] + 4 * c[k] - d[k]) * t2 + (3 * b[k] - a[k] - 3 * c[k] + d[k]) * t3));
  };
}

function shape(kind, w, h) {
  if (kind === "knot") {
    const S = Math.min(w, h * 1.15);
    return resample(spline(KNOT.map(([x, y, z, t]) => [w / 2 + x * S, h / 2 + y * S, z * S, t])));
  }
  // A belt dropped on the mat (lie) or laid in the margin: a long wave, with a loop in it (lie, curl) or a half twist (wave).
  const loop = kind === "lie" || kind === "curl", a = kind === "lie" ? 0.4 : 0.5, b = a + 0.24;
  const R = Math.min(h * (kind === "lie" ? 0.3 : 0.24), w * 0.085);
  const amp = kind === "flat" ? 0.1 : kind === "lie" ? 0.14 : 0.22, ph = kind === "wave2" ? 2.6 : 0.5, fq = kind === "flat" ? 0.75 : 0.95;
  const twist = kind === "wave" || kind === "wave2" ? Math.PI : 0;
  return resample((u) => {
    const phi = loop ? 2 * Math.PI * ss(a, b, u) : 0;
    return [w * (0.03 + 0.94 * u) + R * Math.sin(phi),
      h * ((kind === "lie" ? 0.42 : 0.55) + amp * Math.sin(u * 2 * Math.PI * fq + ph)) - R * (1 - Math.cos(phi)) + (loop ? R * 0.45 : 0),
      loop ? 8 * ss(a, b, u) : 0,
      twist * ss(0.44, 0.6, u)];
  });
}

function kick() {
  lastAct = performance.now();
  if (!raf && alive && !D.hidden) raf = requestAnimationFrame(frame);
}
function onVis() {
  if (D.hidden) { cancelAnimationFrame(raf); raf = 0; lastT = 0; } else kick();
}
function onCalm() { if (RM.matches) teardown(); }

function frame(now) {
  raf = 0;
  if (!alive || !L) return;
  try {
    const dt = lastT ? Math.min(0.05, (now - lastT) / 1000) : 1 / 60;
    lastT = now;
    if (!probed && stat.frames > 8) {  // the first second of frames: too slow on this device means the light mode
      probe.push(dt);
      if (probe.length >= 40) {
        probed = true;
        probe.sort((x, y) => x - y);
        if (!low && probe[20] > 0.024) tier(true);
      }
    }
    const sy = W.scrollY, vis = W.innerHeight || ch;
    const k = 1 - Math.exp(-dt * 2.4);
    energy += (Math.min(1, Math.abs(sy - lastSy) / Math.max(dt, 0.008) / 1800) - energy) * k;
    lastSy = sy;
    time += dt * (0.35 + energy * 2.4);
    intro = Math.max(0, intro - dt / 1.6);
    draw(sy, vis);
    stat.frames++;
    if (!shown) { shown = true; H.classList.add("gl"); }
    if (intro > 0 || energy > 0.01 || now - lastAct < (mapOn ? 6000 : 2500)) raf = requestAnimationFrame(frame);
    else lastT = 0;
  } catch (e) {
    stat.errors++;
    teardown();
  }
}

function draw(sy, vis) {
  gl.viewport(0, 0, cv.width, cv.height);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  const sx = W.scrollX, dark = DARK.matches ? 1 : 0;
  // the mat
  const hr = L.hero;
  if (hr && heroOn && hr.y - sy < ch && hr.y + hr.h - sy > 0) {
    const top = Math.max(0, hr.y - sy), bot = Math.min(ch, hr.y + hr.h - sy);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, Math.round(cv.height - bot * dpr), cv.width, Math.round((bot - top) * dpr));
    const u = use(P.mat);
    gl.bindBuffer(gl.ARRAY_BUFFER, B.quad);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.uniform4f(u.uR, hr.x - sx, hr.y - sy, hr.w, hr.h);
    gl.uniform4f(u.uV, dpr, cv.height, sy, low ? 0 : 1);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disable(gl.SCISSOR_TEST);
  }
  if (mapOn && L.chain.length > 1) flow(sx, sy, vis);
  if (L.st.length) belt(sx, sy, vis, dark);
}

// The belt: where it is, its colour and its stripes, then its mesh. Between two slots it never crosses the text: it
// slides out of its slot sideways (the slot's band is empty) off the right edge, hangs in the right-hand margin while
// it's between pages, then slides into the next slot from the right. The knot arrives as a plain belt and ties itself.
function belt(sx, sy, vis, dark) {
  const st = L.st, n = st.length, mid = sy + vis * 0.4;  // where you're reading: a little above the middle
  let k = -1;
  for (let i = 0; i < n; i++) if (st[i].y + st[i].h / 2 <= mid) k = i;
  let a = Math.max(k, 0), b = a, t = 0, fmax = 0;
  if (k >= 0 && k < n - 1) {
    const da = (st[k].y + st[k].h / 2 - mid) / vis, db = (st[k + 1].y + st[k + 1].h / 2 - mid) / vis, g = db - da, A = 0.26;
    b = k + 1;
    t = g <= 2 * A ? -da / g : clamp((-da - A) / (g - 2 * A), 0, 1);
    fmax = ss(0.7, 1.3, g);  // slots close together: straight from one to the next, offstage
  }
  const SA = st[a], SB = st[b], second = t >= 0.5, S = second ? SB : SA;
  const slide = second ? 1 - ss(0.78, 0.9, t) : ss(0, 0.2, t);
  const tie = second && S.pre ? ss(0.9, 1, t) : 1;
  const f = fmax * (second ? 1 - ss(0.6, 0.8, t) : ss(0.2, 0.4, t));
  const off = (cw + 24 - S.x - S.minX) * slide, ox = S.x - sx + off, oy = S.y - sy;
  const gut = (cw - Math.min(1120, cw)) / 2 + 20, xc = cw - gut * 0.5, flyHw = cw < 760 ? 6 : 9;
  const e = energy * (1 - f) + intro * 0.6, ti = time, pts = S.pts, pre = S.pre || pts;
  for (let i = 0; i <= N; i++) {
    const s = i / N, o = i * 4;
    let x = ox + pre[o] + (pts[o] - pre[o]) * tie, y = oy + pre[o + 1] + (pts[o + 1] - pre[o + 1]) * tie;
    let z = pre[o + 2] + (pts[o + 2] - pre[o + 2]) * tie, tw = pre[o + 3] + (pts[o + 3] - pre[o + 3]) * tie;
    if (f > 0) {  // hanging in the right-hand margin, fluttering
      x += (xc + gut * 0.18 * Math.sin(s * 6.5 + ti * 1.3 + sy * 0.003) - x) * f;
      y += (vis * 0.14 + s * vis * 0.66 + 8 * Math.sin(s * 4 - ti) - y) * f;
      z += (22 * Math.sin(s * 5 + ti * 0.9) - z) * f;
      tw += (2.4 * Math.sin(s * 5.5 - ti * 1.7 + sy * 0.005) - tw) * f;
    }
    // cloth: a wave travels along it (scrolling pushes it), it lifts and twists with speed, and settles when you stop
    y += (1 + 6 * e) * Math.sin(s * 9 - ti * 1.4 + sy * 0.01) - intro * intro * 26 * Math.sin(s * 3.1);
    z += (3 + 30 * e) * Math.sin(s * 6 + ti * 1.1) + intro * intro * 70;
    tw += 0.7 * e * Math.sin(s * 8 - ti * 2);
    cur[o] = x; cur[o + 1] = y; cur[o + 2] = z; cur[o + 3] = tw;
  }
  // nothing on screen: skip the draw
  let minY = 1e9, maxY = -1e9, minX = 1e9;
  for (let i = 0; i <= N; i += 3) { minY = Math.min(minY, cur[i * 4 + 1]); maxY = Math.max(maxY, cur[i * 4 + 1]); minX = Math.min(minX, cur[i * 4]); }
  if (maxY < -40 || minY > ch + 40 || minX > cw + 30) return;
  const hw = S.hw * (1 - f) + flyHw * f, tilt = S.tilt * (1 - f), lift = 1 + f * 2.2 + intro * 2, navy = S.navy ? 1 - f : 0;
  mesh(hw, tilt, 4 * lift, 8 * lift, 2 + f * 5 + intro * 6);
  // colour: on the way to a new belt, four stripes are taped on, then the new colour runs along it from the tip
  const ra = RANK.indexOf(SA.belt), rb = RANK.indexOf(SB.belt);
  let stripes = 0, grow = 1, wipe = 0;
  if (rb > ra) {
    const n4 = clamp((t - 0.22) / 0.34, 0, 1) * 4;
    stripes = Math.ceil(n4); grow = n4 - stripes + 1; wipe = ss(0.58, 0.72, t) * 1.02;
  }
  const sc = cw < 760 ? 0.8 : 1.1, bar0 = 12 * sc, bar1 = bar0 + 58 * sc;
  const u = use(P.belt);
  gl.bindBuffer(gl.ARRAY_BUFFER, B.belt);
  gl.bufferData(gl.ARRAY_BUFFER, bv, gl.DYNAMIC_DRAW);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 36, 0);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 36, 12);
  gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 36, 24);
  gl.uniform3f(u.uV, cw, ch, 1600);
  gl.uniform3fv(u.uA, COL[SA.belt]);
  gl.uniform3fv(u.uB, COL[SB.belt]);
  gl.uniform3fv(u.uBarA, SA.belt === "black" ? BAR_RED : BAR_BLACK);
  gl.uniform3fv(u.uBarB, SB.belt === "black" ? BAR_RED : BAR_BLACK);
  gl.uniform4f(u.uBar, bar0, bar1, stripes, grow);
  gl.uniform1f(u.uDark, Math.max(dark, navy));
  const shadowA = (dark ? 0.45 : 0.2) * (1 - navy) + 0.4 * navy;
  gl.uniform4f(u.uM, wipe, 1, shadowA / (1 + f * 0.8), hw * dpr);
  gl.drawArrays(gl.TRIANGLE_STRIP, (N + 1) * 2, (N + 1) * 2);
  gl.uniform4f(u.uM, wipe, 0, 0, hw * dpr);
  gl.enable(gl.DEPTH_TEST);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, (N + 1) * 2);
  gl.disable(gl.DEPTH_TEST);
}

// Two vertices per point (position, normal, along/across/length), then the same for its shadow on the page.
function mesh(hw, tilt, sdx, sdy, blur) {
  const nz = Math.sqrt(1 - tilt * tilt), sh = (N + 1) * 18;
  let len = 0;
  for (let i = 0; i <= N; i++) {
    const o = i * 4, p = Math.max(i - 1, 0) * 4, q = Math.min(i + 1, N) * 4;
    let tx = cur[q] - cur[p], ty = cur[q + 1] - cur[p + 1], tz = cur[q + 2] - cur[p + 2];
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    if (i) len += Math.hypot(cur[o] - cur[o - 4], cur[o + 1] - cur[o - 3], cur[o + 2] - cur[o - 2]);
    // across the belt: flat to the page (or the mat, tilted away), then twisted about its length
    let wx = ty * nz + tz * tilt, wy = -tx * nz, wz = -tx * tilt;
    const wl = Math.hypot(wx, wy, wz) || 1;
    wx /= wl; wy /= wl; wz /= wl;
    const bx = ty * wz - tz * wy, by = tz * wx - tx * wz, bz = tx * wy - ty * wx;
    const c = Math.cos(cur[o + 3]), s = Math.sin(cur[o + 3]);
    const Wx = wx * c + bx * s, Wy = wy * c + by * s, Wz = wz * c + bz * s;
    const Nx = Wy * tz - Wz * ty, Ny = Wz * tx - Wx * tz, Nz = Wx * ty - Wy * tx;
    const tp = Math.hypot(tx, ty) || 1, px = -ty / tp, py = tx / tp, lift = 1 + Math.max(0, cur[o + 2]) * 0.015;
    const r = Math.max(Math.abs(Wx * px + Wy * py) * hw, hw * 0.3) + blur;
    for (let side = -1; side <= 1; side += 2) {
      let j = (i * 2 + (side > 0 ? 1 : 0)) * 9;
      bv[j] = cur[o] + Wx * hw * side; bv[j + 1] = cur[o + 1] + Wy * hw * side; bv[j + 2] = cur[o + 2] + Wz * hw * side;
      bv[j + 3] = Nx; bv[j + 4] = Ny; bv[j + 5] = Nz; bv[j + 6] = i / N; bv[j + 7] = side; bv[j + 8] = len;
      j += sh;
      bv[j] = cur[o] + sdx * lift + px * r * side; bv[j + 1] = cur[o + 1] + sdy * lift + py * r * side; bv[j + 2] = 0;
      bv[j + 3] = 0; bv[j + 4] = 0; bv[j + 5] = 1; bv[j + 6] = i / N; bv[j + 7] = side; bv[j + 8] = len;
    }
  }
}

// The flow on the map: card to card along gentle curves, revealed as the chain rises up the screen; rings mark the
// positions reached, the last one red (the tap); particles run along it.
function flow(sx, sy, vis) {
  const c = L.chain.map((p) => [p.x - sx, p.y - sy, p.r]);
  let top = 1e9, bot = -1e9;
  c.forEach((p) => { top = Math.min(top, p[1]); bot = Math.max(bot, p[1]); });
  if (bot < -100 || top > ch + 100) return;
  const reveal = ss(0, 1, (vis * 0.95 - (top + bot) / 2) / (vis * 0.5));
  if (reveal <= 0) return;
  const pts = [], at = [0];
  let total = 0;
  for (let i = 0; i < c.length - 1; i++) {
    const [x0, y0] = c[i], [x1, y1] = c[i + 1], dx = x1 - x0, dy = y1 - y0, d = Math.hypot(dx, dy) || 1;
    const bow = 0.16 * d * (i % 2 ? 1 : -1), nx = (-dy / d) * bow, ny = (dx / d) * bow;
    for (let j = i ? 1 : 0; j <= 24; j++) {
      const t = j / 24, u = 1 - t;
      const x = u * u * u * x0 + 3 * u * u * t * (x0 + dx / 3 + nx) + 3 * u * t * t * (x0 + (2 * dx) / 3 + nx) + t * t * t * x1;
      const y = u * u * u * y0 + 3 * u * u * t * (y0 + dy / 3 + ny) + 3 * u * t * t * (y0 + (2 * dy) / 3 + ny) + t * t * t * y1;
      if (pts.length) total += Math.hypot(x - pts[pts.length - 1][0], y - pts[pts.length - 1][1]);
      pts.push([x, y, total]);
    }
    at.push(total);
  }
  const end = total * reveal;
  let v = 0;
  const put = (x, y, ux, uy, kind, a) => { if (v < 4090) { gv.set([x, y, ux, uy, kind, a], v * 6); v++; } };
  // the line, as a strip, up to the head
  const hwL = 9;
  for (let i = 0; i < pts.length; i++) {
    const [x, y, l] = pts[i], q = pts[Math.min(i + 1, pts.length - 1)], p = pts[Math.max(i - 1, 0)];
    let tx = q[0] - p[0], ty = q[1] - p[1];
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl; ty /= tl;
    let X = x, Y = y;
    if (l > end) { const pr = pts[i - 1], f = (end - pr[2]) / Math.max(1e-3, l - pr[2]); X = pr[0] + (x - pr[0]) * f; Y = pr[1] + (y - pr[1]) * f; }
    const fade = 0.55 + 0.45 * ss(end - 260, end, Math.min(l, end));
    put(X - ty * hwL, Y + tx * hwL, 0, -1, 0, fade);
    put(X + ty * hwL, Y - tx * hwL, 0, 1, 0, fade);
    if (l > end) break;
  }
  const nLine = v;
  const quad = (x, y, r, kind, a) => {
    put(x - r, y - r, -1, -1, kind, a); put(x + r, y - r, 1, -1, kind, a); put(x - r, y + r, -1, 1, kind, a);
    put(x - r, y + r, -1, 1, kind, a); put(x + r, y - r, 1, -1, kind, a); put(x + r, y + r, 1, 1, kind, a);
  };
  for (let i = 0; i < c.length - 1; i++) if (at[i] <= end) quad(c[i][0], c[i][1], c[i][2], 1, ss(at[i], at[i] + 60, end + 1));
  const nRings = v;
  const done = reveal > 0.995;
  if (done) quad(c[c.length - 1][0], c[c.length - 1][1], c[c.length - 1][2] * (1 + 0.06 * Math.sin(time * 5)), 1, 1);
  const nTap = v;
  if (!low && end > 60) {
    for (let j = 0; j < 14; j++) {
      const l = ((time * 0.09 + j / 14) % 1) * end;
      let i = 1;
      while (i < pts.length - 1 && pts[i][2] < l) i++;
      quad(pts[i][0], pts[i][1], 6, 2, 0.8);
    }
  }
  const u = use(P.glow);
  gl.bindBuffer(gl.ARRAY_BUFFER, B.glow);
  gl.bufferData(gl.ARRAY_BUFFER, gv.subarray(0, v * 6), gl.DYNAMIC_DRAW);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 24, 0);
  gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 24, 8);
  gl.uniform2f(u.uV, cw, ch);
  gl.uniform4f(u.uC, 0.36, 0.55, 1, 0.95);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, nLine);
  if (nRings > nLine) gl.drawArrays(gl.TRIANGLES, nLine, nRings - nLine);
  gl.uniform4f(u.uC, 0.92, 0.24, 0.2, 1);
  if (nTap > nRings) gl.drawArrays(gl.TRIANGLES, nRings, nTap - nRings);
  gl.uniform4f(u.uC, 0.82, 0.9, 1, 0.9);
  if (v > nTap) gl.drawArrays(gl.TRIANGLES, nTap, v - nTap);
}

function teardown() {
  alive = false;
  cancelAnimationFrame(raf);
  raf = 0;
  W.removeEventListener("scroll", kick);
  W.removeEventListener("resize", relayout);
  D.removeEventListener("visibilitychange", onVis);
  RM.removeEventListener && RM.removeEventListener("change", onCalm);
  if (io) io.disconnect();
  if (ro) ro.disconnect();
  io = ro = null;
  if (gl && !gl.isContextLost()) {
    Object.values(B).forEach((b) => gl.deleteBuffer(b));
    Object.values(P).forEach((p) => gl.deleteProgram(p.p));
    if (ext) ext.loseContext();
  }
  P = {}; B = {}; gl = null; ext = null; L = null;
  if (cv) cv.remove();
  cv = null;
  H.classList.remove("gl");
  shown = false; lastT = 0; intro = 1; probe = []; probed = false;
}

W.addEventListener("pagehide", teardown);
W.addEventListener("pageshow", (e) => { if (e.persisted) boot(); });
boot();
