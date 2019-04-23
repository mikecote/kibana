/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import React, { Component, Fragment } from 'react';
import { EuiForm, EuiFormRow, EuiSelect, EuiFieldText } from '@elastic/eui';

interface Props {
  setStepState: (state: any) => void;
  getStepState: (step?: number) => any;
}

export class CreateAction extends Component<Props, void> {
  onConnectorChange(e: any) {
    this.props.setStepState({
      selectedConnectorId: e.target.value,
    });
  }
  onProviderChange(e: any) {
    const stepState = this.props.getStepState();
    this.props.setStepState({
      params: {
        ...stepState.params,
        providerId: e.target.value,
      },
    });
  }
  onUsernameChange(e: any) {
    const stepState = this.props.getStepState();
    this.props.setStepState({
      params: {
        ...stepState.params,
        username: e.target.value,
      },
    });
  }
  onPasswordChange(e: any) {
    const stepState = this.props.getStepState();
    this.props.setStepState({
      params: {
        ...stepState.params,
        password: e.target.value,
      },
    });
  }
  render() {
    const stepState = this.props.getStepState();
    return (
      <Fragment>
        <EuiForm>
          <EuiFormRow label="Please select a connector">
            <EuiSelect
              hasNoInitialSelection
              value={stepState.selectedConnectorId}
              options={stepState.connectors.map((connector: any) => ({
                text: connector.description,
                value: connector.id,
              }))}
              onChange={this.onConnectorChange.bind(this)}
            />
          </EuiFormRow>
          {stepState.selectedConnectorId === 'smtp' && (
            <EuiFormRow label="Provider">
              <EuiSelect
                hasNoInitialSelection
                value={stepState.params.providerId}
                options={[
                  {
                    text: 'GMail',
                    value: 'gmail',
                  },
                ]}
                onChange={this.onProviderChange.bind(this)}
              />
            </EuiFormRow>
          )}
          {stepState.params.providerId === 'gmail' && (
            <Fragment>
              <EuiFormRow label="Username">
                <EuiFieldText
                  value={stepState.params.username}
                  onChange={this.onUsernameChange.bind(this)}
                />
              </EuiFormRow>
              <EuiFormRow label="Password">
                <EuiFieldText
                  type="password"
                  value={stepState.params.password}
                  onChange={this.onPasswordChange.bind(this)}
                />
              </EuiFormRow>
            </Fragment>
          )}
        </EuiForm>
      </Fragment>
    );
  }
}
