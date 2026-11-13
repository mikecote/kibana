/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

export { composeCapabilities } from './src/compose_capabilities';
export type { CapabilityResolver, CapabilityComposition } from './src/compose_capabilities';
export { IpcTransport } from './src/ipc_transport';
export type { IpcChannel, IpcTraffic } from './src/ipc_transport';
export { openIpcSession } from './src/ipc_session';
export type { IpcSession } from './src/ipc_session';

export { openWebSocketSession } from './src/web_socket_session';
