/**
 * Typed event bus.
 *
 * Systems talk to each other through this rather than through direct references, which keeps
 * the module graph acyclic — combat can announce a kill without importing the audio, UI, and
 * particle systems that react to it.
 *
 * Payload contract: handlers must not retain the payload object past the end of their call.
 * Emitters reuse payload objects to keep the loop allocation-free.
 */

import type { EventBus, EventHandler, EventName, GameEvents } from './types';

export class TypedEventBus implements EventBus {
  private readonly handlers = new Map<EventName, Array<(payload: never) => void>>();
  /** Handlers added during a dispatch, applied after it finishes. */
  private readonly pendingAdds: Array<{ name: EventName; handler: (payload: never) => void }> = [];
  private dispatchDepth = 0;

  on<K extends EventName>(name: K, handler: EventHandler<K>): () => void {
    const fn = handler as (payload: never) => void;
    if (this.dispatchDepth > 0) {
      // Mutating the list mid-dispatch would skip or double-run handlers.
      this.pendingAdds.push({ name, handler: fn });
    } else {
      let list = this.handlers.get(name);
      if (!list) {
        list = [];
        this.handlers.set(name, list);
      }
      list.push(fn);
    }
    return () => this.off(name, handler);
  }

  off<K extends EventName>(name: K, handler: EventHandler<K>): void {
    const list = this.handlers.get(name);
    if (!list) return;
    const i = list.indexOf(handler as (payload: never) => void);
    if (i >= 0) list.splice(i, 1);
  }

  /** Subscribes for exactly one dispatch. */
  once<K extends EventName>(name: K, handler: EventHandler<K>): () => void {
    const wrapped = ((payload: GameEvents[K]) => {
      this.off(name, wrapped);
      handler(payload);
    }) as EventHandler<K>;
    return this.on(name, wrapped);
  }

  emit<K extends EventName>(name: K, payload: GameEvents[K]): void {
    const list = this.handlers.get(name);
    if (!list || list.length === 0) return;

    this.dispatchDepth++;
    // Index-based so a handler removing itself shrinks the list safely.
    for (let i = 0; i < list.length; i++) {
      try {
        (list[i] as (p: GameEvents[K]) => void)(payload);
      } catch (err) {
        // One broken listener must not take down the frame.
        console.error(`[events] handler for "${String(name)}" threw:`, err);
      }
    }
    this.dispatchDepth--;

    if (this.dispatchDepth === 0 && this.pendingAdds.length > 0) {
      for (const add of this.pendingAdds) {
        let l = this.handlers.get(add.name);
        if (!l) {
          l = [];
          this.handlers.set(add.name, l);
        }
        l.push(add.handler);
      }
      this.pendingAdds.length = 0;
    }
  }

  clear(): void {
    this.handlers.clear();
    this.pendingAdds.length = 0;
    this.dispatchDepth = 0;
  }
}
