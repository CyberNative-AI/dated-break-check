// Scan worker: the regexes run here, so the main thread keeps a free event loop to stop this thread at the deadline
// (a catastrophic pattern blocks only this thread) and the thread's heap limit bounds its memory.
import { parentPort, workerData } from 'node:worker_threads';
import { scanTree } from './walk.mjs';

const { base, sigs, limits } = workerData;
parentPort.postMessage(scanTree(base, sigs, limits));
