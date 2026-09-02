import { useEffect, useRef } from 'react';
import { ActorRenderer, type ActorView, type CityViewer } from '@simforge-oss/viewer';
import { CityView } from '@simforge-oss/viewer/react';
import { Raycaster, Vector3, type Material, type Mesh, type Object3D } from 'three';
import { applyCalibratedCamera, calibratedPose, type TwinCamera } from '../lib/cameras';
import { interpolateFrames, type ActorClass, type TruthFrame } from '../lib/truth';

const CATALOG_BY_CLASS: Record<ActorClass, string> = {
  car: 'vehicle.sedan', truck: 'vehicle.box_truck', bus: 'vehicle.bus', motorcycle: 'vehicle.motorcycle',
  bicycle: 'vehicle.bicycle', pedestrian: 'pedestrian.adult', prop: 'street.traffic_cone',
};

/** What a calibrated camera actually looks at, measured against the loaded map.
 * `no-coverage` means the bearing leaves the tiled ground entirely; `obstructed`
 * means scene geometry sits inside the near field. Both exist so a pane can say
 * why it looks empty instead of rendering an unexplained blank. */
export interface SceneFraming {
  state: 'loading' | 'framed' | 'no-coverage' | 'obstructed' | 'error';
  /** Metres to the first scene surface on the calibrated bearing, when hit. */
  distanceM: number | null;
}

interface TwinSceneProps {
  frames: readonly TruthFrame[];
  camera?: TwinCamera;
  followActorId?: string | null;
  cameraMode?: 'chase' | 'first-person';
  className?: string;
  onReady?: (viewer: CityViewer) => void;
  /** Reported for `camera` renders once the map has streamed, then on retry. */
  onFraming?: (framing: SceneFraming) => void;
}

/** Ground probe: 2 m steps along the view ray out to 140 m. */
const PROBE_STEP_M = 2;
const PROBE_RANGE_M = 140;
/** Anything this close on the bearing fills the frame rather than framing it. */
const OBSTRUCTION_M = 4;

function updateSignalHeads(viewer: CityViewer, frame: TruthFrame): void {
  const phaseById: Record<string, string> = Object.fromEntries(frame.signals.map((signal) => [signal.signalId, signal.phase.toLowerCase()]));
  viewer.scene.traverse((object) => {
    const id = String(object.userData.signalId ?? object.name);
    const phase = Object.entries(phaseById).find(([signalId]) => id.includes(signalId))?.[1];
    if (!phase) return;
    const mesh = object as Mesh;
    const materials = !mesh.material ? [] : (Array.isArray(mesh.material) ? mesh.material : [mesh.material]);
    const color = phase.includes('green') ? 0x21dd77 : phase.includes('yellow') ? 0xffc83d : 0xff3d58;
    for (const material of materials as Material[]) {
      if ('emissive' in material) (material as Material & { emissive: { setHex(value: number): void }; emissiveIntensity: number }).emissive.setHex(color);
    }
  });
}

function isDescendantOf(object: Object3D, ancestor: Object3D): boolean {
  for (let node: Object3D | null = object; node; node = node.parent) if (node === ancestor) return true;
  return false;
}

/** Measures the calibrated bearing against the streamed map: is there tiled
 * ground in view, and does anything sit inside the near field. */
function probeFraming(viewer: CityViewer, camera: TwinCamera, actors: Object3D | null): SceneFraming {
  const pose = calibratedPose(camera);
  const groundHeight = viewer.sampleGroundHeight(pose.position[0], pose.position[2]) ?? 0;
  const origin = new Vector3(pose.position[0], pose.position[1] + groundHeight, pose.position[2]);
  const direction = new Vector3(pose.target[0], pose.target[1] + groundHeight, pose.target[2]).sub(origin).normalize();

  let covered = false;
  for (let distance = PROBE_STEP_M; distance <= PROBE_RANGE_M && !covered; distance += PROBE_STEP_M) {
    covered = viewer.sampleGroundHeight(origin.x + direction.x * distance, origin.z + direction.z * distance) !== null;
  }

  const raycaster = new Raycaster(origin, direction, 0.2, PROBE_RANGE_M);
  const hit = raycaster.intersectObject(viewer.scene, true)
    .find((candidate) => !(actors && isDescendantOf(candidate.object, actors)));
  const distanceM = hit ? hit.distance : null;

  if (!covered) return { state: 'no-coverage', distanceM };
  if (distanceM !== null && distanceM < OBSTRUCTION_M) return { state: 'obstructed', distanceM };
  return { state: 'framed', distanceM };
}

