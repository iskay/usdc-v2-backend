import type { FastifyInstance } from 'fastify';
import { WebSocketServer, type WebSocket as WS } from 'ws';
import type { AppLogger } from '../common/utils/logger.js';
import { getFlowStatusEmitter } from '../modules/tx-tracker/events.js';

export interface WebSocketManager {
  server: WebSocketServer;
  close(): Promise<void>;
}

export function createWebSocketManager(
  app: FastifyInstance,
  logger: AppLogger
): WebSocketManager {
  const eventEmitter = getFlowStatusEmitter();
  const wss = new WebSocketServer({ noServer: true });

  const connections = new Map<string, Set<WS>>();
  const flowSubscriptions = new Map<WS, Set<string>>();

  // Handle WebSocket upgrade
  app.server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws: WS) => {
    const connectionId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    logger.debug({ connectionId }, 'WebSocket connection established');

    if (!connections.has(connectionId)) {
      connections.set(connectionId, new Set());
    }
    connections.get(connectionId)!.add(ws);

    if (!flowSubscriptions.has(ws)) {
      flowSubscriptions.set(ws, new Set());
    }

    // Handle incoming messages
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString()) as {
          type: string;
          flowId?: string;
        };

        if (message.type === 'subscribe' && message.flowId) {
          const subscriptions = flowSubscriptions.get(ws);
          if (subscriptions) {
            subscriptions.add(message.flowId);
            logger.debug({ connectionId, flowId: message.flowId }, 'Subscribed to flow updates');
            
            // Subscribe to event emitter
            eventEmitter.onFlowUpdate(message.flowId, (update) => {
              if (ws.readyState === 1) { // OPEN
                ws.send(JSON.stringify({ type: 'status-update', data: update }));
              }
            });
          }
        } else if (message.type === 'unsubscribe' && message.flowId) {
          const subscriptions = flowSubscriptions.get(ws);
          if (subscriptions) {
            subscriptions.delete(message.flowId);
            logger.debug({ connectionId, flowId: message.flowId }, 'Unsubscribed from flow updates');
          }
        }
      } catch (error) {
        logger.warn({ err: error, connectionId }, 'Failed to parse WebSocket message');
      }
    });

    // Handle connection close
    ws.on('close', () => {
      const subscriptions = flowSubscriptions.get(ws);
      if (subscriptions) {
        subscriptions.clear();
      }
      flowSubscriptions.delete(ws);

      const connSet = connections.get(connectionId);
      if (connSet) {
        connSet.delete(ws);
        if (connSet.size === 0) {
          connections.delete(connectionId);
        }
      }

      logger.debug({ connectionId }, 'WebSocket connection closed');
    });

    // Handle errors
    ws.on('error', (error) => {
      logger.error({ err: error, connectionId }, 'WebSocket error');
    });

    // Send welcome message
    if (ws.readyState === 1) { // OPEN
      ws.send(
        JSON.stringify({
          type: 'connected',
          connectionId,
          message: 'Connected to USDC v2 Backend WebSocket',
        })
      );
    }
  });

  // Subscribe to global status updates and broadcast to subscribed clients
  // Note: We'll handle this in the individual flow subscriptions above
  // The eventEmitter.onFlowUpdate is called per-flow, so each subscription
  // will receive updates for its specific flow

  return {
    server: wss,
    async close() {
      logger.info('Closing WebSocket server...');
      
      // Close all connections
      for (const connSet of connections.values()) {
        for (const ws of connSet) {
          if (ws.readyState === 1 || ws.readyState === 0) { // OPEN or CONNECTING
            ws.close();
          }
        }
      }

      await new Promise<void>((resolve) => {
        wss.close(() => {
          resolve();
        });
      });

      connections.clear();
      flowSubscriptions.clear();
      logger.info('WebSocket server closed');
    },
  };
}

