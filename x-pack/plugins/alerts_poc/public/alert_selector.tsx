/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import React, { Component, Fragment } from 'react';
import { EuiForm, EuiFormRow, EuiSelect, EuiFieldText, EuiRange } from '@elastic/eui';

interface Props {
  setStepState: (state: any) => void;
  getStepState: () => any;
}

export class AlertSelector extends Component<Props, void> {
  onAlertChange(e: any) {
    const params: any = {};
    const newAlertId = e.target.value;
    if (newAlertId === 'fleet-cpu-check') {
      params.warningThreshold = 50;
      params.severeThreshold = 80;
    }
    this.props.setStepState({
      params,
      selectedAlertId: e.target.value,
    });
  }
  onIntervalChange(e: any) {
    this.props.setStepState({ interval: e.target.value });
  }
  onThrottleChange(e: any) {
    this.props.setStepState({ throttle: e.target.value });
  }
  onWarningThresholdChange(e: any) {
    const stepState = this.props.getStepState();
    this.props.setStepState({
      params: {
        ...stepState.params,
        warningThreshold: Number(e.target.value),
      },
    });
  }
  onSevereThresholdChange(e: any) {
    const stepState = this.props.getStepState();
    this.props.setStepState({
      params: {
        ...stepState.params,
        severeThreshold: Number(e.target.value),
      },
    });
  }
  render() {
    const stepState = this.props.getStepState();
    return (
      <Fragment>
        <EuiForm>
          <EuiFormRow label="Please select an alert">
            <EuiSelect
              hasNoInitialSelection
              value={stepState.selectedAlertId}
              options={stepState.alerts.map((alert: any) => ({
                text: alert.title,
                value: alert.id,
              }))}
              onChange={this.onAlertChange.bind(this)}
            />
          </EuiFormRow>
          <EuiFormRow label="Interval">
            <EuiFieldText
              name="interval"
              value={stepState.interval}
              onChange={this.onIntervalChange.bind(this)}
            />
          </EuiFormRow>
          <EuiFormRow label="Throttle">
            <EuiFieldText
              name="throttle"
              value={stepState.throttle}
              onChange={this.onThrottleChange.bind(this)}
            />
          </EuiFormRow>
          {stepState.selectedAlertId === 'fleet-cpu-check' && (
            <Fragment>
              <EuiFormRow label="Warning">
                <EuiRange
                  min={0}
                  max={100}
                  name="warningThreshold"
                  id="warningThreshold"
                  value={stepState.params.warningThreshold}
                  onChange={this.onWarningThresholdChange.bind(this)}
                  step={1}
                  showLabels
                  showValue
                />
              </EuiFormRow>
              <EuiFormRow label="Severe">
                <EuiRange
                  min={0}
                  max={100}
                  name="severeThreshold"
                  id="severeThreshold"
                  value={stepState.params.severeThreshold}
                  onChange={this.onSevereThresholdChange.bind(this)}
                  step={1}
                  showLabels
                  showValue
                />
              </EuiFormRow>
            </Fragment>
          )}
        </EuiForm>
      </Fragment>
    );
  }
}
