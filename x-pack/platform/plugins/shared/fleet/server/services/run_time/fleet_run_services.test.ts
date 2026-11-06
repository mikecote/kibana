/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { BehaviorSubject } from 'rxjs';
import { elasticsearchServiceMock } from '@kbn/core-elasticsearch-server-mocks';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { savedObjectsServiceMock } from '@kbn/core-saved-objects-server-mocks';
import { SPACES_EXTENSION_ID } from '@kbn/core-saved-objects-server';
import { encryptedSavedObjectsMock } from '@kbn/encrypted-saved-objects-plugin/server/mocks';
import { securityMock } from '@kbn/security-plugin/server/mocks';
import type { ILicense } from '@kbn/licensing-types';

import type { FleetConfigType } from '../../../common/types';
import { FleetActionsClient } from '../actions';
import { agentPolicyService } from '../agent_policy';
import { appContextService } from '../app_context';
import { licenseService } from '../license';
import { packagePolicyService } from '../package_policy';
import { MessageSigningService } from '../security/message_signing_service';

import { createFleetRunServices, startFleetRunAppContext } from './fleet_run_services';
import { getFleetRunEncryptedSavedObjectTypes, getFleetRunSavedObjectTypes } from './saved_objects';

describe('Fleet run services', () => {
  const setup = () => {
    const elasticsearch = elasticsearchServiceMock.createStart();
    const savedObjects = savedObjectsServiceMock.createStartContract();
    const encryptedSavedObjects = encryptedSavedObjectsMock.createStart();
    const loggerFactory = loggingSystemMock.create();
    // Every type is registered, unless a test says otherwise
    savedObjects.getTypeRegistry().getType = jest.fn().mockReturnValue({});
    return { elasticsearch, savedObjects, encryptedSavedObjects, loggerFactory };
  };

  describe('createFleetRunServices', () => {
    it('builds the services from the dependencies it is given', () => {
      const { elasticsearch, savedObjects, encryptedSavedObjects, loggerFactory } = setup();

      const services = createFleetRunServices({
        elasticsearch: elasticsearch.client,
        savedObjects,
        encryptedSavedObjects,
        loggerFactory,
      });

      expect(savedObjects.getUnsafeInternalClient).toHaveBeenCalledWith({
        excludedExtensions: [SPACES_EXTENSION_ID],
      });
      expect(encryptedSavedObjects.getClient).toHaveBeenCalledWith({
        includedHiddenTypes: ['fleet-message-signing-keys'],
      });
      expect(services.messageSigningService).toBeInstanceOf(MessageSigningService);
      expect(services.agentPolicyService).toBe(agentPolicyService);
      expect(services.packagePolicyService).toBe(packagePolicyService);
      expect(services.agentService.asInternalUser).toBeDefined();
      expect(services.packageService.asInternalUser).toBeDefined();
      expect(typeof services.runWithCache).toBe('function');
      expect(services.createFleetActionsClient('endpoint')).toBeInstanceOf(FleetActionsClient);
    });

    it('does not read the app context when it builds', () => {
      const { elasticsearch, savedObjects, encryptedSavedObjects, loggerFactory } = setup();
      const spy = jest.spyOn(appContextService, 'getSavedObjects');

      createFleetRunServices({
        elasticsearch: elasticsearch.client,
        savedObjects,
        encryptedSavedObjects,
        loggerFactory,
      });

      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe('startFleetRunAppContext', () => {
    const config = {
      enabled: true,
      agents: { enabled: true, elasticsearch: {} },
      enableExperimental: [],
    } as unknown as FleetConfigType;

    it('starts the app context with what the services read', async () => {
      const { elasticsearch, savedObjects, encryptedSavedObjects, loggerFactory } = setup();
      const security = securityMock.createSetup();
      const license$ = new BehaviorSubject({
        isAvailable: true,
        isActive: true,
        hasAtLeast: () => true,
        getFeature: () => ({ isAvailable: true, isEnabled: true }),
        type: 'enterprise',
      } as unknown as ILicense);

      await startFleetRunAppContext({
        elasticsearch: elasticsearch.client,
        savedObjects,
        encryptedSavedObjects: { ...encryptedSavedObjects, canEncrypt: true },
        loggerFactory,
        config,
        license$,
        audit: security.audit,
        kibanaVersion: '9.9.0',
        kibanaBranch: 'main',
        kibanaInstanceId: 'uuid',
        isProductionMode: false,
      });

      expect(appContextService.getInternalUserESClient()).toBe(elasticsearch.client.asInternalUser);
      expect(appContextService.getSavedObjects()).toBe(savedObjects);
      expect(appContextService.getConfig()).toEqual(config);
      expect(appContextService.getExperimentalFeatures()).toBeDefined();
      expect(appContextService.getEncryptedSavedObjectsSetup()?.canEncrypt).toBe(true);
      expect(appContextService.getSecuritySetup().audit).toBe(security.audit);
      expect(appContextService.getKibanaVersion()).toBe('9.9.0');
      expect(licenseService.isEnterprise()).toBe(true);

      // The hidden types Fleet's internal clients ask for, of those registered where it runs
      appContextService.getInternalUserSOClient();
      expect(savedObjects.getUnsafeInternalClient).toHaveBeenLastCalledWith({
        includedHiddenTypes: ['fleet-uninstall-tokens', 'alerting_rule_template', 'slo_template'],
      });
    });

    it('writes a Fleet action with the services, with the audit of the host', async () => {
      const { elasticsearch, savedObjects, encryptedSavedObjects, loggerFactory } = setup();
      const security = securityMock.createSetup();
      const deps = {
        elasticsearch: elasticsearch.client,
        savedObjects,
        encryptedSavedObjects: { ...encryptedSavedObjects, canEncrypt: true },
        loggerFactory,
      };
      await startFleetRunAppContext({
        ...deps,
        config,
        license$: new BehaviorSubject({} as ILicense),
        audit: security.audit,
        kibanaVersion: '9.9.0',
        kibanaBranch: 'main',
        kibanaInstanceId: 'uuid',
        isProductionMode: false,
      });

      await createFleetRunServices(deps)
        .createFleetActionsClient('endpoint')
        .create({
          action_id: 'action-1',
          agents: ['agent-1'],
          type: 'INPUT_ACTION',
          input_type: 'endpoint',
          '@timestamp': '2025-01-01T00:00:00.000Z',
          expiration: '2025-01-02T00:00:00.000Z',
          user_id: 'elastic',
          data: {},
        });

      expect(elasticsearch.client.asInternalUser.create).toHaveBeenCalledWith(
        expect.objectContaining({ index: '.fleet-actions' }),
        { meta: true }
      );
      expect(security.audit.withoutRequest.log).toHaveBeenCalled();
    });

    it('asks only for the hidden saved object types that are registered', async () => {
      const { elasticsearch, savedObjects, encryptedSavedObjects, loggerFactory } = setup();
      savedObjects.getTypeRegistry().getType = jest
        .fn()
        .mockImplementation((type: string) => (type === 'fleet-uninstall-tokens' ? {} : undefined));

      await startFleetRunAppContext({
        elasticsearch: elasticsearch.client,
        savedObjects,
        encryptedSavedObjects: { ...encryptedSavedObjects, canEncrypt: true },
        loggerFactory,
        config,
        license$: new BehaviorSubject({} as ILicense),
        audit: securityMock.createSetup().audit,
        kibanaVersion: '9.9.0',
        kibanaBranch: 'main',
        kibanaInstanceId: 'uuid',
        isProductionMode: false,
      });
      appContextService.getInternalUserSOClient();

      expect(savedObjects.getUnsafeInternalClient).toHaveBeenLastCalledWith({
        includedHiddenTypes: ['fleet-uninstall-tokens'],
      });
    });

    it('leaves what only Kibana has unset, so reading it fails clearly', async () => {
      const { elasticsearch, savedObjects, encryptedSavedObjects, loggerFactory } = setup();

      await startFleetRunAppContext({
        elasticsearch: elasticsearch.client,
        savedObjects,
        encryptedSavedObjects: { ...encryptedSavedObjects, canEncrypt: true },
        loggerFactory,
        config,
        license$: new BehaviorSubject({} as ILicense),
        audit: securityMock.createSetup().audit,
        kibanaVersion: '9.9.0',
        kibanaBranch: 'main',
        kibanaInstanceId: 'uuid',
        isProductionMode: false,
      });

      expect(() => appContextService.getData()).toThrow('Data start service not set.');
      expect(() => appContextService.getHttpSetup()).toThrow('HttpServiceSetup not set.');
      expect(appContextService.getTaskManagerStart()).toBeUndefined();
    });
  });

  describe('saved object registrations', () => {
    it('lists the Fleet types the services read, as Kibana registers them', () => {
      const names = getFleetRunSavedObjectTypes().map(({ name }) => name);

      expect(names).toEqual(
        expect.arrayContaining([
          'ingest-agent-policies',
          'fleet-agent-policies',
          'ingest-package-policies',
          'fleet-package-policies',
          'epm-packages',
          'ingest_manager_settings',
          'fleet-message-signing-keys',
          'fleet-uninstall-tokens',
        ])
      );
    });

    it('lists the encrypted saved objects Fleet registers', () => {
      const types = getFleetRunEncryptedSavedObjectTypes().map(({ type }) => type);

      expect(types).toEqual(
        expect.arrayContaining(['fleet-message-signing-keys', 'fleet-uninstall-tokens'])
      );
    });
  });
});
