import { decode, encode } from '@msgpack/msgpack';

export type ActorClass = 'car' | 'truck' | 'bus' | 'motorcycle' | 'bicycle' | 'pedestrian' | 'prop';
export interface SceneActor {
  id: string;
  kind: 'spawn' | 'update' | 'despawn';
  position: [number, number, number];
  rotation: [number, number, number, number];
  yawRad: number;
  velocity: [number, number, number];
  acceleration: [number, number, number];
}
export interface TruthActor { id: string; class: ActorClass; dims: { l: number; w: number; h: number }; accel: { ax: number; ay: number } }
export interface SignalSnapshot { signalId: string; phase: string; [key: string]: unknown }
export interface TruthFrame {
  tick: number;
  timeSec: number;
  scene: { tick: number; t: number; actors: SceneActor[] };
  signals: SignalSnapshot[];
  actors: TruthActor[];
}

const MAX_PAYLOAD = 64 * 1024 * 1024;

export function encodeTruthFrame(frame: TruthFrame): Uint8Array {
  const payload = encode(frame);
  const framed = new Uint8Array(payload.byteLength + 4);
  new DataView(framed.buffer).setUint32(0, payload.byteLength, true);
  framed.set(payload, 4);
  return framed;
}

export function decodeTruthFrame(bytes: Uint8Array): TruthFrame {
  if (bytes.byteLength < 4) throw new Error('truth_frame is missing its 4-byte length prefix');
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  if (size > MAX_PAYLOAD) throw new Error(`truth_frame payload exceeds 64 MiB (${size})`);
  if (size !== bytes.byteLength - 4) throw new Error(`truth_frame length mismatch: header=${size}, bytes=${bytes.byteLength - 4}`);
  const frame = decode(bytes.subarray(4)) as Partial<TruthFrame>;
  if (!Number.isFinite(frame.tick) || !Number.isFinite(frame.timeSec) || !frame.scene || !Array.isArray(frame.scene.actors) || !Array.isArray(frame.actors) || !Array.isArray(frame.signals)) {
    throw new Error('truth_frame does not satisfy the frozen TruthFrame schema');
  }
  if (frame.scene.tick !== frame.tick || frame.scene.t !== frame.timeSec) throw new Error('truth_frame scene clock is not atomic');
  return frame as TruthFrame;
}

export class TruthFrameStream {
  private buffered = new Uint8Array(0);

  push(chunk: Uint8Array): TruthFrame[] {
    const merged = new Uint8Array(this.buffered.byteLength + chunk.byteLength);
    merged.set(this.buffered);
    merged.set(chunk, this.buffered.byteLength);
    const frames: TruthFrame[] = [];
    let offset = 0;
    while (merged.byteLength - offset >= 4) {
      const size = new DataView(merged.buffer, merged.byteOffset + offset, 4).getUint32(0, true);
      if (size > MAX_PAYLOAD) throw new Error(`truth_frame payload exceeds 64 MiB (${size})`);
      if (merged.byteLength - offset < size + 4) break;
      frames.push(decodeTruthFrame(merged.subarray(offset, offset + size + 4)));
      offset += size + 4;
    }
    this.buffered = merged.slice(offset);
    return frames;
  }
}

export interface InterpolatedActor extends SceneActor, TruthActor { ghost: boolean }

export function interpolateFrames(previous: TruthFrame, next: TruthFrame, simulationTime: number): InterpolatedActor[] {
  const denominator = Math.max(1e-6, next.timeSec - previous.timeSec);
  const alpha = Math.max(0, Math.min(1, (simulationTime - previous.timeSec) / denominator));
  const old = new Map(previous.scene.actors.map((actor) => [actor.id, actor]));
  const metadata = new Map(next.actors.map((actor) => [actor.id, actor]));
  return next.scene.actors.filter((actor) => actor.kind !== 'despawn').map((actor) => {
    const before = old.get(actor.id) ?? actor;
    const info = metadata.get(actor.id) ?? { id: actor.id, class: 'prop' as const, dims: { l: 1, w: 1, h: 1 }, accel: { ax: 0, ay: 0 } };
    return {
      ...actor,
      ...info,
      position: actor.position.map((value, index) => before.position[index]! + (value - before.position[index]!) * alpha) as [number, number, number],
      yawRad: before.yawRad + Math.atan2(Math.sin(actor.yawRad - before.yawRad), Math.cos(actor.yawRad - before.yawRad)) * alpha,
      ghost: /ghost|mirror|detection/i.test(actor.id),
    };
  });
}
