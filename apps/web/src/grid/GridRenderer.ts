import { toolFamily } from '@c-board/protocol';
import {
  AdditiveBlending,
  type Blending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  ColorManagement,
  CylinderGeometry,
  DoubleSide,
  EdgesGeometry,
  Fog,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  LinearSRGBColorSpace,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  PerspectiveCamera,
  PlaneGeometry,
  QuadraticBezierCurve3,
  Quaternion,
  Raycaster,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  TubeGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { type FrameHandle, frameScheduler } from '../anim/scheduler.js';
import { activityKey, levelAt, levelStep, type Pulses, QUIET_LEVEL } from '../data/activity.js';
import type { SceneProject } from '../layouts/scene.js';
import { ease, moment } from '../motion.js';
import { FAMILY_TOKEN } from '../orb/model.js';
import type { Tone } from '../status.js';
import { boardEnergy, MAX_SATELLITES, projectTool } from './map.js';
import {
  approach,
  CHILD_SPIN,
  CORE_SIZE,
  CORE_Y,
  cubicBezier,
  type DivePath,
  declutter,
  diveAt,
  diveFog,
  divePath,
  dragOrbit,
  homeFraming,
  homeOrbit,
  MAX_PACKETS,
  moreAngle,
  NODE_R,
  nodeHeight,
  ORBIT_PERIOD_S,
  ORBIT_R,
  type Orbit,
  orbitPosition,
  PacketField,
  type PipeFlow,
  packetScale,
  packetT,
  pipeControl,
  planSatellites,
  ringPositions,
  ringRadius,
  SATELLITE_SPIN,
  type SatellitePlan,
  TOUCH_MAX_PACKETS,
  type Vec3,
  zoomOrbit,
} from './network.js';

// DESIGN.md §10.4 "Overview (3D)" and "Tech": one imperative renderer for the Grid's network.
// React draws the labels (crisp DOM, projected here every frame) and hands over the scene; this
// class owns the one WebGL context, the camera and every frame. Nothing here re-renders React.

/** Colors come straight from the tokens: no color management between CSS and the canvas. */
ColorManagement.enabled = false;

const FOV = 38;
const DPR_CAP = 1.5;
/** While nothing moves the scene still redraws this often (a resize, a theme or a label change). */
const IDLE_FRAME_MS = 250;
/** How often activity steps are re-read from the store. */
const FLOW_CHECK_MS = 500;
/** Bursts on one pipeline are at least this far apart, as on the 2D map. */
const BURST_GAP_MS = 600;
/** The rose glitch: two frames, ±0.35 units, once (DESIGN.md §3 rule 6). */
const GLITCH_MS = 120;
const GLITCH_SHIFT = 0.35;
const RESET_MS = 700;
/** A press that moves less than this is a click, not a drag. */
const CLICK_SLOP = 4;
const LABEL_LIFT = 1.1;
/** The float label's width (CSS `.grid-node[data-variant="float"]`), px. */
const LABEL_W = 200;
/** The compact label (name only) a crowded ring falls back to; matches `.grid-float[data-compact]`. */
const LABEL_COMPACT = { width: 112, height: 36 };
/** A lifted label eases to its new height over about this long, ms. */
const LIFT_TAU = 140;
const DIVE_MS = moment.dive * 1000;
const diveEase = cubicBezier(...ease.inOut);

/** Where the camera is in a dive: out on the orbit, flying in, in the node, flying back out. */
export type DiveState = 'out' | 'diving' | 'in' | 'rising';

interface Flight {
  id: string;
  path: DivePath;
  /** Linear progress in time, 0 at the orbit and 1 in the node; eased onto the path. */
  progress: number;
  dir: 1 | -1;
  done: (() => void) | null;
}

export interface GridPalette {
  dark: boolean;
  /** Resolves a color token (`--st-wait`) to a color. */
  token(name: string): Color;
}

/** Reads the color tokens off the document through a 1 px canvas, so any CSS color works. */
export function readPalette(
  theme: 'dark' | 'light',
  root: HTMLElement = document.documentElement,
): GridPalette {
  const probe = document.createElement('canvas');
  probe.width = 1;
  probe.height = 1;
  const ctx = probe.getContext('2d', { willReadFrequently: true });
  const style = getComputedStyle(root);
  const cache = new Map<string, Color>();
  return {
    dark: theme === 'dark',
    token(name) {
      const hit = cache.get(name);
      if (hit) return hit;
      const color = new Color(0x4cc8ff);
      const value = style.getPropertyValue(name).trim();
      if (ctx && value) {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = '#000';
        ctx.fillStyle = value;
        ctx.fillRect(0, 0, 1, 1);
        const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data;
        color.setRGB(r / 255, g / 255, b / 255);
      }
      cache.set(name, color);
      return color;
    },
  };
}

const TONE_TOKEN: Record<Tone, string> = {
  work: '--st-work',
  tool: '--st-tool',
  wait: '--st-wait',
  ok: '--st-ok',
  err: '--st-err',
  idle: '--st-idle',
};

/** The token a pipeline's tone lights it with: the neon, or amber and rose for attention. */
const pipeToken = (tone: Tone) =>
  tone === 'wait' ? '--st-wait' : tone === 'err' ? '--st-err' : '--grid-neon';

/** A packet's color key: the neon for the flow, the status colors for the cues. */
const PACKET_TOKEN: Record<string, string> = {
  neon: '--grid-neon',
  wait: '--st-wait',
  ok: '--st-ok',
};

/** A soft round glow, drawn once: the core's halo and the light pools under the nodes. */
function glowTexture(): CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.35, 'rgba(255,255,255,0.35)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = LinearSRGBColorSpace;
  return texture;
}

