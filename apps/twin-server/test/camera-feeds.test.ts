import { describe, expect, it } from 'vitest';
import { CameraFeedMultiplexer, CHANNELS, type FeedMode } from '../src/mjpeg.js';

const STARTING: Record<string, FeedMode> = {
  ch1: 'starting',
  ch2: 'starting',
  ch3: 'starting',
  ch4: 'starting',
};

class FakeSocket {
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: Array<Buffer | string> = [];
  private closeListener: (() => void) | null = null;

  send(data: Buffer | string): void {
    this.sent.push(data);
  }

  on(event: 'close', listener: () => void): void {
    expect(event).toBe('close');
    this.closeListener = listener;
  }

  close(): void {
    this.readyState = 3;
    this.closeListener?.();
  }
}

describe('multiplexed camera feeds', () => {
  it('reports every channel state when a client attaches and when modes change', () => {
    const multiplexer = new CameraFeedMultiplexer();
    const socket = new FakeSocket();
    multiplexer.attach(socket, STARTING);

    expect(JSON.parse(socket.sent[0] as string)).toEqual({
      type: 'camera_feed_states',
      states: STARTING,
    });

    const modes = { ...STARTING, ch1: 'live' as const, ch2: 'replay' as const };
    multiplexer.push([], modes);
    expect(JSON.parse(socket.sent[1] as string)).toEqual({
      type: 'camera_feed_states',
      states: modes,
    });
  });

  it('tags each binary JPEG with protocol version, channel, and honest mode', () => {
    const multiplexer = new CameraFeedMultiplexer();
    const socket = new FakeSocket();
    const modes: Record<string, FeedMode> = {
      ch1: 'live',
      ch2: 'replay',
      ch3: 'starting',
      ch4: 'live',
    };
    multiplexer.attach(socket, modes);
    socket.sent.length = 0;

    multiplexer.push(CHANNELS.map((channel, index) => ({
      channel,
      mode: modes[channel]!,
      jpeg: Buffer.from([0xff, 0xd8, index, 0xff, 0xd9]),
      revision: 1,
    })), modes);

    expect(socket.sent).toHaveLength(4);
    for (let index = 0; index < socket.sent.length; index += 1) {
      const frame = socket.sent[index] as Buffer;
      expect(frame.subarray(0, 4).toString()).toBe('SFCF');
      expect(frame[4]).toBe(1);
      expect(frame[5]).toBe(index + 1);
      expect(frame[6]).toBe([1, 2, 0, 1][index]);
      expect([...frame.subarray(8)]).toEqual([0xff, 0xd8, index, 0xff, 0xd9]);
    }
  });

  it('does not resend a channel revision already delivered to that client', () => {
    const multiplexer = new CameraFeedMultiplexer();
    const socket = new FakeSocket();
    multiplexer.attach(socket, STARTING);
    socket.sent.length = 0;
    const frame = [{ channel: 'ch1' as const, mode: 'live' as const, jpeg: Buffer.from([1]), revision: 7 }];

    multiplexer.push(frame, { ...STARTING, ch1: 'live' });
    multiplexer.push(frame, { ...STARTING, ch1: 'live' });

    expect(socket.sent.filter(Buffer.isBuffer)).toHaveLength(1);
  });

  it('drops under backpressure and later sends only the newest revision', () => {
    const multiplexer = new CameraFeedMultiplexer();
    const socket = new FakeSocket();
    multiplexer.attach(socket, { ...STARTING, ch1: 'live' });
    socket.sent.length = 0;
    socket.bufferedAmount = 4 * 1024 * 1024 + 1;

    multiplexer.push([
      { channel: 'ch1', mode: 'live', jpeg: Buffer.from([0xff, 0xd8, 1, 0xff, 0xd9]), revision: 1 },
    ], { ...STARTING, ch1: 'live' });
    expect(socket.sent).toHaveLength(0);

    socket.bufferedAmount = 0;
    multiplexer.push([
      { channel: 'ch1', mode: 'live', jpeg: Buffer.from([0xff, 0xd8, 2, 0xff, 0xd9]), revision: 2 },
    ], { ...STARTING, ch1: 'live' });

    expect(socket.sent).toHaveLength(1);
    expect([...(socket.sent[0] as Buffer).subarray(8)]).toEqual([0xff, 0xd8, 2, 0xff, 0xd9]);
  });
});
