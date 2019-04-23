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

export class WarningActionSelector extends Component<Props, void> {
  onActionChange(e: any) {
    const params: any = {};
    const alertSelectorState = this.props.getStepState(0);
    const alert = alertSelectorState.alerts.find(
      (obj: any) => obj.id === alertSelectorState.selectedAlertId
    );
    const newActionId = e.target.value;
    if (newActionId === 'console-log') {
      params.message = (alert && alert.defaultActionParams.message) || '';
    }
    this.props.setStepState({
      params,
      selectedActionId: newActionId,
    });
  }
  onMessageChange(e: any) {
    const stepState = this.props.getStepState();
    this.props.setStepState({
      params: {
        ...stepState.params,
        message: e.target.value,
      },
    });
  }
  render() {
    const stepState = this.props.getStepState();
    return (
      <Fragment>
        <EuiForm>
          <EuiFormRow label="Please select a warning action">
            <EuiSelect
              hasNoInitialSelection
              value={stepState.selectedActionId}
              options={stepState.actions.map((action: any) => ({
                text: action.description,
                value: action.id,
              }))}
              onChange={this.onActionChange.bind(this)}
            />
          </EuiFormRow>
          {stepState.selectedActionId === 'console-log' && (
            <EuiFormRow label="Message">
              <EuiFieldText
                name="message"
                value={stepState.params.message}
                onChange={this.onMessageChange.bind(this)}
              />
            </EuiFormRow>
          )}
        </EuiForm>
      </Fragment>
    );
  }
}