const FLOOR_VERTEX = `
varying vec3 vWorld;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

// Grid lines from the world position (anti-aliased with fwidth), fading into the horizon fog.
const FLOOR_FRAGMENT = `
uniform vec3 uColor;
uniform float uAlpha;
uniform float uCell;
uniform float uNear;
uniform float uFar;
uniform float uWidth;
varying vec3 vWorld;
void main() {
  vec2 c = vWorld.xz / uCell;
  vec2 g = abs(fract(c - 0.5) - 0.5) / fwidth(c);
  float line = 1.0 - min(min(g.x, g.y), 1.0);
  float fade = 1.0 - smoothstep(uNear, uFar, length(vWorld.xz));
  // The canvas ends inside the page: the floor fades out toward its sides instead of stopping.
  float x = gl_FragCoord.x / uWidth;
  fade *= smoothstep(0.0, 0.08, x) * smoothstep(0.0, 0.08, 1.0 - x);
  gl_FragColor = vec4(uColor, line * uAlpha * fade);
}
`;

const BEAM_VERTEX = `
varying float vY;
void main() {
  vY = uv.y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const BEAM_FRAGMENT = `
uniform vec3 uColor;
uniform float uAlpha;
varying float vY;
void main() {
  gl_FragColor = vec4(uColor, uAlpha * pow(1.0 - vY, 1.6));
}
`;

export interface GridRendererOptions {
  /** The element the canvas fills. Pointer gestures on it turn and zoom the camera. */
  stage: HTMLElement;
  /** React's label layer: `[data-grid-label=<id>]` wrappers, with satellites inside. */
  labels: HTMLElement;
  getPulses(): Pulses;
  subscribe(listener: () => void): () => void;
  /** Coarse pointer: half the packets (§10.1). */
  touch?: boolean;
  onEnter(projectId: string): void;
  /** The WebGL context is gone: the layout shows the 2D map instead. */
  onLost(): void;
}

interface NodeEntry {
  id: string;
  project: SceneProject;
  group: Group;
  body: Mesh<CylinderGeometry, MeshBasicMaterial>;
  edges: LineSegments<EdgesGeometry, LineBasicMaterial>;
  cap: Mesh<CylinderGeometry, MeshBasicMaterial>;
  pool: Mesh<PlaneGeometry, MeshBasicMaterial>;
  beam: Mesh<CylinderGeometry, ShaderMaterial>;
  beamUniforms: { uColor: { value: Color }; uAlpha: { value: number } };
  pipe: Mesh<TubeGeometry, MeshBasicMaterial>;
  pipeGlow: Mesh<TubeGeometry, MeshBasicMaterial>;
  curve: QuadraticBezierCurve3;
  position: Vec3;
  height: number;
  activity: number;
  tone: Tone;
  step: 0 | 1 | 2 | 3;
  events: number;
  doneAt: number | null;
  burstAt: number;
  glitchUntil: number;
  satellites: SatellitePlan[];
  /** Each satellite's own spin offset, so it carries on where it was when the scene updates. */
  spin: Map<string, number>;
  more: number | null;
  label: LabelEntry | null;
}

interface LabelEntry {
  el: HTMLElement;
  slots: Map<string, HTMLElement>;
  more: HTMLElement | null;
  /** The card's height, px, measured once per scene update. */
  height: number;
  x: number;
  y: number;
  z: number;
  opacity: number;
  /** How far it's lifted above its node to stay clear of nearer labels, px. */
  lift: number;
  stem: number;
  /** Its form on screen: full, compact (name only) or crowded out (hidden until hovered). */
  fit: 'full' | 'compact' | 'crowded';
}

const BODY_GEOMETRY = new CylinderGeometry(NODE_R, NODE_R, 1, 6).translate(0, 0.5, 0);
const EDGE_GEOMETRY = new EdgesGeometry(BODY_GEOMETRY);
const CAP_GEOMETRY = new CylinderGeometry(NODE_R * 0.62, NODE_R * 0.62, 0.04, 6);
const POOL_GEOMETRY = new PlaneGeometry(NODE_R * 7, NODE_R * 7).rotateX(-Math.PI / 2);
const BEAM_GEOMETRY = new CylinderGeometry(0.5, 0.7, 14, 16, 1, true).translate(0, 7, 0);
const SPHERE_GEOMETRY = new SphereGeometry(0.5, 16, 12);
const BOX_GEOMETRY = new BoxGeometry(0.85, 0.85, 0.85);
const PACKET_GEOMETRY = new SphereGeometry(0.26, 10, 8);

const scratch = {
  v: new Vector3(),
  m: new Matrix4(),
  q: new Quaternion(),
  s: new Vector3(),
  c: new Color(),
};

/**
 * The Grid's 3D network on a WebGL canvas: the floor fading into fog, the core, a hexagonal
 * monolith per project on a ring with its status edge light and activity height, satellites per
 * actor on sub-pipes, curved pipelines carrying instanced packets, amber beacons and the rose
 * glitch. The camera drifts round the ring until the pointer comes over the scene; drag turns
 * it, the wheel or a pinch zooms (clamped), a double-click resets it.
 */
export class GridRenderer {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(FOV, 1, 0.5, 600);
  private readonly target = new Vector3(0, 1.4, 0);
  private readonly nodes = new Map<string, NodeEntry>();
  private order: string[] = [];
  private palette: GridPalette;
  private readonly field: PacketField;
  private readonly glow = glowTexture();

  private readonly floor: Mesh<PlaneGeometry, ShaderMaterial>;
  private readonly floorUniforms = {
    uColor: { value: new Color() },
    uAlpha: { value: 0.3 },
    uCell: { value: 4 },
    uNear: { value: 30 },
    uFar: { value: 150 },
    uWidth: { value: 1 },
  };
  private readonly core: Group;
  private readonly coreBody: Mesh<IcosahedronGeometry, MeshBasicMaterial>;
  private readonly coreEdges: LineSegments<EdgesGeometry, LineBasicMaterial>;
  private readonly coreLight: Mesh<IcosahedronGeometry, MeshBasicMaterial>;
  private readonly coreHalo: Sprite;
  private energy = 0;
  private energyTarget = 0;

  private spheres: InstancedMesh<SphereGeometry, MeshBasicMaterial>;
  private boxes: InstancedMesh<BoxGeometry, MeshBasicMaterial>;
  private subPipes: LineSegments<BufferGeometry, LineBasicMaterial>;
  private capacity = 0;
  private readonly packets: InstancedMesh<SphereGeometry, MeshBasicMaterial>;

  private orbit: Orbit = homeOrbit(60);
  private home = 60;
  private reset: { from: Orbit; to: Orbit; start: number } | null = null;
  private flight: Flight | null = null;
  private shift = 0;
  private homeFog = { near: 60, far: 200 };
  private homeFloor = { near: 0, far: 0 };
  private hovering = false;
  private hotId: string | null = null;
  private hoverId: string | null = null;
  /** Some satellite's actor works, so it drifts round its node. */
  private spinning = false;
  /** Time since the last drawn frame, ms: idle frames are skipped, satellites keep their pace. */
  private pending = 0;
  private drag: { id: number; x: number; y: number; moved: boolean } | null = null;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinch: number | null = null;
  private readonly raycaster = new Raycaster();
  private pointerAt: Vector2 | null = null;

  private width = 1;
  private height = 1;
  private frame: FrameHandle | null = null;
  private lastRender = 0;
  private lastFlowCheck = 0;
  private dirty = true;
  private time = 0;
  private readonly cleanups: (() => void)[] = [];
  private disposed = false;

  /** A renderer on `options.stage`, or null when WebGL is unavailable (the 2D map shows). */
  static create(options: GridRendererOptions, palette: GridPalette): GridRenderer | null {
    try {
      return new GridRenderer(options, palette);
    } catch (error) {
      console.warn('[c-board] the Grid falls back to the 2D map:', (error as Error).message);
      return null;
    }
  }

  private constructor(
    private readonly options: GridRendererOptions,
    palette: GridPalette,
  ) {
    this.palette = palette;
    this.renderer = new WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = LinearSRGBColorSpace;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, DPR_CAP));
    const canvas = this.renderer.domElement;
    canvas.dataset.gridCanvas = '';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.className = 'absolute inset-0 block size-full touch-none';
    options.stage.prepend(canvas);
    this.field = new PacketField(options.touch ? TOUCH_MAX_PACKETS : MAX_PACKETS, 'neon');

    this.scene.fog = new Fog(0x000000, 60, 200);

    this.floor = new Mesh(
      new PlaneGeometry(600, 600).rotateX(-Math.PI / 2),
      new ShaderMaterial({
        vertexShader: FLOOR_VERTEX,
        fragmentShader: FLOOR_FRAGMENT,
        transparent: true,
        depthWrite: false,
        uniforms: this.floorUniforms,
      }),
    );
    this.floor.renderOrder = -1;
    this.scene.add(this.floor);

    this.core = new Group();
    this.core.position.set(0, CORE_Y, 0);
    const coreGeometry = new IcosahedronGeometry(CORE_SIZE, 0);
    this.coreBody = new Mesh(coreGeometry, new MeshBasicMaterial());
    this.coreEdges = new LineSegments(
      new EdgesGeometry(coreGeometry),
      new LineBasicMaterial({ transparent: true }),
    );
    this.coreLight = new Mesh(
      new IcosahedronGeometry(CORE_SIZE * 0.55, 0),
      new MeshBasicMaterial({ transparent: true, depthWrite: false }),
    );
    this.coreHalo = new Sprite(
      new SpriteMaterial({ map: this.glow, transparent: true, depthWrite: false, fog: false }),
    );
    this.coreHalo.scale.setScalar(CORE_SIZE * 7);
    this.core.add(this.coreHalo, this.coreBody, this.coreEdges, this.coreLight);
    this.scene.add(this.core);

    this.spheres = new InstancedMesh(SPHERE_GEOMETRY, new MeshBasicMaterial(), 1);
    this.boxes = new InstancedMesh(BOX_GEOMETRY, new MeshBasicMaterial(), 1);
    this.subPipes = new LineSegments(
      new BufferGeometry(),
      new LineBasicMaterial({ transparent: true, depthWrite: false }),
    );
    this.grow(64);

    this.packets = new InstancedMesh(
      PACKET_GEOMETRY,
      new MeshBasicMaterial({ transparent: true, depthWrite: false, fog: false }),
      MAX_PACKETS,
    );
    this.packets.count = 0;
    this.packets.frustumCulled = false;
    this.packets.setColorAt(0, new Color());
    this.scene.add(this.packets);

    this.applyPalette();
    this.listen(canvas);
    this.cleanups.push(options.subscribe(() => this.onStore()));

    const observer = new ResizeObserver(() => this.measure());
    observer.observe(options.stage);
    this.cleanups.push(() => observer.disconnect());
    this.measure();

    this.frame = frameScheduler().add((now, dt) => this.tick(now, dt));

    // For tests and debugging: the camera's orbit, read without touching the DOM.
    Object.defineProperty(options.stage, 'gridCamera', {
      configurable: true,
      value: () => ({ ...this.orbit, home: this.home, dive: this.diveState() }),
    });
    this.cleanups.push(() => Reflect.deleteProperty(options.stage, 'gridCamera'));
  }

  /** The projects in attention order, as the scene model gives them. */
  setScene(projects: readonly SceneProject[]): void {
    const ids = projects.map((p) => p.id);
    const reordered = ids.join('\n') !== this.order.join('\n');
    this.order = ids;
    for (const [id, entry] of this.nodes) {
      if (!ids.includes(id)) {
        this.removeNode(entry);
        this.nodes.delete(id);
      }
    }
    const positions = ringPositions(projects.length);
    const pulses = this.options.getPulses();
    projects.forEach((project, i) => {
      let entry = this.nodes.get(project.id);
      const position = positions[i] ?? { x: 0, y: 0, z: 0 };
      if (!entry) {
        entry = this.addNode(project, position, pulses);
        this.nodes.set(project.id, entry);
      } else if (reordered) {
        this.place(entry, position);
      }
      const wasErr = entry.tone === 'err';
      entry.project = project;
      entry.activity = Math.max(project.activity, ...project.actors.map((a) => a.activity));
      if (project.tone !== entry.tone) {
        entry.tone = project.tone;
        if (project.tone === 'err' && !wasErr) entry.glitchUntil = performance.now() + GLITCH_MS;
        this.paintNode(entry);
      }
      entry.satellites = planSatellites(project.actors);
      entry.more = moreAngle(project.actors);
    });
    if (reordered) {
      this.frameRing();
      // A node that moved while the camera is in it (or on its way): the flight follows it.
      const flight = this.flight;
      const target = flight && this.nodes.get(flight.id);
      if (flight && target) flight.path = this.pathTo(target);
    }
    this.energyTarget = boardEnergy(projects);
    this.spinning = projects.some((p) =>
      p.actors.slice(0, MAX_SATELLITES).some((a) => a.activity >= QUIET_LEVEL),
    );
    this.syncSatellites();
    this.bindLabels();
    this.syncFlows(performance.now());
    this.dirty = true;
  }

  setPalette(palette: GridPalette): void {
    this.palette = palette;
    this.applyPalette();
    this.dirty = true;
  }

  /** A label is hovered or focused: its pipeline and edges brighten. */
  setHot(projectId: string | null): void {
    if (projectId === this.hotId) return;
    const previous = this.hotId ? this.nodes.get(this.hotId) : undefined;
    this.hotId = projectId;
    if (previous) this.paintNode(previous);
    const next = projectId ? this.nodes.get(projectId) : undefined;
    if (next) this.paintNode(next);
    this.dirty = true;
  }

  /**
   * The dive (§10.4): the camera flies from its orbit over the core and down the node's pipeline
   * into the node (`moment.dive`, `ease.inOut`) while the fog closes in, so the other nodes fade
   * away. `onDone` runs once it has arrived. False when there's no such node.
   */
  dive(projectId: string, onDone: () => void): boolean {
    const entry = this.nodes.get(projectId);
    if (!entry) return false;
    this.reset = null;
    this.drag = null;
    this.pointers.clear();
    this.pinch = null;
    this.hover(null);
    const progress = this.flight?.id === projectId ? this.flight.progress : 0;
    this.flight = { id: projectId, path: this.pathTo(entry), progress, dir: 1, done: onDone };
    this.markDive();
    this.dirty = true;
    return true;
  }

  /** The reverse dive, from wherever the camera is on the way back to its orbit. */
  rise(onDone: () => void): void {
    const flight = this.flight;
    if (!flight) {
      onDone();
      return;
    }
    flight.dir = -1;
    flight.done = onDone;
    this.markDive();
    this.dirty = true;
  }

  diveState(): DiveState {
    const flight = this.flight;
    if (!flight) return 'out';
    if (flight.dir === -1) return 'rising';
    return flight.progress >= 1 ? 'in' : 'diving';
  }

  /** Offstage (the focus view covers the overview): no frames at all. */
  setPaused(paused: boolean): void {
    this.frame?.setActive(!paused && !this.disposed);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.frame?.remove();
    for (const cleanup of this.cleanups) cleanup();
    for (const entry of this.nodes.values()) this.removeNode(entry);
    this.nodes.clear();
    this.scene.traverse((object) => {
      const mesh = object as Partial<Mesh>;
      if (mesh.geometry && !isShared(mesh.geometry)) mesh.geometry.dispose();
      const material = mesh.material;
      if (Array.isArray(material)) for (const m of material) m.dispose();
      else material?.dispose();
    });
    this.glow.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }

  // --- Nodes ----------------------------------------------------------------------------------

  private addNode(project: SceneProject, position: Vec3, pulses: Pulses): NodeEntry {
    const group = new Group();
    const body = new Mesh(BODY_GEOMETRY, new MeshBasicMaterial());
    body.userData.projectId = project.id;
    const edges = new LineSegments(EDGE_GEOMETRY, new LineBasicMaterial({ transparent: true }));
    const cap = new Mesh(
      CAP_GEOMETRY,
      new MeshBasicMaterial({ transparent: true, depthWrite: false }),
    );
    const pool = new Mesh(
      POOL_GEOMETRY,
      new MeshBasicMaterial({ map: this.glow, transparent: true, depthWrite: false, fog: false }),
    );
    pool.position.y = 0.02;
    const beamUniforms = { uColor: { value: new Color() }, uAlpha: { value: 0.3 } };
    const beam = new Mesh(
      BEAM_GEOMETRY,
      new ShaderMaterial({
        vertexShader: BEAM_VERTEX,
        fragmentShader: BEAM_FRAGMENT,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        uniforms: beamUniforms,
      }),
    );
    group.add(pool, body, edges, cap, beam);
    this.scene.add(group);

    const pipeMaterial = new MeshBasicMaterial({ transparent: true, depthWrite: false });
    const glowMaterial = new MeshBasicMaterial({ transparent: true, depthWrite: false });
    const curve = new QuadraticBezierCurve3();
    const pipe = new Mesh(new BufferGeometry() as TubeGeometry, pipeMaterial);
    const pipeGlow = new Mesh(new BufferGeometry() as TubeGeometry, glowMaterial);
    this.scene.add(pipeGlow, pipe);

    const pulse = pulses[activityKey.project(project.id)];
    const entry: NodeEntry = {
      id: project.id,
      project,
      group,
      body,
      edges,
      cap,
      pool,
      beam,
      beamUniforms,
      pipe,
      pipeGlow,
      curve,
      position,
      height: nodeHeight(project.activity),
      activity: project.activity,
      tone: project.tone,
      step: 0,
      events: pulse?.events ?? 0,
      doneAt: pulse?.doneAt ?? null,
      burstAt: 0,
      glitchUntil: 0,
      satellites: [],
      spin: new Map(),
      more: null,
      label: null,
    };
    this.place(entry, position);
    this.paintNode(entry);
    return entry;
  }

  /** Puts a node on its ring position and lays its pipeline from the core to it. */
  private place(entry: NodeEntry, position: Vec3): void {
    entry.position = position;
    entry.group.position.set(position.x, 0, position.z);
    const { from, mid, to } = pipeControl(position);
    entry.curve.v0.set(from.x, from.y, from.z);
    entry.curve.v1.set(mid.x, mid.y, mid.z);
    entry.curve.v2.set(to.x, to.y, to.z);
    // The curve caches its arc lengths (`getPointAt`): the moved one measures itself afresh.
    entry.curve.updateArcLengths();
    entry.pipe.geometry.dispose();
    entry.pipeGlow.geometry.dispose();
    entry.pipe.geometry = new TubeGeometry(entry.curve, 48, 0.09, 6);
    entry.pipeGlow.geometry = new TubeGeometry(entry.curve, 48, 0.32, 8);
  }

  private removeNode(entry: NodeEntry): void {
    this.scene.remove(entry.group, entry.pipe, entry.pipeGlow);
    for (const mesh of [entry.body, entry.edges, entry.cap, entry.pool, entry.beam]) {
      mesh.material.dispose();
    }
    entry.pipe.geometry.dispose();
    entry.pipeGlow.geometry.dispose();
    entry.pipe.material.dispose();
    entry.pipeGlow.material.dispose();
  }

  /** Colors a node and its pipeline for its tone, the hover and the theme. */
  private paintNode(entry: NodeEntry): void {
    const { token, dark } = this.palette;
    const hot = entry.id === this.hotId;
    const edge = entry.tone === 'idle' ? token('--grid-neon') : token(TONE_TOKEN[entry.tone]);
    const bg = token('--grid-bg');
    entry.body.material.color.copy(bg).lerp(token('--grid-neon'), dark ? 0.05 : 0.08);
    entry.edges.material.color.copy(edge);
    entry.edges.material.opacity = hot ? 1 : entry.tone === 'idle' ? 0.55 : 0.9;
    entry.cap.material.color.copy(edge);
    entry.pool.material.color.copy(edge);
    const blending: Blending = dark ? AdditiveBlending : NormalBlending;
    entry.pool.material.blending = blending;
    entry.beamUniforms.uColor.value.copy(token('--st-wait'));
    entry.beam.material.blending = blending;
    entry.beam.visible = entry.tone === 'wait';
    const pipe = token(pipeToken(entry.tone));
    entry.pipe.material.color.copy(pipe);
    entry.pipeGlow.material.color.copy(pipe);
    entry.pipeGlow.material.blending = blending;
    for (const material of [entry.pool.material, entry.beam.material, entry.pipeGlow.material]) {
      material.needsUpdate = true;
    }
    this.lightPipe(entry);
  }

  /** Pipeline brightness: dim at rest, lit while the project works, bright when hot. */
  private lightPipe(entry: NodeEntry): void {
    const hot = entry.id === this.hotId;
    const attention = entry.tone === 'wait' || entry.tone === 'err';
    const lit = entry.step > 0;
    entry.pipe.material.opacity = hot ? 0.95 : attention ? 0.8 : lit ? 0.7 : 0.3;
    entry.pipeGlow.material.opacity = hot ? 0.2 : attention ? 0.14 : lit ? 0.1 : 0;
    entry.pipeGlow.visible = entry.pipeGlow.material.opacity > 0;
  }

  private applyPalette(): void {
    const { token, dark } = this.palette;
    const bg = token('--grid-bg');
    const neon = token('--grid-neon');
    (this.scene.fog as Fog).color.copy(bg);
    this.floorUniforms.uColor.value.copy(neon);
    this.floorUniforms.uAlpha.value = dark ? 0.32 : 0.4;
    this.coreBody.material.color.copy(bg).lerp(neon, 0.08);
    this.coreEdges.material.color.copy(neon);
    this.coreLight.material.color.copy(neon);
    const blending: Blending = dark ? AdditiveBlending : NormalBlending;
    this.coreHalo.material.color.copy(neon);
    this.coreHalo.material.blending = blending;
    this.coreHalo.material.needsUpdate = true;
    this.subPipes.material.color.copy(neon);
    this.subPipes.material.opacity = dark ? 0.35 : 0.5;
    this.packets.material.blending = blending;
    this.packets.material.needsUpdate = true;
    for (const entry of this.nodes.values()) this.paintNode(entry);
  }

  // --- Satellites -------------------------------------------------------------------------------

  /** Makes room for `count` satellites in the instanced meshes and the sub-pipe buffer. */
  private grow(count: number): void {
    if (count <= this.capacity) return;
    const capacity = Math.max(count, this.capacity * 2);
    this.scene.remove(this.spheres, this.boxes, this.subPipes);
    this.spheres.dispose();
    this.boxes.dispose();
    this.spheres = new InstancedMesh(SPHERE_GEOMETRY, this.spheres.material, capacity);
    this.boxes = new InstancedMesh(BOX_GEOMETRY, this.boxes.material, capacity);
    for (const mesh of [this.spheres, this.boxes]) {
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.setColorAt(0, new Color());
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(capacity * 6), 3));
    this.subPipes.geometry.dispose();
    this.subPipes.geometry = geometry;
    this.subPipes.frustumCulled = false;
    this.capacity = capacity;
    this.scene.add(this.spheres, this.boxes, this.subPipes);
  }

  private syncSatellites(): void {
    let count = 0;
    for (const entry of this.nodes.values()) count += entry.satellites.length;
    this.grow(count);
  }

  /** Positions every satellite and sub-pipe for this frame, `dt` ms after the last one. */
  private drawSatellites(dt: number): void {
    const { token } = this.palette;
    const positions = this.subPipes.geometry.getAttribute('position') as BufferAttribute;
    let spheres = 0;
    let boxes = 0;
    let segments = 0;
    const where = new Map<string, Vector3>();
    for (const entry of this.nodes.values()) {
      const actors = new Map(entry.project.actors.map((a) => [a.id, a]));
      where.clear();
      const node = entry.group.position;
      for (const plan of entry.satellites) {
        const actor = actors.get(plan.actorId);
        if (!actor) continue;
        const active = actor.activity >= QUIET_LEVEL;
        const speed = plan.parentId ? CHILD_SPIN : SATELLITE_SPIN;
        let spin = entry.spin.get(plan.actorId) ?? 0;
        if (active) spin += (speed * dt) / 1000;
        entry.spin.set(plan.actorId, spin);
        const angle = plan.angle + spin;
        const center = plan.parentId ? where.get(plan.parentId) : undefined;
        const base = center ?? node;
        const radius = center ? plan.radius : ORBIT_R;
        const y = center ? center.y + 0.35 * Math.sin(angle * 2) : plan.height;
        const at = new Vector3(
          base.x + radius * Math.sin(angle),
          y,
          base.z + radius * Math.cos(angle),
        );
        where.set(plan.actorId, at);

        const size = actor.kind === 'claude' ? 0.8 : actor.kind === 'terminal' ? 0.62 : 0.42;
        scratch.s.setScalar(size);
        scratch.q.identity();
        if (actor.kind === 'terminal') scratch.q.setFromAxisAngle(scratch.v.set(0, 1, 0), angle);
        scratch.m.compose(at, scratch.q, scratch.s);
        const color = scratch.c.copy(token(TONE_TOKEN[actor.tone]));
        if (actor.kind === 'terminal') {
          this.boxes.setMatrixAt(boxes, scratch.m);
          this.boxes.setColorAt(boxes, color);
          boxes++;
        } else {
          this.spheres.setMatrixAt(spheres, scratch.m);
          this.spheres.setColorAt(spheres, color);
          spheres++;
        }
        // The sub-pipe: from the node's side (or the parent satellite) to the satellite.
        const from = center ?? scratch.v.set(node.x, Math.min(plan.height, entry.height), node.z);
        const reach = center ? 0 : NODE_R / ORBIT_R;
        positions.setXYZ(
          segments * 2,
          from.x + (at.x - from.x) * reach,
          from.y,
          from.z + (at.z - from.z) * reach,
        );
        positions.setXYZ(segments * 2 + 1, at.x, at.y, at.z);
        segments++;
      }
      this.placeLabelSlots(entry, where);
    }
    this.spheres.count = spheres;
    this.boxes.count = boxes;
    for (const mesh of [this.spheres, this.boxes]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    positions.needsUpdate = true;
    this.subPipes.geometry.setDrawRange(0, segments * 2);
  }

  // --- Labels -------------------------------------------------------------------------------------

  /** Finds each node's label and its satellite slots in React's layer (after every render). */
  private bindLabels(): void {
    for (const entry of this.nodes.values()) {
      const el = this.options.labels.querySelector<HTMLElement>(
        `[data-grid-label="${CSS.escape(entry.id)}"]`,
      );
      if (!el) {
        entry.label = null;
        continue;
      }
      const slots = new Map<string, HTMLElement>();
      for (const slot of el.querySelectorAll<HTMLElement>('[data-grid-slot]')) {
        slots.set(slot.dataset.gridSlot ?? '', slot);
      }
      const keep = entry.label?.el === el ? entry.label : null;
      const card = el.firstElementChild as HTMLElement | null;
      entry.label = {
        el,
        slots,
        more: el.querySelector<HTMLElement>('[data-grid-slot-more]'),
        // A compact card is shorter: keep the full height it was measured at.
        height: (keep?.fit === 'compact' ? keep.height : card?.offsetHeight) || 76,
        x: keep?.x ?? Number.NaN,
        y: keep?.y ?? Number.NaN,
        z: keep?.z ?? -1,
        opacity: keep?.opacity ?? -1,
        lift: keep?.lift ?? 0,
        stem: keep?.stem ?? -1,
        fit: keep?.fit ?? 'full',
      };
    }
  }

  /** Screen position (px in the stage) of a world point. */
  private project(point: Vector3, out: Vector2): Vector2 {
    scratch.v.copy(point).project(this.camera);
    return out.set(((scratch.v.x + 1) / 2) * this.width, ((1 - scratch.v.y) / 2) * this.height);
  }

  /**
   * Moves each label above its monolith, nearest on top, the far side a little faded. A label
   * that would cover a nearer one rises clear of it (easing there, never jumping) on a stem.
   */
  private placeLabels(dt: number): void {
    const camera = this.camera.position;
    const ranked = [...this.nodes.values()]
      .filter((e): e is NodeEntry & { label: LabelEntry } => e.label !== null)
      .map((entry) => ({
        entry,
        depth: Math.hypot(entry.position.x - camera.x, entry.position.z - camera.z),
      }))
      .sort((a, b) => a.depth - b.depth);
    if (ranked.length === 0) return;
    const near = ranked[0]?.depth ?? 0;
    const far = ranked.at(-1)?.depth ?? near;
    const at = new Vector2();
    const boxes = ranked.map(({ entry }) => {
      this.project(
        scratch.v.set(entry.position.x, entry.height + LABEL_LIFT, entry.position.z),
        at,
      );
      return {
        x: at.x,
        y: at.y,
        width: LABEL_W,
        height: entry.label.height,
        compact: LABEL_COMPACT,
      };
    });
    const lifted = declutter(boxes, 8);
    ranked.forEach(({ entry, depth }, i) => {
      const label = entry.label;
      const box = boxes[i];
      if (!box) return;
      const place = lifted[i];
      label.lift = approach(label.lift, box.y - (place?.y ?? box.y), dt, LIFT_TAU);
      const fit = place?.crowded ? 'crowded' : place?.compact ? 'compact' : 'full';
      if (fit !== label.fit) {
        if (fit === 'crowded') label.el.dataset.crowded = '';
        else delete label.el.dataset.crowded;
        if (fit === 'compact') label.el.dataset.compact = '';
        else delete label.el.dataset.compact;
        label.fit = fit;
      }
      const x = Math.round(box.x);
      const y = Math.round(box.y - label.lift);
      if (x !== label.x || y !== label.y) {
        label.el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        label.x = x;
        label.y = y;
      }
      const stem = Math.round(label.lift);
      if (stem !== label.stem) {
        label.el.style.setProperty('--stem', `${stem}px`);
        label.stem = stem;
      }
      const z = ranked.length - i;
      if (z !== label.z) {
        label.el.style.setProperty('--z', String(z));
        label.z = z;
      }
      const opacity =
        far > near ? Math.round((1 - 0.35 * ((depth - near) / (far - near))) * 20) / 20 : 1;
      if (opacity !== label.opacity) {
        label.el.style.setProperty('--grid-depth', String(opacity));
        label.opacity = opacity;
      }
    });
  }

  /** Puts the label's satellite buttons over their satellites, so a click lands on the actor. */
  private placeLabelSlots(entry: NodeEntry, where: ReadonlyMap<string, Vector3>): void {
    const label = entry.label;
    if (!label || Number.isNaN(label.x)) return;
    const at = new Vector2();
    for (const [actorId, slot] of label.slots) {
      const point = where.get(actorId);
      if (!point) continue;
      this.project(point, at);
      slot.style.transform = `translate3d(${Math.round(at.x - label.x)}px, ${Math.round(at.y - label.y)}px, 0)`;
    }
    if (label.more && entry.more !== null) {
      const node = entry.group.position;
      const angle = entry.more + (entry.spin.get('+') ?? 0);
      this.project(
        scratch.v.set(node.x + ORBIT_R * Math.sin(angle), 1.4, node.z + ORBIT_R * Math.cos(angle)),
        at,
      );
      label.more.style.transform = `translate3d(${Math.round(at.x - label.x)}px, ${Math.round(at.y - label.y)}px, 0)`;
    }
  }

  // --- Activity -----------------------------------------------------------------------------------

  /** Store changes: an event fires a burst, a finished turn a green pulse back to the core. */
  private onStore(): void {
    const pulses = this.options.getPulses();
    const now = performance.now();
    for (const entry of this.nodes.values()) {
      const pulse = pulses[activityKey.project(entry.id)];
      const events = pulse?.events ?? 0;
      if (events !== entry.events) {
        entry.events = events;
        if (now - entry.burstAt >= BURST_GAP_MS) {
          entry.burstAt = now;
          const tool = projectTool(entry.project);
          this.field.burst(entry.id, tool ? FAMILY_TOKEN[toolFamily(tool)] : '--grid-neon');
        }
      }
      const doneAt = pulse?.doneAt ?? null;
      if (doneAt !== entry.doneAt) {
        entry.doneAt = doneAt;
        if (doneAt !== null) this.field.done(entry.id, 'ok');
      }
    }
  }

  /** Re-reads each project's activity step, which sets its flow of packets. */
  private syncFlows(now: number): void {
    this.lastFlowCheck = now;
    const pulses = this.options.getPulses();
    const wall = Date.now();
    const flows = new Map<string, PipeFlow>();
    for (const entry of this.nodes.values()) {
      const step = levelStep(levelAt(pulses[activityKey.project(entry.id)], wall));
      if (step !== entry.step) {
        entry.step = step;
        this.lightPipe(entry);
      }
      flows.set(entry.id, { step, waiting: entry.tone === 'wait' });
    }
    this.field.setFlows(flows);
  }

  private drawPackets(): void {
    const { token } = this.palette;
    let count = 0;
    for (const packet of this.field.packets) {
      const entry = this.nodes.get(packet.pipe);
      const scale = packetScale(packet);
      if (!entry || scale <= 0) continue;
      entry.curve.getPointAt(packetT(packet), scratch.v);
      const size = packet.kind === 'flow' ? 1 : packet.kind === 'burst' ? 0.9 : 1.5;
      scratch.s.setScalar(scale * size);
      scratch.q.identity();
      scratch.m.compose(scratch.v, scratch.q, scratch.s);
      this.packets.setMatrixAt(count, scratch.m);
      const name = PACKET_TOKEN[packet.color] ?? packet.color;
      const color = scratch.c.copy(token(name));
      if (packet.kind === 'flow') color.lerp(token('--text-1'), 0.3);
      this.packets.setColorAt(count, color);
      count++;
    }
    this.packets.count = count;
    this.packets.instanceMatrix.needsUpdate = true;
    if (this.packets.instanceColor) this.packets.instanceColor.needsUpdate = true;
  }

  // --- Camera and input ---------------------------------------------------------------------------

  private measure(): void {
    const width = Math.max(1, this.options.stage.clientWidth);
    const height = Math.max(1, this.options.stage.clientHeight);
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.renderer.setSize(width, height, false);
    this.floorUniforms.uWidth.value = width * this.renderer.getPixelRatio();
    this.frameRing();
    this.dirty = true;
  }

  /**
   * The home framing for the ring in this stage: the camera's distance (a zoom keeps its ratio
   * to it) and the projection's vertical shift that centers the ring with its labels.
   */
  private frameRing(): void {
    const framing = homeFraming(this.order.length, this.width, this.height, FOV, this.target);
    this.orbit = { ...this.orbit, distance: (this.orbit.distance / this.home) * framing.distance };
    this.home = framing.distance;
    this.shift = framing.shift;
    this.camera.aspect = this.width / this.height;
    this.project3d(this.flightK());
    this.fitFog();
  }

  /** The projection, with the home framing's shift fading out as the camera dives in. */
  private project3d(k: number): void {
    this.camera.updateProjectionMatrix();
    // Row y, column z: moves every point `shift` up in NDC (w is -z).
    this.camera.projectionMatrix.elements[9] -= this.shift * (1 - k);
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
  }

  /** The eased dive progress: 0 on the orbit, 1 in the node. */
  private flightK(): number {
    return this.flight ? diveEase(this.flight.progress) : 0;
  }

  private pathTo(entry: NodeEntry): DivePath {
    const eye = orbitPosition(this.orbit, this.target);
    return divePath(eye, this.target, entry.position, entry.height);
  }

  /** The stage says where the dive is, so CSS fades the labels out while the camera is away. */
  private markDive(): void {
    const state = this.diveState();
    if (state === 'out') delete this.options.stage.dataset.dive;
    else this.options.stage.dataset.dive = state;
  }

  /** The fog and the floor's fade start past the ring and close in at the horizon. */
  private fitFog(): void {
    this.homeFog = { near: this.home * 1.15, far: this.home * 3.2 };
    const ring = ringRadius(this.order.length);
    this.homeFloor = { near: ring + 12, far: ring * 3 + 70 };
    this.applyFog(this.flightK());
  }

  /** Home fog at 0; at 1 a close wall just past the dived-into node. */
  private applyFog(k: number): void {
    const fog = this.scene.fog as Fog;
    const air = diveFog(k, this.homeFog);
    fog.near = air.near;
    fog.far = air.far;
    const floor = diveFog(k, this.homeFloor);
    this.floorUniforms.uNear.value = floor.near;
    this.floorUniforms.uFar.value = floor.far;
  }

  private listen(canvas: HTMLCanvasElement): void {
    const stage = this.options.stage;
    const on = <K extends keyof HTMLElementEventMap>(
      el: HTMLElement,
      type: K,
      handler: (event: HTMLElementEventMap[K]) => void,
      options?: AddEventListenerOptions,
    ) => {
      el.addEventListener(type, handler, options);
      this.cleanups.push(() => el.removeEventListener(type, handler, options));
    };
    on(stage, 'pointerenter', () => {
      this.hovering = true;
    });
    on(stage, 'pointerleave', () => {
      this.hovering = false;
      this.pointerAt = null;
      this.hover(null);
    });
    on(canvas, 'pointerdown', (event) => {
      if (this.flight) return;
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      canvas.setPointerCapture(event.pointerId);
      this.reset = null;
      if (this.pointers.size === 1) {
        this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
      } else {
        this.drag = null;
        this.pinch = this.spread();
      }
    });
    on(canvas, 'pointermove', (event) => {
      const rect = canvas.getBoundingClientRect();
      this.pointerAt = new Vector2(event.clientX - rect.left, event.clientY - rect.top);
      const pointer = this.pointers.get(event.pointerId);
      if (this.flight) return;
      if (!pointer) {
        this.hover(this.pick());
        return;
      }
      const dx = event.clientX - pointer.x;
      const dy = event.clientY - pointer.y;
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      if (this.pointers.size >= 2 && this.pinch !== null) {
        const spread = this.spread();
        if (spread > 0) this.orbit = zoomOrbit(this.orbit, this.pinch / spread, this.home);
        this.pinch = spread;
      } else if (this.drag?.id === event.pointerId) {
        const start = this.drag;
        if (
          !start.moved &&
          Math.hypot(event.clientX - start.x, event.clientY - start.y) > CLICK_SLOP
        )
          start.moved = true;
        if (start.moved) this.orbit = dragOrbit(this.orbit, dx, dy);
      }
      this.dirty = true;
    });
    const release = (event: PointerEvent, click: boolean) => {
      this.pointers.delete(event.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
      const drag = this.drag;
      if (drag?.id !== event.pointerId) return;
      this.drag = null;
      if (click && !drag.moved) {
        const id = this.pick();
        if (id) this.options.onEnter(id);
      }
    };
    on(canvas, 'pointerleave', () => {
      this.pointerAt = null;
      if (this.pointers.size === 0) this.hover(null);
    });
    on(canvas, 'pointerup', (event) => release(event, true));
    on(canvas, 'pointercancel', (event) => release(event, false));
    on(
      canvas,
      'wheel',
      (event) => {
        event.preventDefault();
        if (this.flight) return;
        this.reset = null;
        this.orbit = zoomOrbit(this.orbit, Math.exp(event.deltaY * 0.0012), this.home);
        this.dirty = true;
      },
      { passive: false },
    );
    on(canvas, 'dblclick', () => {
      if (this.flight) return;
      const from = { ...this.orbit, azimuth: wrapAngle(this.orbit.azimuth) };
      this.reset = { from, to: homeOrbit(this.home), start: performance.now() };
    });
    const lost = (event: Event) => {
      event.preventDefault();
      this.options.onLost();
    };
    canvas.addEventListener('webglcontextlost', lost);
    this.cleanups.push(() => canvas.removeEventListener('webglcontextlost', lost));
  }

  private spread(): number {
    const [a, b] = [...this.pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }

  /** The node under the pointer, if any. */
  private pick(): string | null {
    if (!this.pointerAt) return null;
    const ndc = new Vector2(
      (this.pointerAt.x / this.width) * 2 - 1,
      -(this.pointerAt.y / this.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const bodies = [...this.nodes.values()].map((e) => e.body);
    const hit = this.raycaster.intersectObjects(bodies, false)[0];
    return (hit?.object.userData.projectId as string | undefined) ?? null;
  }

  /** The monolith under the pointer brightens, its label too, and the cursor says it opens. */
  private hover(id: string | null): void {
    if (id === this.hoverId) return;
    this.hoverId = id;
    this.renderer.domElement.style.cursor = id ? 'pointer' : '';
    for (const entry of this.nodes.values()) {
      if (!entry.label) continue;
      if (entry.id === id) entry.label.el.dataset.hot = '';
      else delete entry.label.el.dataset.hot;
    }
    this.setHot(id);
  }

  private moveCamera(now: number, dt: number): boolean {
    if (this.flight) return this.fly(dt);
    let moving = false;
    if (this.reset) {
      const t = Math.min(1, (now - this.reset.start) / RESET_MS);
      const k = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      const { from, to } = this.reset;
      this.orbit = {
        azimuth: from.azimuth + (to.azimuth - from.azimuth) * k,
        polar: from.polar + (to.polar - from.polar) * k,
        distance: from.distance + (to.distance - from.distance) * k,
      };
      if (t >= 1) this.reset = null;
      moving = true;
    } else if (!this.hovering && this.pointers.size === 0) {
      this.orbit = {
        ...this.orbit,
        azimuth: this.orbit.azimuth + ((2 * Math.PI) / ORBIT_PERIOD_S) * (dt / 1000),
      };
      moving = true;
    }
    const p = orbitPosition(this.orbit, this.target);
    this.camera.position.set(p.x, p.y, p.z);
    this.camera.lookAt(this.target);
    return moving;
  }

  /** One frame of the dive or the rise; the camera holds still once it's in the node. */
  private fly(dt: number): boolean {
    const flight = this.flight;
    if (!flight) return false;
    const before = flight.progress;
    flight.progress = Math.min(1, Math.max(0, before + (flight.dir * dt) / DIVE_MS));
    const k = diveEase(flight.progress);
    const { position, look } = diveAt(flight.path, k);
    this.camera.position.set(position.x, position.y, position.z);
    this.camera.lookAt(look.x, look.y, look.z);
    this.project3d(k);
    this.applyFog(k);
    const arrived = flight.dir === 1 && flight.progress >= 1;
    const home = flight.dir === -1 && flight.progress <= 0;
    if (arrived || home) {
      const done = flight.done;
      flight.done = null;
      if (home) {
        this.flight = null;
        this.moveCamera(0, 0);
      }
      this.markDive();
      done?.();
      return before !== flight.progress;
    }
    return true;
  }

  // --- The frame ----------------------------------------------------------------------------------

  private tick(now: number, dt: number): void {
    if (this.disposed) return;
    if (now - this.lastFlowCheck >= FLOW_CHECK_MS) this.syncFlows(now);
    this.time += dt;

    let moving = this.moveCamera(now, dt) || this.spinning;
    this.pending += dt;

    // Heights follow activity, the core's light follows the board, a new error glitches once.
    for (const entry of this.nodes.values()) {
      const height = approach(entry.height, nodeHeight(entry.activity), dt, 600);
      if (Math.abs(height - entry.height) > 0.001) moving = true;
      entry.height = height;
      entry.body.scale.y = height;
      entry.edges.scale.y = height;
      entry.cap.position.y = height + 0.03;
      entry.cap.material.opacity = 0.15 + 0.75 * entry.activity;
      entry.pool.material.opacity =
        (this.palette.dark ? 0.16 : 0.1) +
        (entry.tone === 'wait' || entry.tone === 'err' ? 0.18 : 0.22 * entry.activity);
      if (entry.beam.visible) {
        // A slow breath, the waiting pod's 2.4 s (DESIGN.md §3 rule 4).
        const breath = 0.5 + 0.5 * Math.sin((this.time / 2400) * 2 * Math.PI);
        entry.beamUniforms.uAlpha.value = 0.18 + 0.14 * breath;
        moving = true;
      }
      const glitch = entry.glitchUntil - now;
      if (glitch > 0) {
        const shift = glitch > GLITCH_MS / 2 ? GLITCH_SHIFT : -GLITCH_SHIFT;
        entry.pipe.position.set(shift, 0, 0);
        moving = true;
      } else if (entry.pipe.position.x !== 0) {
        entry.pipe.position.set(0, 0, 0);
        moving = true;
      }
    }
    const energy = approach(this.energy, this.energyTarget, dt, 1400);
    if (Math.abs(energy - this.energy) > 0.001) moving = true;
    this.energy = energy;
    this.coreLight.material.opacity = 0.2 + 0.6 * energy;
    this.coreHalo.material.opacity = (this.palette.dark ? 0.12 : 0.08) + 0.35 * energy;
    this.core.rotation.y += (dt / 1000) * (0.08 + 0.3 * energy);

    this.field.step(dt / 1000);
    if (this.field.busy) moving = true;

    // Idle: a few frames a second, enough for labels and a resize.
    if (!moving && !this.dirty && now - this.lastRender < IDLE_FRAME_MS) return;
    this.dirty = false;
    this.lastRender = now;

    this.camera.updateMatrixWorld();
    this.placeLabels(Math.min(this.pending, 250));
    this.drawSatellites(Math.min(this.pending, 250));
    this.pending = 0;
    this.drawPackets();
    this.renderer.render(this.scene, this.camera);
  }
}

const isShared = (geometry: BufferGeometry) =>
  geometry === BODY_GEOMETRY ||
  geometry === EDGE_GEOMETRY ||
  geometry === CAP_GEOMETRY ||
  geometry === POOL_GEOMETRY ||
  geometry === BEAM_GEOMETRY ||
  geometry === SPHERE_GEOMETRY ||
  geometry === BOX_GEOMETRY ||
  geometry === PACKET_GEOMETRY;

/** An angle in (-π, π], so a reset turns the short way home. */
function wrapAngle(angle: number): number {
  const turn = 2 * Math.PI;
  const a = ((angle % turn) + turn) % turn;
  return a > Math.PI ? a - turn : a;
}
