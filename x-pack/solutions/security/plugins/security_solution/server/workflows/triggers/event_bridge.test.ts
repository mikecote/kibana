/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/core/server';
import { httpServerMock } from '@kbn/core/server/mocks';
import { SecuritySolutionEventBus } from '../../events/event_bus';
import { registerSecurityWorkflowEventBridge } from './event_bridge';
import {
  AlertStatusChangedTriggerId,
  AlertTagsChangedTriggerId,
  AlertAssigneesChangedTriggerId,
  AttackStatusChangedTriggerId,
  AttackTagsChangedTriggerId,
  AttackAssigneesChangedTriggerId,
  NoteCreatedTriggerId,
  NoteUpdatedTriggerId,
} from '../../../common/workflows/triggers';

const mockRequest = httpServerMock.createKibanaRequest();

describe('registerSecurityWorkflowEventBridge', () => {
  let bus: SecuritySolutionEventBus;
  let mockEmitEvent: jest.Mock;
  let mockGetClient: jest.Mock;
  let mockWorkflowsExtensions: Parameters<typeof registerSecurityWorkflowEventBridge>[1];
  let mockLogger: Pick<Logger, 'warn'>;

  beforeEach(() => {
    bus = new SecuritySolutionEventBus();
    mockEmitEvent = jest.fn().mockResolvedValue(undefined);
    mockGetClient = jest.fn().mockResolvedValue({ emitEvent: mockEmitEvent });
    mockWorkflowsExtensions = {
      getClient: mockGetClient,
    };
    mockLogger = { warn: jest.fn() };
  });

  afterEach(() => {
    bus.removeAllListeners();
  });

  it('waits for pending native forwards before run completion', async () => {
    let finish: (() => void) | undefined;
    const emitted = new Promise<void>((resolve) => {
      finish = resolve;
    });
    mockEmitEvent.mockReturnValue(emitted);
    const complete = registerSecurityWorkflowEventBridge(bus, mockWorkflowsExtensions, mockLogger);
    bus.emitAlertTagsChanged(mockRequest, {
      alertIds: ['a'],
      tagsAdded: ['triage'],
      tagsRemoved: [],
      truncated: false,
    });
    let completed = false;
    const completion = complete().then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    if (!finish) throw new Error('Native event resolver is missing');
    finish();
    await completion;
    expect(completed).toBe(true);
  });

  it('does nothing when workflowsExtensions is undefined', () => {
    registerSecurityWorkflowEventBridge(bus, undefined, mockLogger);
    bus.emitAlertStatusChanged(mockRequest, {
      alertIds: [],
      status: 'open',
      previousStatuses: [],
      truncated: false,
    });
    expect(mockEmitEvent).not.toHaveBeenCalled();
  });

  describe.each([
    {
      name: 'alertStatusChanged',
      triggerId: AlertStatusChangedTriggerId,
      emit: (b: SecuritySolutionEventBus) =>
        b.emitAlertStatusChanged(mockRequest, {
          alertIds: ['a'],
          status: 'open' as const,
          previousStatuses: [],
          truncated: false,
        }),
      expectedPayload: {
        alertIds: ['a'],
        status: 'open',
        previousStatuses: [],
        truncated: false,
      },
    },
    {
      name: 'alertTagsChanged',
      triggerId: AlertTagsChangedTriggerId,
      emit: (b: SecuritySolutionEventBus) =>
        b.emitAlertTagsChanged(mockRequest, {
          alertIds: ['a'],
          tagsAdded: ['t'],
          tagsRemoved: [],
          truncated: false,
        }),
      expectedPayload: { alertIds: ['a'], tagsAdded: ['t'], tagsRemoved: [], truncated: false },
    },
    {
      name: 'alertAssigneesChanged',
      triggerId: AlertAssigneesChangedTriggerId,
      emit: (b: SecuritySolutionEventBus) =>
        b.emitAlertAssigneesChanged(mockRequest, {
          alertIds: ['a'],
          assigneesAdded: ['uid'],
          assigneesRemoved: [],
          truncated: false,
        }),
      expectedPayload: {
        alertIds: ['a'],
        assigneesAdded: ['uid'],
        assigneesRemoved: [],
        truncated: false,
      },
    },
    {
      name: 'attackStatusChanged',
      triggerId: AttackStatusChangedTriggerId,
      emit: (b: SecuritySolutionEventBus) =>
        b.emitAttackStatusChanged(mockRequest, {
          attackIds: ['a'],
          status: 'closed' as const,
          previousStatuses: [],
          truncated: false,
        }),
      expectedPayload: {
        attackIds: ['a'],
        status: 'closed',
        previousStatuses: [],
        truncated: false,
      },
    },
    {
      name: 'attackTagsChanged',
      triggerId: AttackTagsChangedTriggerId,
      emit: (b: SecuritySolutionEventBus) =>
        b.emitAttackTagsChanged(mockRequest, {
          attackIds: ['a'],
          tagsAdded: ['t'],
          tagsRemoved: [],
          truncated: false,
        }),
      expectedPayload: {
        attackIds: ['a'],
        tagsAdded: ['t'],
        tagsRemoved: [],
        truncated: false,
      },
    },
    {
      name: 'attackAssigneesChanged',
      triggerId: AttackAssigneesChangedTriggerId,
      emit: (b: SecuritySolutionEventBus) =>
        b.emitAttackAssigneesChanged(mockRequest, {
          attackIds: ['a'],
          assigneesAdded: ['uid'],
          assigneesRemoved: [],
          truncated: false,
        }),
      expectedPayload: {
        attackIds: ['a'],
        assigneesAdded: ['uid'],
        assigneesRemoved: [],
        truncated: false,
      },
    },
    {
      name: 'noteCreated',
      triggerId: NoteCreatedTriggerId,
      emit: (b: SecuritySolutionEventBus) =>
        b.emitNoteCreated(mockRequest, {
          noteId: 'n1',
          createdBy: 'user',
          documentId: 'doc',
        }),
      expectedPayload: {
        noteId: 'n1',
        createdBy: 'user',
        documentId: 'doc',
      },
    },
    {
      name: 'noteUpdated',
      triggerId: NoteUpdatedTriggerId,
      emit: (b: SecuritySolutionEventBus) =>
        b.emitNoteUpdated(mockRequest, {
          noteId: 'n1',
          updatedBy: 'user',
          documentId: 'doc',
        }),
      expectedPayload: {
        noteId: 'n1',
        updatedBy: 'user',
        documentId: 'doc',
      },
    },
  ])('$name', ({ triggerId, emit, expectedPayload }) => {
    it('calls emitEvent with the correct trigger ID and payload', async () => {
      registerSecurityWorkflowEventBridge(bus, mockWorkflowsExtensions, mockLogger);
      emit(bus);
      // flush async microtasks from void forward(...)
      await new Promise((r) => setTimeout(r, 0));
      expect(mockGetClient).toHaveBeenCalledWith(mockRequest);
      expect(mockEmitEvent).toHaveBeenCalledWith(triggerId, expectedPayload);
    });
  });

  it('logs a warning when emitEvent throws and does not rethrow', async () => {
    mockEmitEvent.mockRejectedValue(new Error('workflow platform error'));
    registerSecurityWorkflowEventBridge(bus, mockWorkflowsExtensions, mockLogger);
    bus.emitAlertStatusChanged(mockRequest, {
      alertIds: [],
      status: 'open',
      previousStatuses: [],
      truncated: false,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(AlertStatusChangedTriggerId)
    );
  });

  it('logs a warning when getClient throws and does not rethrow', async () => {
    mockGetClient.mockRejectedValue(new Error('auth error'));
    registerSecurityWorkflowEventBridge(bus, mockWorkflowsExtensions, mockLogger);
    bus.emitNoteCreated(mockRequest, {
      noteId: 'n1',
      createdBy: 'user',
      documentId: 'doc',
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining(NoteCreatedTriggerId));
  });
});
