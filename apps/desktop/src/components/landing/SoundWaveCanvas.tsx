import { useEffect, useRef, useCallback } from 'react';

/* ─── Shaders ──────────────────────────────────────────────────────────────── */

const VERT = `
attribute vec2 a_pos;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG = `
precision highp float;

uniform float u_time;
uniform vec2 u_res;

/* ── noise ── */

float hash(float n) {
  return fract(sin(n) * 43758.5453123);
}

float noise(float x) {
  float i = floor(x);
  float f = fract(x);
  return mix(hash(i), hash(i + 1.0), f * f * (3.0 - 2.0 * f));
}

/* ── main ── */

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p  = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;
  float t = u_time;

  vec3 bg = vec3(0.102, 0.102, 0.180);
  vec3 waves = vec3(0.0);

  vec3 c1 = vec3(0.357, 0.357, 0.969); // #5b5bf7 indigo
  vec3 c2 = vec3(0.655, 0.545, 0.980); // #A78BFA violet
  vec3 c3 = vec3(0.231, 0.510, 0.965); // #3B82F6 blue

  // 6 big flowing wave lines spread across the screen
  for (int i = 0; i < 6; i++) {
    float fi  = float(i);
    float idx = fi / 5.0;

    // Each wave at a different vertical position
    float yOff = (fi - 2.5) * 0.065;

    // Smooth flowing curves — low frequency, gentle motion
    float freq  = 2.5 + fi * 0.5;
    float speed = 0.3 + fi * 0.08;
    float phase = fi * 1.2;

    float wave = sin(p.x * freq + t * speed + phase) * 0.08
               + sin(p.x * freq * 1.7 - t * speed * 0.6 + phase * 2.0) * 0.04
               + noise(p.x * 2.0 + t * 0.1 + fi) * 0.03;

    float d = abs(p.y - yOff - wave);

    // Wide aurora-like glow
    float glow = exp(-d * 40.0) * 0.6
               + exp(-d * 120.0) * 0.4
               + smoothstep(0.003, 0.0, d) * 0.5;

    // Color gradient through palette
    vec3 col = mix(c1, c2, smoothstep(0.0, 0.5, idx));
    col = mix(col, c3, smoothstep(0.5, 1.0, idx));

    waves += glow * col * 0.5;
  }

  // Edge fade
  float fade = smoothstep(0.0, 0.1, uv.x) * smoothstep(1.0, 0.9, uv.x)
             * smoothstep(0.0, 0.05, uv.y) * smoothstep(1.0, 0.95, uv.y);

  // Tone-map only waves (keeps background color exact)
  waves = 1.0 - exp(-waves * 2.0);

  gl_FragColor = vec4(bg + waves * fade, 1.0);
}`;

/* ─── WebGL helpers ────────────────────────────────────────────────────────── */

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const s = gl.createShader(type);
  if (!s) return null;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    gl.deleteShader(s);
    return null;
  }
  return s;
}

/* ─── Component ────────────────────────────────────────────────────────────── */

export function SoundWaveCanvas({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);

  const setup = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return null;

    const gl = canvas.getContext('webgl', { alpha: false, antialias: false });
    if (!gl) return null;

    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return null;

    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    gl.useProgram(prog);

    // Fullscreen quad (two triangles)
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const aPos = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    return {
      gl,
      uTime: gl.getUniformLocation(prog, 'u_time'),
      uRes: gl.getUniformLocation(prog, 'u_res'),
    };
  }, []);

  useEffect(() => {
    const ctx = setup();
    if (!ctx) return;

    const { gl, uTime, uRes } = ctx;
    const canvas = canvasRef.current!;
    const prefersStill = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio, 2);
      const w = Math.round(canvas.clientWidth * dpr);
      const h = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
      gl.uniform2f(uRes, w, h);
    };

    resize();
    window.addEventListener('resize', resize);

    const t0 = performance.now();
    const render = () => {
      const elapsed = (performance.now() - t0) * 0.001;
      gl.uniform1f(uTime, prefersStill ? 0 : elapsed);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      rafRef.current = requestAnimationFrame(render);
    };
    rafRef.current = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener('resize', resize);
    };
  }, [setup]);

  return <canvas ref={canvasRef} className={className} style={{ pointerEvents: 'none' }} />;
}
