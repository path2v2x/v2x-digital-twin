import { useEffect, useRef } from 'react';
import { ActorRenderer, type ActorView, type CityViewer } from '@simforge/viewer';
import { CityView } from '@simforge/viewer/react';
import type { Material, Mesh } from 'three';
import { applyCalibratedCamera, type TwinCamera } from '../lib/cameras';
import { interpolateFrames, type ActorClass, type TruthFrame } from '../lib/truth';

const CATALOG_BY_CLASS: Record<ActorClass, string> = {
  car: 'vehicle.sedan', truck: 'vehicle.box_truck', bus: 'vehicle.bus', motorcycle: 'vehicle.motorcycle',
  bicycle: 'vehicle.bicycle', pedestrian: 'pedestrian.adult', prop: 'street.traffic_cone',
};

interface TwinSceneProps {
  frames: readonly TruthFrame[];
  camera?: TwinCamera;
  followActorId?: string | null;
  cameraMode?: 'chase' | 'first-person';
  className?: string;
  onReady?: (viewer: CityViewer) => void;
}

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

export function TwinScene({ frames, camera, followActorId, cameraMode = 'chase', className, onReady }: TwinSceneProps) {
  const viewerRef = useRef<CityViewer | null>(null);
  const rendererRef = useRef<ActorRenderer | null>(null);
  const framesRef = useRef(frames);
  const followRef = useRef(followActorId);
  const modeRef = useRef(cameraMode);
  framesRef.current = frames;
  followRef.current = followActorId;
  modeRef.current = cameraMode;

  useEffect(() => {
    let animation = 0;
    const render = () => {
      const viewer = viewerRef.current;
      const actorRenderer = rendererRef.current;
      const currentFrames = framesRef.current;
      if (viewer && actorRenderer && currentFrames.length) {
        const next = currentFrames[currentFrames.length - 1]!;
        const previous = currentFrames[currentFrames.length - 2] ?? next;
        const presentationTime = previous.timeSec + Math.min(next.timeSec - previous.timeSec, performance.now() % 50 / 1000);
        const actors = interpolateFrames(previous, next, presentationTime);
        const views: ActorView[] = actors.map((actor) => ({
          id: actor.id, catalogId: CATALOG_BY_CLASS[actor.class], x: actor.position[0], y: actor.position[1], z: actor.position[2],
          headingRad: actor.yawRad, dims: actor.dims, bodyColor: actor.ghost ? '#24e6ff' : undefined,
          speedMps: Math.hypot(...actor.velocity), animationTimeS: presentationTime,
        }));
        actorRenderer.sync(views);
        updateSignalHeads(viewer, next);
        const followed = actors.find((actor) => actor.id === followRef.current);
        if (followed) {
          const heading = followed.yawRad;
          const firstPerson = modeRef.current === 'first-person';
          const distance = firstPerson ? -1.2 : 9;
          const height = firstPerson ? 1.45 : 4.5;
          const eyeX = followed.position[0] - Math.sin(heading) * distance;
          const eyeZ = followed.position[2] - Math.cos(heading) * distance;
          viewer.setCameraPoseConstraintsEnabled(false);
          viewer.controls.setEnabled(false);
          viewer.camera.position.lerp({ x: eyeX, y: followed.position[1] + height, z: eyeZ }, .18);
          viewer.controls.target.set(followed.position[0] + Math.sin(heading) * 8, followed.position[1] + 1, followed.position[2] + Math.cos(heading) * 8);
          viewer.camera.lookAt(viewer.controls.target);
        }
      }
      animation = requestAnimationFrame(render);
    };
    animation = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animation);
  }, []);

  return <CityView
    className={className}
    manifestUrl="/map/browser-manifest"
    ariaLabel={camera ? `${camera.id} calibrated digital twin render` : 'Richmond Field Station digital twin'}
    role="application"
    tabIndex={0}
    options={{ antialias: true, maxPixelRatio: 1, cinematicLighting: true, byteBudget: camera ? 96_000_000 : 256_000_000 }}
    onReady={(viewer) => {
      viewerRef.current = viewer;
      const renderer = new ActorRenderer();
      renderer.group.name = 'v2x-truth-actors';
      viewer.scene.add(renderer.group);
      rendererRef.current = renderer;
      if (camera) applyCalibratedCamera(viewer, camera);
      onReady?.(viewer);
    }}
  />;
}
