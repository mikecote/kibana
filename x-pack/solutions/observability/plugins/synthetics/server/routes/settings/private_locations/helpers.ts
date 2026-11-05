/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import type { SavedObject, SavedObjectsFindResult } from '@kbn/core/server';
import { i18n } from '@kbn/i18n';
import { formatSecrets, normalizeSecrets } from '../../../synthetics_service/utils';
import type {
  SyntheticsMonitor,
  SyntheticsMonitorWithSecretsAttributes,
  SyntheticsPrivateLocations,
} from '../../../../common/runtime_types';
import type { MonitorConfigUpdate } from '../../monitor_cruds/bulk_cruds/edit_monitor_bulk';
import { syncEditedMonitorBulk } from '../../monitor_cruds/bulk_cruds/edit_monitor_bulk';
import type { RouteContext } from '../../types';

export {
  toClientContract,
  allLocationsToClientContract,
  toSavedObjectContract,
} from './location_contracts';

// Label edits must rewrite this location's monitors: the label is stored on
// each monitor's locations array.
export const updatePrivateLocationMonitors = async ({
  locationId,
  newLocationLabel,
  allPrivateLocations,
  routeContext,
  monitorsInLocation,
}: {
  locationId: string;
  newLocationLabel: string;
  allPrivateLocations: SyntheticsPrivateLocations;
  routeContext: RouteContext;
  monitorsInLocation: Array<SavedObjectsFindResult<SyntheticsMonitorWithSecretsAttributes>>;
}) => {
  const updatedMonitorsPerSpace = monitorsInLocation.reduce<Record<string, MonitorConfigUpdate[]>>(
    (acc, m) => {
      const decryptedMonitorsWithNormalizedSecrets: SavedObject<SyntheticsMonitor> =
        normalizeSecrets(m);
      const normalizedMonitor = decryptedMonitorsWithNormalizedSecrets.attributes;
      const newLocations = m.attributes.locations.map((l) =>
        l.id !== locationId ? l : { ...l, label: newLocationLabel }
      );
      const monitorWithRevision = formatSecrets({ ...normalizedMonitor, locations: newLocations });
      const monitorToUpdate: MonitorConfigUpdate = {
        normalizedMonitor,
        decryptedPreviousMonitor: m,
        monitorWithRevision,
      };

      const spaceId = m.namespaces?.[0] || 'default'; // Default to 'default' if no namespace is found
      return {
        ...acc,
        [spaceId]: [...(acc[spaceId] || []), monitorToUpdate],
      };
    },
    {}
  );

  const promises = Object.keys(updatedMonitorsPerSpace).map((spaceId) => [
    syncEditedMonitorBulk({
      monitorsToUpdate: updatedMonitorsPerSpace[spaceId],
      privateLocations: allPrivateLocations,
      routeContext,
      spaceId,
    }),
  ]);

  const results = await Promise.all(promises.flat());
  if (
    results.some((result) => result?.failedConfigs && Object.keys(result.failedConfigs).length > 0)
  ) {
    throw new Error(
      i18n.translate('xpack.synthetics.editPrivateLocation.monitorRewriteFailed', {
        defaultMessage: 'Failed to update monitors for this private location.',
      })
    );
  }
  return results;
};
