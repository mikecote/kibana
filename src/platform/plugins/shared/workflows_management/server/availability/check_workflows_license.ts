/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { i18n } from '@kbn/i18n';
import type { CheckLicense } from '@kbn/licensing-plugin/server';
import { isLicenseValid, REQUIRED_LICENSE_TYPE } from './is_license_valid';

export const checkWorkflowsLicense: CheckLicense = (license) => {
  if (!license.isAvailable) {
    return {
      valid: false,
      message: i18n.translate('workflows.checkLicense.unavailable', {
        defaultMessage: 'License information is not available.',
      }),
    };
  }
  if (!license.isActive) {
    return {
      valid: false,
      message: i18n.translate('workflows.checkLicense.inactive', {
        defaultMessage: 'License is expired. Please renew your license.',
      }),
    };
  }

  if (!isLicenseValid(license)) {
    return {
      valid: false,
      message: i18n.translate('workflows.checkLicense.invalidLicense', {
        defaultMessage:
          'Your {licenseType} license does not support Workflows. Please upgrade to an {requiredLicenseType} license.',
        values: { licenseType: license.type, requiredLicenseType: REQUIRED_LICENSE_TYPE },
      }),
    };
  }

  return { valid: true, message: null };
};