export function TwinScene({ frames, camera, followActorId, cameraMode = 'chase', className, onReady, onFraming }: TwinSceneProps) {
  const viewerRef = useRef<CityViewer | null>(null);
  const rendererRef = useRef<ActorRenderer | null>(null);
  const framesRef = useRef(frames);
  const followRef = useRef(followActorId);
  const modeRef = useRef(cameraMode);
  const framingRef = useRef(onFraming);
  const probeRef = useRef(0);
  framesRef.current = frames;
  followRef.current = followActorId;
  modeRef.current = cameraMode;
  framingRef.current = onFraming;

  useEffect(() => {
    let animation = 0;
    let coverageTick = 0;
    let coverageState: SceneFraming['state'] | null = null;
    let lastFollowMs = performance.now();
    const render = () => {
      const viewer = viewerRef.current;
      const actorRenderer = rendererRef.current;
      const currentFrames = framesRef.current;
      if (viewer && actorRenderer && currentFrames.length) {
        const next = currentFrames[currentFrames.length - 1]!;
        const previous = currentFrames[currentFrames.length - 2] ?? next;
        const presentationTime = previous.timeSec + Math.min(next.timeSec - previous.timeSec, performance.now() % 50 / 1000);
        const actors = interpolateFrames(previous, next, presentationTime);
        // The engine's truth is planar: every actor arrives at y = 0. Richmond's
        // terrain is not flat (bundle scene bounds span y -24..37), so an actor
        // placed at its literal y is buried under the road wherever the ground
        // rises — which also put the chase camera under the surface and rendered
        // a white void. Lift each actor onto the sampled ground at its own XZ.
        const groundAt = (x: number, z: number): number => viewer.sampleGroundHeight(x, z) ?? 0;
        const views: ActorView[] = actors.map((actor) => ({
          id: actor.id, catalogId: CATALOG_BY_CLASS[actor.class],
          x: actor.position[0], y: actor.position[1] + groundAt(actor.position[0], actor.position[2]), z: actor.position[2],
          headingRad: actor.yawRad, dims: actor.dims, bodyColor: actor.ghost ? '#24e6ff' : undefined,
          speedMps: Math.hypot(...actor.velocity), animationTimeS: presentationTime,
        }));
        actorRenderer.sync(views);
        updateSignalHeads(viewer, next);
        const followed = actors.find((actor) => actor.id === followRef.current);
        if (followed) {
          // Scene forward for a truth yaw is (cos, -sin): the renderer rotates
          // the actor's local +X about +Y, and measured ego velocity matches it.
          // Chasing along (sin, cos) framed the vehicle broadside.
          const forwardX = Math.cos(followed.yawRad);
          const forwardZ = -Math.sin(followed.yawRad);
          // Cockpit view sits at the windscreen line, derived from the actor's
          // own dimensions: vehicle interiors are not modelled, so an eye point
          // inside the shell would render the roof and hood, not the road.
          const firstPerson = modeRef.current === 'first-person';
          const offset = firstPerson ? followed.dims.l * .42 : -9;
          const height = firstPerson ? followed.dims.h * .9 : 4.5;
          viewer.setCameraPoseConstraintsEnabled(false);
          viewer.controls.setEnabled(false);
          // Frame-rate independent smoothing. A fixed per-frame lerp lags by
          // speed x frametime / alpha, which on a software renderer left the
          // camera tens of metres behind the ego; this converges the same way
          // at any frame rate.
          const now = performance.now();
          const delta = Math.min(.25, (now - lastFollowMs) / 1000);
          lastFollowMs = now;
          const alpha = 1 - Math.exp(-(firstPerson ? 14 : 7) * delta);
          const followGroundY = followed.position[1] + groundAt(followed.position[0], followed.position[2]);
          viewer.camera.position.lerp({
            x: followed.position[0] + forwardX * offset,
            y: followGroundY + height,
            z: followed.position[2] + forwardZ * offset,
          }, alpha);
          const targetX = followed.position[0] + forwardX * 8;
          const targetZ = followed.position[2] + forwardZ * 8;
          viewer.controls.target.set(targetX, groundAt(targetX, targetZ) + 1, targetZ);
          viewer.camera.lookAt(viewer.controls.target);

          // The road network reaches past the streamed 3D tiles, so an ego can
          // drive off the mapped ground. Say so instead of rendering a void.
          if (framingRef.current && ++coverageTick % 30 === 0) {
            const onMap = viewer.sampleGroundHeight(followed.position[0], followed.position[2]) !== null;
            const state = onMap ? 'framed' : 'no-coverage';
            if (state !== coverageState) {
              coverageState = state;
              framingRef.current({ state, distanceM: null });
            }
          }
        }
      }
      animation = requestAnimationFrame(render);
    };
    animation = requestAnimationFrame(render);
    return () => { cancelAnimationFrame(animation); window.clearTimeout(probeRef.current); };
  }, []);

  return <CityView
    className={className}
    manifestUrl="/map/3d/manifest.json"
    ariaLabel={camera ? `${camera.id} calibrated digital twin render` : 'Richmond Field Station digital twin'}
    role="application"
    tabIndex={0}
    options={{ antialias: true, maxPixelRatio: 1, cinematicLighting: true, byteBudget: camera ? 96_000_000 : 256_000_000 }}
    onReady={(viewer) => {
      viewerRef.current = viewer;
      if (import.meta.env.DEV) (window as unknown as { __twinViewer?: unknown }).__twinViewer = viewer;
      const renderer = new ActorRenderer();
      renderer.group.name = 'v2x-truth-actors';
      viewer.scene.add(renderer.group);
      rendererRef.current = renderer;
      if (camera) applyCalibratedCamera(viewer, camera);
      onReady?.(viewer);
    }}
    onMapLoaded={() => {
      const viewer = viewerRef.current;
      if (!viewer || !camera) return;
      applyCalibratedCamera(viewer, camera);
      framingRef.current?.(probeFraming(viewer, camera, rendererRef.current?.group ?? null));
      // Tiles keep streaming after the map reports ready, so measure the
      // bearing again once the near field has settled.
      window.clearTimeout(probeRef.current);
      probeRef.current = window.setTimeout(() => {
        const settled = viewerRef.current;
        if (settled) framingRef.current?.(probeFraming(settled, camera, rendererRef.current?.group ?? null));
      }, 2_000);
    }}
    onError={() => framingRef.current?.({ state: 'error', distanceM: null })}
  />;
}
