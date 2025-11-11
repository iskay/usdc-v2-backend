import { EventEmitter } from 'events';
import type { TxStatusUpdate } from './types.js';

export interface FlowStatusEventEmitter {
  emitStatusUpdate(update: TxStatusUpdate): void;
  onFlowUpdate(flowId: string, callback: (update: TxStatusUpdate) => void): () => void;
  removeAllListeners(flowId?: string): void;
}

class FlowStatusEmitter extends EventEmitter implements FlowStatusEventEmitter {
  emitStatusUpdate(update: TxStatusUpdate): void {
    this.emit(`flow:${update.flowId}`, update);
    this.emit('status-update', update);
  }

  onFlowUpdate(flowId: string, callback: (update: TxStatusUpdate) => void): () => void {
    this.on(`flow:${flowId}`, callback);
    return () => {
      this.off(`flow:${flowId}`, callback);
    };
  }

  removeAllListeners(flowId?: string): this {
    if (flowId) {
      super.removeAllListeners(`flow:${flowId}`);
    } else {
      super.removeAllListeners();
    }
    return this;
  }
}

let globalEmitter: FlowStatusEmitter | undefined;

export function createFlowStatusEmitter(): FlowStatusEventEmitter {
  if (!globalEmitter) {
    globalEmitter = new FlowStatusEmitter();
  }
  return globalEmitter;
}

export function getFlowStatusEmitter(): FlowStatusEventEmitter {
  if (!globalEmitter) {
    return createFlowStatusEmitter();
  }
  return globalEmitter;
}

