import type { Occupancy, PostSessionCleanSettings } from '@vade/protocol';

export interface PostSessionDeps {
  getSettings(): PostSessionCleanSettings;
  getOccupancy(): Occupancy;
  /** A job / login / update is running: the quick clean must not interfere */
  isBusy(): boolean;
  run(): Promise<void>;
  log(msg: string): void;
  /** Time the armed clean fires (null = not armed), shown by the admin app */
  onPending(at: string | null): void;
}

/**
 * occupied -> free: wait delaySec; if the PC did not become occupied again (the client was only
 * topping up time), run the quick clean once. Unknown occupancy postpones it: nothing is cleaned
 * on uncertain data.
 */
export class PostSessionWatcher {
  /** A client was on the PC since the last clean */
  private armed = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly d: PostSessionDeps) {}

  onTransition(_prev: Occupancy, next: Occupancy): void {
    if (next === 'occupied') {
      this.armed = true;
      if (this.timer) {
        this.cancel();
        this.d.log('Клієнт повернувся — швидке очищення скасовано');
      }
      return;
    }
    if (next === 'free') {
      const s = this.d.getSettings();
      if (!this.armed || !s.enabled || this.timer) return;
      const delay = Math.max(0, Math.min(3600, Math.round(s.delaySec)));
      const at = new Date(Date.now() + delay * 1000).toISOString();
      this.d.log(`Клієнт вийшов — швидке очищення через ${delay} с, якщо ПК лишиться вільним`);
      this.timer = setTimeout(() => void this.fire(), delay * 1000);
      this.d.onPending(at);
      return;
    }
    if (this.timer) {
      this.cancel();
      this.d.log('Стан ПК невідомий — швидке очищення відкладено');
    }
  }

  stop(): void {
    this.cancel();
  }

  private cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.d.onPending(null);
  }

  private async fire(): Promise<void> {
    this.timer = null;
    this.d.onPending(null);
    if (this.d.getOccupancy() !== 'free') return; // stays armed: the next free re-arms it
    if (!this.d.getSettings().enabled) return;
    this.armed = false;
    if (this.d.isBusy()) {
      this.d.log('Швидке очищення пропущено: на ПК виконується інше завдання');
      return;
    }
    try {
      await this.d.run();
    } catch (e) {
      this.d.log(`Швидке очищення не вдалося: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
