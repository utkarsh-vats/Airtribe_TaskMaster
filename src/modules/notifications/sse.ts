import type { Response } from 'express';

/**
 * Open SSE streams per user. In-memory, so it only reaches clients connected to this process;
 * scaling out needs a shared channel (e.g. Redis pub/sub) between instances.
 */
const streams = new Map<string, Set<Response>>();
const heartbeats = new WeakMap<Response, NodeJS.Timeout>();

let heartbeatMs = 25_000;

/** Tests shorten the heartbeat; affects streams opened afterwards. */
export function setHeartbeatInterval(ms: number): void {
    heartbeatMs = ms;
}

function remove(userId: string, res: Response): void {
    clearInterval(heartbeats.get(res));
    heartbeats.delete(res);
    const set = streams.get(userId);
    if (!set) return;
    set.delete(res);
    if (set.size === 0) streams.delete(userId);
}

/**
 * Turns `res` into an event stream for `userId`: SSE headers, an initial `ready` event, a
 * `: ping` comment every heartbeat so proxies keep the connection open, and cleanup on close.
 */
export function openStream(userId: string, res: Response): void {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    // Stops nginx from buffering the stream.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write('event: ready\ndata: {}\n\n');

    let set = streams.get(userId);
    if (!set) {
        set = new Set();
        streams.set(userId, set);
    }
    set.add(res);

    heartbeats.set(
        res,
        setInterval(() => res.write(': ping\n\n'), heartbeatMs),
    );
    res.on('close', () => remove(userId, res));
}

/** Sends one `notification` event to every open stream of `userId`. */
export function pushToUser(userId: string, notification: { id: string }): void {
    const set = streams.get(userId);
    if (!set) return;
    const frame = `id: ${notification.id}\nevent: notification\ndata: ${JSON.stringify(notification)}\n\n`;
    for (const res of set) {
        res.write(frame);
    }
}

export function openStreamCount(userId: string): number {
    return streams.get(userId)?.size ?? 0;
}

/** Ends every open stream. Called on shutdown so they don't hold server.close() open. */
export function closeAllStreams(): void {
    for (const [userId, set] of streams) {
        for (const res of [...set]) {
            remove(userId, res);
            res.end();
        }
    }
}
