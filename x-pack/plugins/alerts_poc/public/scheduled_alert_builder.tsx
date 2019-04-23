/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import {
  EuiModal,
  EuiModalHeader,
  EuiModalBody,
  EuiModalFooter,
  EuiModalHeaderTitle,
  EuiButtonEmpty,
  EuiOverlayMask,
  EuiButton,
} from '@elastic/eui';
import { kfetch } from 'ui/kfetch';
import React, { Component, Fragment } from 'react';
import { ActionSelector } from './action_selector';
import { AlertSelector } from './alert_selector';
import { WarningActionSelector } from './warning_action_selector';
import { SevereActionSelector } from './severe_action_selector';
import { CreateAction } from './create_action';

interface Props {
  onClose: () => void;
}

interface State {
  step: number;
  steps: {
    [step: number]: {
      enabled: boolean;
      Component: any;
      state: any;
    };
  };
}

export class ScheduledAlertBuilder extends Component<Props, State> {
  constructor(props: Props) {
    super(props);

    this.state = {
      step: 0,
      steps: {
        0: {
          enabled: true,
          Component: AlertSelector,
          state: {
            selectedAlertId: undefined,
            interval: '10000',
            throttle: undefined,
            params: {},
            alerts: [
              {
                id: 'fleet-cpu-check',
                desc: 'Check CPU usage above threshold',
                title: 'Check CPU usage',
                defaultActionParams: {
                  subject: '[warning] High CPU usage',
                  body: 'The CPU usage is a little high: {cpuUsage}%',
                  message: 'The CPU usage is a little high: {cpuUsage}%',
                },
              },
            ],
          },
        },
        1: {
          enabled: true,
          Component: ActionSelector,
          state: {
            advancedConfiguration: false,
            selectedActionId: undefined,
            params: {},
            actions: [
              {
                id: 'new',
                description: 'Create new action...',
              },
              {
                id: 'console-log',
                description: 'Send message to the console',
              },
              {
                id: 'turn-on-alarm-light',
                description: 'Turn on a physical alarm light',
              },
            ],
          },
        },
        2: {
          enabled: false,
          Component: CreateAction,
          state: {
            selectedConnectorId: undefined,
            connectors: [
              {
                id: 'smtp',
                description: 'SMTP',
              },
            ],
            params: {},
          },
        },
        3: {
          enabled: false,
          Component: WarningActionSelector,
          state: {
            selectedActionId: undefined,
            params: {},
            actions: [
              {
                id: 'console-log',
                description: 'Send message to the console',
              },
              {
                id: 'turn-on-alarm-light',
                description: 'Turn on a physical alarm light',
              },
            ],
          },
        },
        4: {
          enabled: false,
          Component: SevereActionSelector,
          state: {
            selectedActionId: undefined,
            params: {},
            actions: [
              {
                id: 'console-log',
                description: 'Send message to the console',
              },
              {
                id: 'turn-on-alarm-light',
                description: 'Turn on a physical alarm light',
              },
            ],
          },
        },
      },
    };
  }
  hasNextStep(step: number) {
    let hasNextStep = false;
    let stepPointer = step + 1;
    while (this.state.steps[stepPointer]) {
      if (this.state.steps[stepPointer].enabled) {
        hasNextStep = true;
      }
      stepPointer++;
    }
    return hasNextStep;
  }
  closeModal() {
    this.props.onClose();
  }
  nextStep() {
    this.setState(state => ({
      step: state.step + 1,
    }));
  }
  previousStep() {
    this.setState(state => ({
      step: state.step - 1,
    }));
  }
  async save() {
    const { state } = this;
    const response = await kfetch({
      method: 'POST',
      pathname: '/api/schedule-action',
      body: JSON.stringify({
        id: state.steps[0].state.selectedAlertId,
        interval: state.steps[0].state.interval,
        throttle: state.steps[0].state.throttle,
        actionGroupsPriority: ['severe', 'warning', 'default'],
        actionGroups: {
          default: state.steps[1].state.selectedActionId
            ? [{ id: state.steps[1].state.selectedActionId, params: state.steps[1].state.params }]
            : [],
          warning: state.steps[3].state.selectedActionId
            ? [{ id: state.steps[3].state.selectedActionId, params: state.steps[3].state.params }]
            : [],
          severe: state.steps[4].state.selectedActionId
            ? [{ id: state.steps[4].state.selectedActionId, params: state.steps[4].state.params }]
            : [],
        },
        checkParams: state.steps[0].state.params,
      }),
    });
    if (response.success === true) {
      this.closeModal();
    }
  }
  setStepState(state: any) {
    const stateChanges = {
      steps: {
        ...this.state.steps,
        [this.state.step]: {
          ...this.state.steps[this.state.step],
          state: {
            ...this.state.steps[this.state.step].state,
            ...state,
          },
        },
      },
    };
    if (this.state.step === 1) {
      stateChanges.steps[3].enabled = state.advancedConfiguration;
      stateChanges.steps[4].enabled = state.advancedConfiguration;
      stateChanges.steps[2].enabled = state.selectedActionId === 'new';
    }
    this.setState(stateChanges);
  }
  getStepState(step?: number) {
    const selectedStep = typeof step === 'number' ? step : this.state.step;
    return this.state.steps[selectedStep].state;
  }
  render() {
    const { Component: BodyComponent } = this.state.steps[this.state.step];
    return (
      <Fragment>
        <EuiOverlayMask>
          <EuiModal onClose={this.closeModal.bind(this)}>
            <EuiModalHeader>
              <EuiModalHeaderTitle>Schedule an alert</EuiModalHeaderTitle>
            </EuiModalHeader>
            <EuiModalBody>
              <BodyComponent
                setStepState={this.setStepState.bind(this)}
                getStepState={this.getStepState.bind(this)}
              />
            </EuiModalBody>
            <EuiModalFooter>
              <EuiButtonEmpty onClick={this.closeModal.bind(this)}>Cancel</EuiButtonEmpty>
              {this.state.step > 0 && (
                <EuiButton color="primary" onClick={this.previousStep.bind(this)}>
                  Previous
                </EuiButton>
              )}
              <EuiButton
                color="primary"
                fill={true}
                onClick={
                  this.hasNextStep(this.state.step)
                    ? this.nextStep.bind(this)
                    : this.save.bind(this)
                }
              >
                {this.hasNextStep(this.state.step) ? 'Next' : 'Save'}
              </EuiButton>
            </EuiModalFooter>
          </EuiModal>
        </EuiOverlayMask>
      </Fragment>
    );
  }
}
