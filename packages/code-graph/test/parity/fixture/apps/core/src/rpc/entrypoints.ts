declare class WorkerEntrypoint<E> { env: E }
declare class DurableObject { }
declare class WorkflowEntrypoint { }

export class PublicStore extends WorkerEntrypoint<unknown> {
  async writeFinding(input: string): Promise<string> {
    return this.normalize(input);
  }
  private normalize(input: string): string {
    return input.trim();
  }
  protected guarded(): void {}
  #hidden(): void {}
  static create(): number {
    return 1;
  }
}

export class Room extends DurableObject {
  join(): void {}
}

export class Pipeline extends WorkflowEntrypoint {
  step(): void {}
}

export class Plain {
  helper(): void {}
  get size(): number {
    return 1;
  }
  set size(value: number) {
    this.helper();
  }
}
